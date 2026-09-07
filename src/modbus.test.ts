import assert from "node:assert/strict";
import ModbusRTU, { ServerTCP } from "modbus-serial";
import { buildRegisters, resetSnapshot, updateSnapshot, vector } from "./modbus";
import { MODBUS_UNIT_ID } from "./config";
import { formatPayload } from "./formatters/state";
import { SAJState } from "./types";

/**
 * Self-check for the DTSU666 register encoding and the Modbus TCP server.
 *
 * Run with `npm test`. Deliberately plain asserts and a real socket -- the
 * encoding (float32 + word order + per-field scaling) and the edge's exact
 * block reads are the parts that silently produce wrong numbers, so they are
 * checked against a real client rather than a mock.
 */

const TEST_PORT = 15502;

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

/** Decodes a float32 from a big-endian ABCD register pair. */
function decodeFloat32(words: number[]): number {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(words[0], 0);
  buf.writeUInt16BE(words[1], 2);
  return buf.readFloatBE(0);
}

function close(value: number, expected: number, what: string) {
  assert.ok(
    Math.abs(value - expected) < 0.01,
    `${what}: expected ~${expected}, got ${value}`,
  );
}

function checkEncoding() {
  const regs = buildRegisters(ONLINE);
  assert.ok(regs, "a complete online reading must encode");

  const at = (addr: number) => decodeFloat32([regs.get(addr)!, regs.get(addr + 1)!]);

  // Active power is generation, positive, and already in watts.
  close(at(0x2012), 2536, "Pt");
  // Split evenly across the phases.
  close(at(0x2014), 2536 / 3, "Pa");
  close(at(0x2018), 2536 / 3, "Pc");
  // Voltage /10, current /100, frequency /100.
  close(at(0x2006), 232.1, "Ua");
  close(at(0x200a), 232.8, "Uc");
  close(at(0x200c), 3.74, "Ia");
  close(at(0x2044), 49.98, "Freq");
  // Import energy is lifetime production, /100 -> kWh. Export is 0.
  close(at(0x101e), 22114.53, "Imp_EP");
  close(at(0x1028), 0, "Exp_EP");
  // Inverters run at unity power factor and produce no reactive power.
  close(at(0x202a), 1, "PFt");
  close(at(0x201a), 0, "Qt");
  // Apparent power equals active power at PF 1.
  close(at(0x2022), 2536, "St");

  // An offline reading must not encode: serving zeros would report a healthy
  // inverter producing nothing.
  assert.equal(
    buildRegisters({ status: "Offline", grid_connected_power: "0" }),
    undefined,
    "an offline reading must not encode",
  );
  // Nor may a reading with a missing field, which would otherwise emit NaN --
  // the edge rejects NaN and discards the whole meter parse.
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
  assert.throws(() => vector.getHoldingRegister!(0x2012, MODBUS_UNIT_ID, () => {}),
    "with no reading at all the server must fault");

  // Older than MODBUS_STALE_AFTER (3 x the 8s default poll interval).
  updateSnapshot(ONLINE, Date.now() - 10 * 60 * 1000);
  assert.throws(
    () => vector.getMultipleHoldingRegisters!(0x2006, 44, MODBUS_UNIT_ID, () => {}),
    "a stale reading must fault rather than serve old values",
  );

  console.log("  staleness: ok");
}

async function checkServerRoundTrip() {
  // The server is built here rather than via startModbusServer so the check
  // binds a test port on loopback and does not depend on the environment.
  const server = new ServerTCP(vector, {
    host: "127.0.0.1",
    port: TEST_PORT,
    unitID: MODBUS_UNIT_ID,
  });

  updateSnapshot(ONLINE);

  const client = new ModbusRTU();
  await client.connectTCP("127.0.0.1", { port: TEST_PORT });
  client.setID(MODBUS_UNIT_ID);

  // Exactly the three blocks the edge coalesces its 25 registers into.
  const energy = await client.readHoldingRegisters(0x101e, 12);
  const electrical = await client.readHoldingRegisters(0x2006, 44);
  const frequency = await client.readHoldingRegisters(0x2044, 2);

  assert.equal(energy.data.length, 12, "energy block length");
  assert.equal(electrical.data.length, 44, "electrical block length");
  assert.equal(frequency.data.length, 2, "frequency block length");

  close(decodeFloat32(energy.data.slice(0, 2)), 22114.53, "Imp_EP over the wire");
  // Pt is at 0x2012, twelve registers into the 0x2006 block.
  close(decodeFloat32(electrical.data.slice(12, 14)), 2536, "Pt over the wire");
  close(decodeFloat32(frequency.data), 49.98, "Freq over the wire");

  // The gap between Imp_EP and Exp_EP is unmapped and must read as 0, not fault.
  assert.deepEqual(
    energy.data.slice(2, 10),
    new Array(8).fill(0),
    "unmapped gap registers must read as 0",
  );

  client.close(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log("  server round-trip: ok");
}

async function main() {
  console.log("saj2mqtt modbus self-check");
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
