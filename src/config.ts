import dotenv from "dotenv";

dotenv.config();

const env = process.env;

export const SAJ_INVERTER_IP = env.SAJ_INVERTER_IP || "localhost";

export const SAJ_STATUS_URL =
  env.SAJ_INVERTER_URL || `http://${SAJ_INVERTER_IP}/status/status.php`;

export const POLLING_INTERVAL = Number(env.POLLING_INTERVAL) || 8000;

export const MQTT_BROKER_IP = env.MQTT_BROKER_IP;
export const MQTT_BROKER_PORT = env.MQTT_BROKER_PORT || 1883;
export const MQTT_BROKER_USER = env.MQTT_BROKER_USER || "admin";
export const MQTT_BROKER_PWD = env.MQTT_BROKER_PWD || "password";

export const MQTT_SAJ2MQTT_TOPIC = env.MQTT_SAJ2MQTT_TOPIC || "saj2mqtt/state";

// Modbus TCP server. The inverter is served as a SunSpec device (Common model 1
// + three-phase inverter model 103) so the E-MVP edge can poll it as a real
// solar inverter, not a meter (see src/modbus.ts).
export const MODBUS_TCP_HOST = env.MODBUS_TCP_HOST || "0.0.0.0";
export const MODBUS_TCP_PORT = Number(env.MODBUS_TCP_PORT) || 502;
export const MODBUS_UNIT_ID = Number(env.MODBUS_UNIT_ID) || 1;

// SunSpec base register: the holding-register address where the "SunS" marker
// and model chain begin. 40000 is the near-universal default; the edge's SunSpec
// driver must read from the same base.
export const MODBUS_BASE_REGISTER = Number(env.MODBUS_BASE_REGISTER) || 40000;

// How long a reading stays servable. Past this the server answers with a Modbus
// exception rather than stale values, so the poller reports a communication
// failure instead of a plausible-looking 0 W. Three polls of headroom by
// default, so a single missed scrape does not flap the meter.
export const MODBUS_STALE_AFTER =
  Number(env.MODBUS_STALE_AFTER_MS) || POLLING_INTERVAL * 3;
