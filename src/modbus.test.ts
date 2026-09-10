import assert from "node:assert/strict";
import ModbusRTU, { ServerTCP } from "modbus-serial";
import { buildRegisters, resetSnapshot, updateSnapshot, vector } from "./modbus";
import { MODBUS_BASE_REGISTER, MODBUS_UNIT_ID } from "./config";
import { formatPayload } from "./formatters/state";
import { SAJState } from "./types";

/**
 * Self-check for the SunSpec register encoding and the Modbus TCP server.
 *
 * Run with `npm test`. Plain asserts and a real socket -- the encoding
 * (int16 + scale factor + acc32 + model layout) and the client's block reads
 * are the parts that silently produce wrong numbers, so they are checked
 * against a real Modbus client rather than a mock.
 */

const TEST_PORT = 15502;
const BASE = MODBUS_BASE_REGISTER;

// A real status.php response, captured from the inverter.
const RAW_PAYLOAD =
  "3,2211453,190512,699,56,2797,951,0,0,65535,65535,65535,65535,65535,65535," +
  "65535,65535,65535,65535,65535,65535,65535,65535,2536,4998,2321,374,2251," +
  "384,2328,378,6267,474,173599,2";

const ONLINE: SAJState = {
  status: "Online",
  date: new Date().toISOString(),
  ...formatPayload(RAW_PAYLOAD),
};

// SunSpec device layout offsets from BASE.
const M1_HDR = BASE + 2; // Common model header
const M64001_HDR = BASE + 2 + 2 + 66; // after marker(2)+m1 hdr(2)+m1 data(66)
const V = M64001_HDR + 2; // private model data start
const M103_HDR = V + 11; // model 103 sits AFTER the private model
const D = M103_HDR + 2; // model 103 data start
// Private model 64001 point offsets within its data block.
const Q = {
  PV1V: 0,
  PV2V: 1,
  BusV: 2,
  V_SF: 3,
  TodayWh: 4,
  RunHours: 6,
  CO2Kg: 8,
  Frac_SF: 10,
} as const;
// The single FC03 read the edge issues: 125 registers reaches model 103's St
// point (BASE+121) with the private model spliced in ahead of it.
const EDGE_BLOCK = 125;
// Model 103 point offsets within the data block.
const P = {
  AphA: 1,
  A_SF: 4,
  PhVphA: 8,
  V_SF: 11,
  W: 12,
  W_SF: 13,
  Hz: 14,
  Hz_SF: 15,
  WH: 22,
  WH_SF: 24,
  St: 36,
} as const;

function i16(v: number): number {
  return v > 0x7fff ? v - 0x10000 : v;
}
function sf(value: number, scale: number): number {
  return i16(value) * Math.pow(10, i16(scale));
}
function acc32(hi: number, lo: number): number {
  return hi * 0x10000 + lo;
}
// acc32 value scaled by its (16-bit) scale factor -- must NOT narrow the 32-bit
// accumulator with i16.
function accSf(hi: number, lo: number, scale: number): number {
  return acc32(hi, lo) * Math.pow(10, i16(scale));
}
function close(value: number, expected: number, what: string) {
  assert.ok(
    Math.abs(value - expected) < 0.01,
    `${what}: expected ~${expected}, got ${value}`,
  );
}

