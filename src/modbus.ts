import { IServiceVector, ServerTCP } from "modbus-serial";
import {
  MODBUS_BASE_REGISTER,
  MODBUS_STALE_AFTER,
  MODBUS_TCP_HOST,
  MODBUS_TCP_PORT,
  MODBUS_UNIT_ID,
} from "./config";
import { SAJField, SAJState } from "./types";

/**
 * Serves the inverter's latest reading as a SunSpec Modbus TCP device, so the
 * E-MVP edge can poll it as a *real solar inverter* rather than a meter.
 *
 * The SAJ's eSolar module speaks HTTP only (status.php); it has no Modbus. This
 * synthesises the standard SunSpec register map from that HTTP data:
 *
 *   - "SunS" identity marker at the base register (default 40000)
 *   - Model 1  (Common)   -- manufacturer / model / version / serial
 *   - Model 64001 (private) -- the quantities the SAJ reports but model 103 has
 *                             no points for: PV1/PV2 and DC bus voltage, today's
 *                             energy, total running hours, CO2 reduction. Ours,
 *                             so it only exists on a saj2mqtt-fronted inverter.
 *   - Model 103 (three-phase inverter) -- AC power/current/voltage, frequency,
 *                             lifetime AC energy, DC power/voltage/current, temp,
 *                             operating state. int16 values + int16 scale factors.
 *   - End marker (model 0xFFFF, length 0)
 *
 * SunSpec 1xx models are integer + scale factor: actual = value * 10^SF. The
 * SAJ's status.php raw values are already scaled (voltage x10, current x100,
 * frequency x100, energy x100 kWh), which maps cleanly onto SunSpec SFs.
 *
 * The edge's SunSpec driver reads holding registers from the base with FC 0x03,
 * verifies the marker, walks the model chain and decodes model 103. Writes are
 * not served, as on a real inverter.
 */

// ── SunSpec model 103 (three-phase inverter) register offsets, from the first
// data register of the block. int16/uint16 unless noted. See SunSpec Inverter
// Model 1xx. Only the points we populate are named; the rest read as 0.
const M103 = {
  A: 0, // AC total current
  AphA: 1,
  AphB: 2,
  AphC: 3,
  A_SF: 4,
  PhVphA: 8, // per-phase voltage (PPVph* line-line at 5..7 left 0)
  PhVphB: 9,
  PhVphC: 10,
  V_SF: 11,
  W: 12, // AC power
  W_SF: 13,
  Hz: 14,
  Hz_SF: 15,
  WH: 22, // AC lifetime energy, acc32 (22..23)
  WH_SF: 24,
  DCA: 25,
  DCA_SF: 26,
  DCV: 27,
  DCV_SF: 28,
  DCW: 29,
  DCW_SF: 30,
  TmpCab: 31,
  Tmp_SF: 35,
  St: 36, // operating state
} as const;
const M103_LEN = 50;
const M1_LEN = 66; // Common model fixed length

// ── Private model 64001 (SunSpec reserves >=64000 for vendors). Carries the
// six quantities status.php reports that model 103 cannot express. Same
// integer + scale-factor convention as the 1xx models, so the edge decodes it
// with the same helpers.
//
// It is placed BEFORE model 103 in the chain, which reads oddly but is what
// keeps the whole device inside a single FC03 read: appending it after 103
// would push 103's St point past the 125-register limit and cost the edge a
// second Modbus request every poll.
//
// ponytail: 14 data registers -- AT the ceiling, not approaching it. Model
// 103's St now lands on base+124, the last register of the edge's 125-register
// block. Any further point ahead of 103 forces either a second Modbus read on
// the edge or moving this model after 103.
const M64001 = {
  PV1V: 0, // PV string 1 voltage
  PV2V: 1, // PV string 2 voltage
  BusV: 2, // DC bus voltage
  V_SF: 3, // scale factor shared by the three voltages above
  TodayWh: 4, // energy generated today, acc32 (4..5), Wh
  RunHours: 6, // total running time, uint32 (6..7)
  CO2Kg: 8, // lifetime CO2 reduction, uint32 (8..9)
  Frac_SF: 10, // scale factor shared by RunHours and CO2Kg
  PV1A: 11, // PV string 1 current
  PV2A: 12, // PV string 2 current
  A_SF: 13, // scale factor shared by the two currents above
} as const;
const M64001_ID = 64001;
const M64001_LEN = 14;

