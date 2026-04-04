import { z } from "zod";

/** Stored on each `Operation` as a single `OperationParam` row. */
export const LINE_SPEED_PARAM_KEY = "LINE_SPEED_M_PER_MIN";

/** Optional per-operation setup time (minutes), summed for all operations in a routing step. */
export const SETUP_TIME_PARAM_KEY = "SETUP_TIME_MIN";

/** `TimeEstimatorSettings.key` for routing rules JSON. */
export const SCHEDULER_ROUTING_KEY = "scheduler_routing_v1";

export const schedulerModeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  operationIds: z.array(z.string().uuid()),
});

export type SchedulerMode = z.infer<typeof schedulerModeSchema>;

export const routingRuleSchema = z.object({
  id: z.string().uuid(),
  match: z.object({
    kind: z.enum(["exact", "prefix"]),
    productionPath: z.string(),
  }),
  steps: z.array(
    z.object({
      machineId: z.string().uuid(),
      modeId: z.string().uuid().nullable(),
      customOperationIds: z.array(z.string().uuid()).optional(),
    })
  ),
});

export type RoutingRule = z.infer<typeof routingRuleSchema>;

export const schedulerRoutingFlowSchema = z.object({
  rules: z.array(routingRuleSchema),
});

export type SchedulerRoutingFlow = z.infer<typeof schedulerRoutingFlowSchema>;