function checkEncoding() {
  const r = buildRegisters(ONLINE);
  assert.ok(r, "a complete online reading must encode");
  const g = (addr: number) => r.get(addr) ?? 0;

  // Identity marker "SunS".
  assert.equal(g(BASE), 0x5375, "SunS hi");
  assert.equal(g(BASE + 1), 0x6e53, "SunS lo");
  // Model headers.
  assert.equal(g(M1_HDR), 1, "model 1 id");
  assert.equal(g(M1_HDR + 1), 66, "model 1 len");
  assert.equal(g(M64001_HDR), 64001, "model 64001 id");
  assert.equal(g(M64001_HDR + 1), 11, "model 64001 len");
  assert.equal(g(M103_HDR), 103, "model 103 id");
  assert.equal(g(M103_HDR + 1), 50, "model 103 len");
  // End marker after the 103 block.
  assert.equal(g(D + 50), 0xffff, "end marker");
  assert.equal(g(D + 51), 0, "end length");
  // Model 103's St must stay inside the edge's single FC03 read, which is the
  // whole reason the private model goes before 103 rather than after it.
  assert.ok(
    D + P.St < BASE + EDGE_BLOCK,
    `model 103 St at ${D + P.St - BASE} must be within the ${EDGE_BLOCK}-register block`,
  );

  // Private model 64001 values.
  close(sf(g(V + Q.PV1V), g(V + Q.V_SF)), 279.7, "PV1 voltage");
  // 0 V on string 2 is a real reading (night, or a single-string install), so
  // it must encode as 0 rather than being treated as absent.
  close(sf(g(V + Q.PV2V), g(V + Q.V_SF)), 0, "PV2 voltage");
  close(sf(g(V + Q.BusV), g(V + Q.V_SF)), 626.7, "bus voltage");
  close(acc32(g(V + Q.TodayWh), g(V + Q.TodayWh + 1)) / 1000, 6.99, "today kWh");
  // Both overflow uint16 on a real device, hence uint32 + a shared SF.
  close(
    accSf(g(V + Q.RunHours), g(V + Q.RunHours + 1), g(V + Q.Frac_SF)),
    19051.2,
    "running hours",
  );
  close(
    accSf(g(V + Q.CO2Kg), g(V + Q.CO2Kg + 1), g(V + Q.Frac_SF)),
    17359.9,
    "CO2 reduction",
  );

  // Decoded values (int16 x 10^SF).
  close(sf(g(D + P.W), g(D + P.W_SF)), 2536, "W");
  close(sf(g(D + P.Hz), g(D + P.Hz_SF)), 49.98, "Hz");
  close(sf(g(D + P.PhVphA), g(D + P.V_SF)), 232.1, "PhVphA");
  close(sf(g(D + P.AphA), g(D + P.A_SF)), 3.74, "AphA");
  // Lifetime energy: acc32 Wh, SF 0 -> 22114.53 kWh.
  close(
    accSf(g(D + P.WH), g(D + P.WH + 1), g(D + P.WH_SF)) / 1000,
    22114.53,
    "WH",
  );
  assert.equal(g(D + P.St), 4, "operating state = MPPT");

  // An offline reading must not encode.
  assert.equal(
    buildRegisters({ status: "Offline", grid_connected_power: "0" }),
    undefined,
    "an offline reading must not encode",
  );
  // Nor a reading missing a required AC field.
  const { line2_voltage, ...missingPhase } = ONLINE;
  assert.equal(
    buildRegisters(missingPhase),
    undefined,
    "an incomplete reading must not encode",
  );

  console.log("  encoding: ok");
}

function checkStaleness() {
  resetSnapshot();
  assert.throws(
    () => vector.getHoldingRegister!(BASE, MODBUS_UNIT_ID, () => {}),
    "with no reading at all the server must fault",
  );
  updateSnapshot(ONLINE, Date.now() - 10 * 60 * 1000);
  assert.throws(
    () =>
      vector.getMultipleHoldingRegisters!(
        BASE,
        EDGE_BLOCK,
        MODBUS_UNIT_ID,
        () => {},
      ),
    "a stale reading must fault rather than serve old values",
  );
  console.log("  staleness: ok");
}

async function checkServerRoundTrip() {
  const server = new ServerTCP(vector, {
    host: "127.0.0.1",
    port: TEST_PORT,
    unitID: MODBUS_UNIT_ID,
  });
  updateSnapshot(ONLINE);

  const client = new ModbusRTU();
  await client.connectTCP("127.0.0.1", { port: TEST_PORT });
  client.setID(MODBUS_UNIT_ID);

  // Read the whole SunSpec device block in one request, as a driver would.
  const res = await client.readHoldingRegisters(BASE, EDGE_BLOCK);
  const g = (off: number) => res.data[off];

  assert.equal(g(0), 0x5375, "SunS over the wire");
  assert.equal(g(M64001_HDR - BASE), 64001, "model 64001 over the wire");
  assert.equal(g(M103_HDR - BASE), 103, "model 103 over the wire");
  close(
    sf(g(V - BASE + Q.BusV), g(V - BASE + Q.V_SF)),
    626.7,
    "bus voltage over the wire",
  );
  close(sf(g(D - BASE + P.W), g(D - BASE + P.W_SF)), 2536, "W over the wire");
  close(sf(g(D - BASE + P.Hz), g(D - BASE + P.Hz_SF)), 49.98, "Hz over the wire");
  close(
    accSf(g(D - BASE + P.WH), g(D - BASE + P.WH + 1), g(D - BASE + P.WH_SF)) /
      1000,
    22114.53,
    "WH over the wire",
  );

  client.close(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log("  server round-trip: ok");
}

async function main() {
  console.log("saj2mqtt sunspec self-check");
  checkEncoding();
  checkStaleness();
  await checkServerRoundTrip();
  console.log("all checks passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