// SunSpec operating state: 4 = MPPT (normally producing).
const ST_MPPT = 4;

// ── low-level register writers. The snapshot map is address -> uint16.
function put16(map: Map<number, number>, addr: number, value: number): void {
  map.set(addr, value & 0xffff);
}
/** Signed 16-bit (two's complement). */
function putI16(map: Map<number, number>, addr: number, value: number): void {
  put16(map, addr, Math.round(value) & 0xffff);
}
/** Unsigned 32-bit accumulator across two registers, high word first. */
function putAcc32(map: Map<number, number>, addr: number, value: number): void {
  const v = Math.max(0, Math.round(value)) >>> 0;
  put16(map, addr, (v >>> 16) & 0xffff);
  put16(map, addr + 1, v & 0xffff);
}
/** ASCII into `regs` registers, 2 chars/register, null-padded (SunSpec strings). */
function putString(
  map: Map<number, number>,
  addr: number,
  str: string,
  regs: number,
): void {
  const bytes = Buffer.alloc(regs * 2); // zero-filled
  Buffer.from(str, "ascii").copy(bytes, 0, 0, Math.min(str.length, regs * 2));
  for (let i = 0; i < regs; i++) put16(map, addr + i, bytes.readUInt16BE(i * 2));
}

/**
 * Encodes a reading into an absolute-address -> register map, laid out as a
 * SunSpec device starting at MODBUS_BASE_REGISTER.
 *
 * Returns undefined when the reading is not usable (inverter Offline or a
 * required AC field missing), which keeps the previous good snapshot in place
 * instead of serving zeros -- the edge rejects a fault and reports a comms
 * failure rather than a healthy inverter producing nothing.
 */
