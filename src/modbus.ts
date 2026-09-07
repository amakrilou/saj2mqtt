import { IServiceVector, ServerTCP } from "modbus-serial";
import {
  MODBUS_STALE_AFTER,
  MODBUS_TCP_HOST,
  MODBUS_TCP_PORT,
  MODBUS_UNIT_ID,
} from "./config";
import { SAJField, SAJState } from "./types";

/**
 * Serves the inverter's latest reading as a Chint DTSU666-compatible Modbus TCP
 * slave, so the E-MVP edge server can poll it as a power meter.
 *
 * The SAJ's eSolar module speaks HTTP only -- it has no Modbus at all (port 502
 * is closed on the inverter) -- and the edge has no SunSpec or vendor inverter
 * driver: DTSU666 is the only three-phase register vocabulary it speaks. So the
 * PV circuit is presented as a *production meter*, which is the same convention
 * the ESP32 simulator uses for its inverter slave:
 *
 *   - active power is generation, positive, split evenly across the phases
 *   - import energy is cumulative lifetime production
 *   - export energy is 0 -- an inverter does not import
 *   - reactive power is 0 and power factor is 1 (inverters run near unity)
 *
 * Register layout must match edge-server internal/modbus/dtsu666.go: every
 * value is an IEEE 754 float32 in two consecutive registers, big-endian ABCD
 * (high word first), read with FC 0x03. Writes are not served, so FC 0x10
 * returns an illegal-function exception, as on a real inverter.
 */

// Register addresses, all float32 pairs. Energy lives in the 0x101E block on
// the real Chint part, not the 0x4000 block some clones use.
const DTSU666 = {
  IMPORT_ENERGY: 0x101e,
  EXPORT_ENERGY: 0x1028,
  VOLTAGE_L1: 0x2006,
  VOLTAGE_L2: 0x2008,
  VOLTAGE_L3: 0x200a,
  CURRENT_L1: 0x200c,
  CURRENT_L2: 0x200e,
  CURRENT_L3: 0x2010,
  POWER_TOTAL: 0x2012,
  POWER_L1: 0x2014,
  POWER_L2: 0x2016,
  POWER_L3: 0x2018,
  REACTIVE_TOTAL: 0x201a,
  REACTIVE_L1: 0x201c,
  REACTIVE_L2: 0x201e,
  REACTIVE_L3: 0x2020,
  APPARENT_TOTAL: 0x2022,
  APPARENT_L1: 0x2024,
  APPARENT_L2: 0x2026,
  APPARENT_L3: 0x2028,
  PF_TOTAL: 0x202a,
  PF_L1: 0x202c,
  PF_L2: 0x202e,
  PF_L3: 0x2030,
  FREQUENCY: 0x2044,
} as const;

// status.php returns raw scaled integers; these divisors turn them into the
// engineering units the DTSU666 registers carry.
const SCALE = {
  VOLTAGE: 10, // 2321 -> 232.1 V
  CURRENT: 100, // 374 -> 3.74 A
  FREQUENCY: 100, // 4998 -> 49.98 Hz
  ENERGY: 100, // 2211453 -> 22114.53 kWh
} as const;

/** Splits a float32 into its two 16-bit registers, high word first (ABCD). */
function float32Words(value: number): [number, number] {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(value, 0);
  return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

/**
 * Encodes a reading into an address -> register-value map.
 *
 * Returns undefined when the reading is not usable, which keeps the previous
 * good snapshot in place instead of serving zeros: the edge rejects NaN outright
 * and aborts the whole meter parse, and a silent 0 W would report a healthy
 * inverter producing nothing rather than a fault.
 */
export function buildRegisters(state: SAJState): Map<number, number> | undefined {
  if (state.status !== "Online") {
    return undefined;
  }

  let complete = true;
  const scaled = (field: SAJField, divisor: number): number => {
    const raw = Number(state[field]);
    if (!Number.isFinite(raw)) {
      complete = false;
      return 0;
    }
    return raw / divisor;
  };

  const voltage = [
    scaled(SAJField.LINE1_VOLTAGE, SCALE.VOLTAGE),
    scaled(SAJField.LINE2_VOLTAGE, SCALE.VOLTAGE),
    scaled(SAJField.LINE3_VOLTAGE, SCALE.VOLTAGE),
  ];
  const current = [
    scaled(SAJField.LINE1_CURRENT, SCALE.CURRENT),
    scaled(SAJField.LINE2_CURRENT, SCALE.CURRENT),
    scaled(SAJField.LINE3_CURRENT, SCALE.CURRENT),
  ];
  // grid_connected_power is already in watts.
  const powerW = scaled(SAJField.GRID_CONNECTED_POWER, 1);
  const frequencyHz = scaled(SAJField.GRID_CONNECTED_FREQUENCY, SCALE.FREQUENCY);
  const producedKWh = scaled(SAJField.TOTAL_GENERATED, SCALE.ENERGY);

  if (!complete) {
    return undefined;
  }

  // Per-phase power is an even split rather than V*I: the measured phase
  // products sum to more than the reported AC total (power factor is not
  // actually unity), so splitting Pt keeps the phases consistent with it.
  const phasePowerW = powerW / 3;

  const registers = new Map<number, number>();
  const put = (address: number, value: number) => {
    const [high, low] = float32Words(value);
    registers.set(address, high);
    registers.set(address + 1, low);
  };

  put(DTSU666.VOLTAGE_L1, voltage[0]);
  put(DTSU666.VOLTAGE_L2, voltage[1]);
  put(DTSU666.VOLTAGE_L3, voltage[2]);
  put(DTSU666.CURRENT_L1, current[0]);
  put(DTSU666.CURRENT_L2, current[1]);
  put(DTSU666.CURRENT_L3, current[2]);

  put(DTSU666.POWER_TOTAL, powerW);
  put(DTSU666.POWER_L1, phasePowerW);
  put(DTSU666.POWER_L2, phasePowerW);
  put(DTSU666.POWER_L3, phasePowerW);

  put(DTSU666.REACTIVE_TOTAL, 0);
  put(DTSU666.REACTIVE_L1, 0);
  put(DTSU666.REACTIVE_L2, 0);
  put(DTSU666.REACTIVE_L3, 0);

  // Power factor is 1, so apparent power equals active power.
  put(DTSU666.APPARENT_TOTAL, powerW);
  put(DTSU666.APPARENT_L1, phasePowerW);
  put(DTSU666.APPARENT_L2, phasePowerW);
  put(DTSU666.APPARENT_L3, phasePowerW);

  put(DTSU666.PF_TOTAL, 1);
  put(DTSU666.PF_L1, 1);
  put(DTSU666.PF_L2, 1);
  put(DTSU666.PF_L3, 1);

  put(DTSU666.FREQUENCY, frequencyHz);

  put(DTSU666.IMPORT_ENERGY, producedKWh);
  put(DTSU666.EXPORT_ENERGY, 0);

  return registers;
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
 * Reads a register block. Unmapped addresses inside a block read as 0 -- the
 * edge coalesces its 25 registers into three ranges (0x101E+12, 0x2006+44,
 * 0x2044+2) and errors if any single one is missing, so every address in those
 * ranges has to answer.
 *
 * Throws when there is no fresh reading, which the server turns into Modbus
 * exception 0x04. That is deliberate: it drives the edge's existing
 * meter_communication_failure path instead of reporting a false 0 W.
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
    `Modbus TCP (DTSU666-compatible) listening on ${MODBUS_TCP_HOST}:${MODBUS_TCP_PORT}, unit ${MODBUS_UNIT_ID}`,
  );
  return server;
}
