/**
 * Default flow-element values aligned with Enfocus Switch `time_v1_sscript` (README v2.2).
 * Stored in DB (`TimeEstimatorSettings`) and used by the estimator engine when not overridden per machine/param.
 */
export const SWITCH_FLOW_DEFAULTS_KEY = "switch_flow_defaults";

export const SWITCH_FLOW_DEFAULTS: Record<string, string | number> = {
  // Indigo & digital cutting
  INDIGO_STEP_HEIGHT: 980,
  AVAILABLE_KNIFE: 4,
  SPEED_PER_CYCLE: "1.3",
  // Semi-rotary
  SEMI_ROTARY_MIN_HEIGHT: 46,
  SEMI_ROTARY_MAX_HEIGHT: 620,
  SEMI_ROTARY_PLATE_HEIGHT: 46,
  // Finishing multipliers (strings per Switch property type in README)
  FINISHING_FOLDING_MULTIPLIER: "0.1",
  FINISHING_BINDING_MULTIPLIER: "0.2",
  FINISHING_CUTTING_MULTIPLIER: "0.05",
  FINISHING_LAMINATING_MULTIPLIER: "0.3",
  FINISHING_DIE_CUTTING_MULTIPLIER: "0.15",
  FINISHING_EMBOSSING_MULTIPLIER: "0.25",
  FINISHING_DEFAULT_MULTIPLIER: "0.1",
  // Fixed speeds (documented in README formulas)
  COATING_SPEED_M_PER_MIN: 28,
  SLITTING_FIXED_SECONDS_PER_DIE: 40,
  SLITTING_SPEED_M_PER_MIN: 30,
};

/** Keys for `switchEstimateOutput` JSON on Job (Switch private data names). */
export const SWITCH_ESTIMATE_OUTPUT_KEYS = [
  "ProductionEstDigital",
  "ProductionEstSemi",
  "ProductionEstPrinting",
  "ProductionEstDigitalFormatted",
  "ProductionEstSemiFormatted",
  "ProductionEstPrintingFormatted",
  "DigitalCuttingTimeSeconds",
  "DigitalCuttingTimeMinutes",
  "IndigoMaxStepQty",
  "IndigoRepeatLength",
  "IndigoSpeedMperMin",
  "IndigoTotalLength",
  "IndigoProductionTime",
  "CoatingSpeedMperMin",
  "CoatingTotalLength",
  "CoatingProductionTime",
  "SlittingNumberAcross",
  "SlittingFixedTimeMinutes",
  "SlittingSpeedMperMin",
  "SlittingSpeedTimeMinutes",
  "SlittingTotalLength",
  "SlittingProductionTime",
  "SemiRotaryPlateHeight",
  "SemiRotarySpeedMperMin",
  "SemiRotaryTotalLength",
  "SemiRotaryProductionTime",
  "TimeEstimationStatus",
  "TimeEstimationTimestamp",
  "TimeEstimationError",
] as const;