export function buildRegisters(state: SAJState): Map<number, number> | undefined {
  if (state.status !== "Online") return undefined;

  let complete = true;
  const num = (field: SAJField): number => {
    const raw = Number(state[field]);
    if (!Number.isFinite(raw)) {
      complete = false;
      return 0;
    }
    return raw;
  };
  // optional() never marks the reading incomplete -- DC/temp are enrichment.
  const optional = (field: SAJField): number => {
    const raw = Number(state[field]);
    return Number.isFinite(raw) ? raw : 0;
  };

  // status.php raw values (already scaled): voltage x10, current x100,
  // frequency x100, energy x100 (kWh), power in W.
  const vRaw = [
    num(SAJField.LINE1_VOLTAGE),
    num(SAJField.LINE2_VOLTAGE),
    num(SAJField.LINE3_VOLTAGE),
  ];
  const aRaw = [
    num(SAJField.LINE1_CURRENT),
    num(SAJField.LINE2_CURRENT),
    num(SAJField.LINE3_CURRENT),
  ];
  const powerW = num(SAJField.GRID_CONNECTED_POWER); // already watts
  const freqRaw = num(SAJField.GRID_CONNECTED_FREQUENCY); // x100
  const energyRaw = num(SAJField.TOTAL_GENERATED); // x100 kWh
  if (!complete) return undefined;

  // DC side (per-string), enrichment only. status raw: PV voltage x10, current x100.
  const pv = [
    [optional(SAJField.PV1_VOLTAGE), optional(SAJField.PV1_CURRENT)],
    [optional(SAJField.PV2_VOLTAGE), optional(SAJField.PV2_CURRENT)],
  ];
  const dcWatts = pv.reduce((sum, [v, i]) => sum + (v / 10) * (i / 100), 0);
  const dcvRaw = pv[0][0] || pv[1][0]; // representative string voltage (x10)
  const tempRaw = optional(SAJField.DEVICE_TEMPERATURE); // x10

  // Private-model values. optional(), not num(): the SAJ dropping one of these
  // must not discard an otherwise good AC reading.
  const pv1vRaw = optional(SAJField.PV1_VOLTAGE); // x10
  const pv2vRaw = optional(SAJField.PV2_VOLTAGE); // x10 -- legitimately 0 at night
  const busvRaw = optional(SAJField.BUS_VOLTAGE); // x10
  const todayRaw = optional(SAJField.TODAY_GENERATED); // x100 kWh
  const runHoursRaw = optional(SAJField.TOTAL_RUNNING_TIME); // x10 h
  const co2Raw = optional(SAJField.CO2_EMISSION_REDUCTION); // x10 kg

  const base = MODBUS_BASE_REGISTER;
  const map = new Map<number, number>();

  // Identity marker "SunS" = 0x53756E53.
  put16(map, base, 0x5375);
  put16(map, base + 1, 0x6e53);

  // ── Model 1 (Common). Header then fixed 66-register block.
  const m1 = base + 2;
  put16(map, m1, 1);
  put16(map, m1 + 1, M1_LEN);
  const m1Data = m1 + 2;
  putString(map, m1Data + 0, "SAJ", 16); // Mn manufacturer
  putString(map, m1Data + 16, "saj2mqtt", 16); // Md model
  putString(map, m1Data + 40, "1", 8); // Vr version (Opt[8] at 32..39 left blank)
  putString(map, m1Data + 48, "", 16); // SN serial (unknown from status.php)
  put16(map, m1Data + 64, MODBUS_UNIT_ID); // DA device address (65 = pad, left 0)

  // ── Model 64001 (private). Header then 14-register block.
  const m64001 = m1Data + M1_LEN; // = m1 + 2 + 66
  put16(map, m64001, M64001_ID);
  put16(map, m64001 + 1, M64001_LEN);
  const vd = m64001 + 2;
  const vAt = (off: number) => vd + off;

  // The three voltages are raw x10 -> SF -1.
  putI16(map, vAt(M64001.V_SF), -1);
  put16(map, vAt(M64001.PV1V), pv1vRaw);
  put16(map, vAt(M64001.PV2V), pv2vRaw);
  put16(map, vAt(M64001.BusV), busvRaw);

  // Today's energy: raw is x100 kWh; Wh = raw * 10. acc32, unscaled, matching
  // how model 103 reports the lifetime figure.
  putAcc32(map, vAt(M64001.TodayWh), todayRaw * 10);

  // Running hours and CO2 both overflow uint16 (190512, 173599 on a real
  // device), so both are uint32; both are raw x10 -> SF -1.
  putI16(map, vAt(M64001.Frac_SF), -1);
  putAcc32(map, vAt(M64001.RunHours), runHoursRaw);
  putAcc32(map, vAt(M64001.CO2Kg), co2Raw);

  // Per-string current, raw x100 -> SF -2, same convention as model 103's A_SF.
  // These are the values dcWatts is computed from above -- until now they were
  // folded into that aggregate and discarded, which left the edge unable to
  // derive per-string power. put16, not putI16: PV string current is never
  // negative. A string idle at night reads a true 0.
  putI16(map, vAt(M64001.A_SF), -2);
  put16(map, vAt(M64001.PV1A), pv[0][1]);
  put16(map, vAt(M64001.PV2A), pv[1][1]);

  // ── Model 103 (three-phase inverter). Header then 50-register block.
  const m103 = vd + M64001_LEN;
  put16(map, m103, 103);
  put16(map, m103 + 1, M103_LEN);
  const d = m103 + 2;
  const at = (off: number) => d + off;

  // AC current: raw is x100 -> SF -2.
  putI16(map, at(M103.A_SF), -2);
  putI16(map, at(M103.AphA), aRaw[0]);
  putI16(map, at(M103.AphB), aRaw[1]);
  putI16(map, at(M103.AphC), aRaw[2]);
  putI16(map, at(M103.A), aRaw[0] + aRaw[1] + aRaw[2]);

  // AC voltage: raw is x10 -> SF -1.
  putI16(map, at(M103.V_SF), -1);
  putI16(map, at(M103.PhVphA), vRaw[0]);
  putI16(map, at(M103.PhVphB), vRaw[1]);
  putI16(map, at(M103.PhVphC), vRaw[2]);

  // AC power: already watts -> SF 0. (4 kW inverter fits int16; larger models
  // would need W_SF>0. ponytail: SF 0 is fine here, revisit if W can exceed 32k.)
  putI16(map, at(M103.W_SF), 0);
  putI16(map, at(M103.W), powerW);

  // Frequency: raw x100 -> SF -2.
  putI16(map, at(M103.Hz_SF), -2);
  putI16(map, at(M103.Hz), freqRaw);

  // Lifetime AC energy: raw is x100 kWh; Wh = raw * 10. acc32, SF 0.
  putI16(map, at(M103.WH_SF), 0);
  putAcc32(map, at(M103.WH), energyRaw * 10);

  // DC: report aggregate DC power (accurate) with a representative voltage, and
  // a current derived to keep V*A consistent with W. SF: V x10 -> -1, A -> -2.
  putI16(map, at(M103.DCW_SF), 0);
  putI16(map, at(M103.DCW), dcWatts);
  putI16(map, at(M103.DCV_SF), -1);
  putI16(map, at(M103.DCV), dcvRaw);
  putI16(map, at(M103.DCA_SF), -2);
  putI16(map, at(M103.DCA), dcvRaw > 0 ? (dcWatts / (dcvRaw / 10)) * 100 : 0);

  // Cabinet temperature: raw x10 -> SF -1.
  putI16(map, at(M103.Tmp_SF), -1);
  putI16(map, at(M103.TmpCab), tempRaw);

  // Operating state: Online + serving => MPPT.
  put16(map, at(M103.St), ST_MPPT);

  // ── End marker.
  const end = d + M103_LEN;
  put16(map, end, 0xffff);
  put16(map, end + 1, 0);

  return map;
}

