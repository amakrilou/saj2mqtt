export enum SAJField {
  TOTAL_GENERATED = "total_generated",
  TOTAL_RUNNING_TIME = "total_running_time",
  TODAY_GENERATED = "today_generated",
  TODAY_RUNNING_TIME = "today_running_time",
  PV1_VOLTAGE = "PV1_voltage",
  PV1_CURRENT = "PV1_current",
  PV2_VOLTAGE = "PV2_voltage",
  PV2_CURRENT = "PV2_current",
  GRID_CONNECTED_POWER = "grid_connected_power",
  GRID_CONNECTED_FREQUENCY = "grid_connected_frequency",
  LINE1_VOLTAGE = "line1_voltage",
  LINE1_CURRENT = "line1_current",
  LINE2_VOLTAGE = "line2_voltage",
  LINE2_CURRENT = "line2_current",
  LINE3_VOLTAGE = "line3_voltage",
  LINE3_CURRENT = "line3_current",
  BUS_VOLTAGE = "bus_voltage",
  DEVICE_TEMPERATURE = "device_temperature",
  CO2_EMISSION_REDUCTION = "CO2emission_reduction",
}

export type SAJState = Partial<Record<SAJField | "status" | "date", string>>;