export function parseSchedulerModes(constants: unknown): SchedulerMode[] {
  if (!constants || typeof constants !== "object" || constants === null) return [];
  const raw = (constants as Record<string, unknown>).schedulerModes;
  if (!Array.isArray(raw)) return [];
  const parsed = z.array(schedulerModeSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function parseSchedulerRoutingFlow(
  flowProperties: unknown
): SchedulerRoutingFlow | null {
  if (!flowProperties || typeof flowProperties !== "object" || flowProperties === null) {
    return null;
  }
  const parsed = schedulerRoutingFlowSchema.safeParse(flowProperties);
  return parsed.success ? parsed.data : null;
}

/** Prefer exact match, then longest prefix match. */
export function findMatchingRoutingRule(
  rules: RoutingRule[],
  productionPath: string
): RoutingRule | null {
  const exact = rules.find(
    (r) => r.match.kind === "exact" && r.match.productionPath === productionPath
  );
  if (exact) return exact;

  const prefixMatches = rules
    .filter(
      (r) =>
        r.match.kind === "prefix" &&
        r.match.productionPath.length > 0 &&
        productionPath.startsWith(r.match.productionPath)
    )
    .sort((a, b) => b.match.productionPath.length - a.match.productionPath.length);
  return prefixMatches[0] ?? null;
}

export type OperationLike = {
  id: string;
  enabled: boolean;
  params: Array<{ key: string; value: unknown }>;
};

export function getLineSpeedMpm(op: OperationLike): number | null {
  const p = op.params.find((x) => x.key === LINE_SPEED_PARAM_KEY);
  if (!p) return null;
  const v = p.value;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function getSetupTimeMinutes(op: OperationLike): number {
  const p = op.params.find((x) => x.key === SETUP_TIME_PARAM_KEY);
  if (!p) return 0;
  const v = p.value;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/** Sums setup minutes for enabled operations whose ids are in the step (mode or custom list). */
export function sumSetupMinutesForOperationIds(
  operations: OperationLike[],
  operationIds: string[]
): number {
  const idSet = new Set(operationIds);
  let sum = 0;
  for (const op of operations) {
    if (!idSet.has(op.id) || !op.enabled) continue;
    sum += getSetupTimeMinutes(op);
  }
  return sum;
}

export function effectiveSpeedMpmForOperationIds(
  operations: OperationLike[],
  operationIds: string[]
): number | null {
  const idSet = new Set(operationIds);
  const speeds: number[] = [];
  for (const op of operations) {
    if (!idSet.has(op.id) || !op.enabled) continue;
    const s = getLineSpeedMpm(op);
    if (s != null) speeds.push(s);
  }
  if (speeds.length === 0) return null;
  return Math.min(...speeds);
}

export type MachineLike = {
  id: string;
  name: string;
  displayName: string;
  constants: unknown;
  operations: OperationLike[];
};

export function resolveStepOperationIds(
  machine: MachineLike,
  step: {
    modeId: string | null;
    customOperationIds?: string[] | undefined;
  }
): { operationIds: string[]; source: "mode" | "custom" | "none" } {
  if (step.modeId) {
    const modes = parseSchedulerModes(machine.constants);
    const mode = modes.find((m) => m.id === step.modeId);
    if (mode) return { operationIds: mode.operationIds, source: "mode" };
  }
  if (step.customOperationIds && step.customOperationIds.length > 0) {
    return { operationIds: step.customOperationIds, source: "custom" };
  }
  return { operationIds: [], source: "none" };
}

export type StepEstimate = {
  /** Stable join key for UI (matches `scheduler.Machine.id`). */
  machineId: string;
  machineDisplayName: string;
  machineName: string;
  effectiveSpeedMpm: number | null;
  minutes: number;
  skippedReason?: string;
};

export function estimateMinutesForMachineStep(
  machine: MachineLike,
  step: RoutingRule["steps"][0],
  rollLengthMetres: number | null
): StepEstimate {
  const { operationIds, source } = resolveStepOperationIds(machine, step);
  if (source === "none" || operationIds.length === 0) {
    return {
      machineId: machine.id,
      machineDisplayName: machine.displayName,
      machineName: machine.name,
      effectiveSpeedMpm: null,
      minutes: 0,
      skippedReason: "No mode or custom operations",
    };
  }

  const setupMinutes = sumSetupMinutesForOperationIds(machine.operations, operationIds);

  const speed = effectiveSpeedMpmForOperationIds(machine.operations, operationIds);
  if (speed == null || speed <= 0) {
    return {
      machineId: machine.id,
      machineDisplayName: machine.displayName,
      machineName: machine.name,
      effectiveSpeedMpm: null,
      minutes: setupMinutes,
      skippedReason: "Missing LINE_SPEED_M_PER_MIN on operations",
    };
  }

  const len = rollLengthMetres != null && rollLengthMetres > 0 ? rollLengthMetres : 0;
  if (len <= 0) {
    return {
      machineId: machine.id,
      machineDisplayName: machine.displayName,
      machineName: machine.name,
      effectiveSpeedMpm: speed,
      minutes: setupMinutes,
      skippedReason: "No roll length",
    };
  }

  const runMinutes = len / speed;
  return {
    machineId: machine.id,
    machineDisplayName: machine.displayName,
    machineName: machine.name,
    effectiveSpeedMpm: speed,
    minutes: setupMinutes + runMinutes,
  };
}

export function estimateJobRouteMinutes(
  rule: RoutingRule | null,
  machinesById: Map<string, MachineLike>,
  rollLengthMetres: number | null
): {
  routingRuleId: string | null;
  minutes: number;
  stepDetails: StepEstimate[];
} {
  if (!rule) {
    return {
      routingRuleId: null,
      minutes: 0,
      stepDetails: [],
    };
  }

  let total = 0;
  const stepDetails: StepEstimate[] = [];

  for (const step of rule.steps) {
    const machine = machinesById.get(step.machineId);
    if (!machine) {
      stepDetails.push({
        machineId: step.machineId,
        machineDisplayName: step.machineId,
        machineName: step.machineId,
        effectiveSpeedMpm: null,
        minutes: 0,
        skippedReason: "Machine not found",
      });
      continue;
    }
    const est = estimateMinutesForMachineStep(machine, step, rollLengthMetres);
    stepDetails.push(est);
    total += est.minutes;
  }

  return {
    routingRuleId: rule.id,
    minutes: total,
    stepDetails,
  };
}