let snapshot: { registers: Map<number, number>; at: number } | undefined;

/**
 * Publishes a reading to the Modbus server. An unusable reading is ignored so
 * the last good one keeps being served until it goes stale.
 */
export function updateSnapshot(state: SAJState, now = Date.now()): boolean {
  const registers = buildRegisters(state);
  if (!registers) {
    return false;
  }
  snapshot = { registers, at: now };
  return true;
}

/** Exported for the self-check only. */
export function resetSnapshot(): void {
  snapshot = undefined;
}

/**
 * Reads a register block. Unmapped addresses inside the SunSpec map read as 0
 * (the reserved/unused SunSpec points), so a client scanning the whole device
 * gets a well-formed map.
 *
 * Throws when there is no fresh reading, which the server turns into a Modbus
 * exception. That drives the edge's communication-failure path instead of
 * reporting a false 0 W.
 */
function readBlock(address: number, length: number, now = Date.now()): number[] {
  if (!snapshot) {
    throw new Error("no SAJ reading yet");
  }
  const age = now - snapshot.at;
  if (age > MODBUS_STALE_AFTER) {
    throw new Error(`SAJ reading is stale (${age}ms old)`);
  }
  const values: number[] = [];
  for (let i = 0; i < length; i++) {
    values.push(snapshot.registers.get(address + i) ?? 0);
  }
  return values;
}

// getHoldingRegister covers single-register reads; modbus-serial only uses
// getMultipleHoldingRegisters when length > 1.
export const vector: IServiceVector = {
  getHoldingRegister: (addr: number) => readBlock(addr, 1)[0],
  getMultipleHoldingRegisters: (addr: number, length: number) =>
    readBlock(addr, length),
};

export function startModbusServer(): ServerTCP {
  const server = new ServerTCP(vector, {
    host: MODBUS_TCP_HOST,
    port: MODBUS_TCP_PORT,
    unitID: MODBUS_UNIT_ID,
  });

  // A dropped client socket must not take the process down; the edge reconnects
  // on its next poll.
  server.on("socketError", (err) => console.error(`Modbus socket error: ${err}`));
  server.on("serverError", (err) => console.error(`Modbus server error: ${err}`));

  console.log(
    `Modbus TCP (SunSpec) listening on ${MODBUS_TCP_HOST}:${MODBUS_TCP_PORT}, ` +
      `unit ${MODBUS_UNIT_ID}, base register ${MODBUS_BASE_REGISTER}`,
  );
  return server;
}
