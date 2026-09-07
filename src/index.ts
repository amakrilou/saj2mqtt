import {
  MQTT_SAJ2MQTT_TOPIC,
  POLLING_INTERVAL,
  SAJ_STATUS_URL,
} from "./config";
import { startModbusServer, updateSnapshot } from "./modbus";
import { mqttClient } from "./mqtt";
import { getCurrentState } from "./state";

async function SAJ2MQTT() {
  if (!SAJ_STATUS_URL) {
    throw new Error("No SAJ status url found");
  }

  const state = await getCurrentState();

  console.log(state);

  mqttClient.publish(MQTT_SAJ2MQTT_TOPIC, JSON.stringify(state));

  // getCurrentState resolves to an Error when the inverter returns no data.
  // Skipping it leaves the last good reading in place until it goes stale.
  if (!(state instanceof Error)) {
    updateSnapshot(state);
  }

  setTimeout(SAJ2MQTT, POLLING_INTERVAL);
}

startModbusServer();
SAJ2MQTT();
