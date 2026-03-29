import type {
  EstimateInput,
  EstimateResult,
  JobEstimateBreakdown,
  MachineWithOps,
} from "./types.js";
import {
  estimateJobRouteMinutes,
  findMatchingRoutingRule,
  type MachineLike,
} from "../../../src/lib/scheduler/machine-routing.ts";

function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function rollMetresFromJob(
  roll: unknown
): number | null {
  if (roll == null) return null;
  if (typeof roll === "number" && Number.isFinite(roll) && roll > 0) return roll;
  if (typeof roll === "object" && roll !== null && "toNumber" in roll) {
    const n = (roll as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const n = Number(roll);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toMachineLike(m: MachineWithOps): MachineLike {
  return {
    id: m.id,
    name: m.name,
    displayName: m.displayName,
    constants: m.constants,
    operations: m.operations.map((op) => ({
      id: op.id,
      enabled: op.enabled,
      params: op.params.map((p) => ({ key: p.key, value: p.value as unknown })),
    })),
  };
}

/**
 * Line-speed routing: match `productionPath` to a rule, then for each step use
 * min(LINE_SPEED_M_PER_MIN) over the mode/custom ops for run time (rollLengthMetres / speed),
 * plus summed SETUP_TIME_MIN on those operations.
 */
export function estimate(input: EstimateInput): EstimateResult {
  const rules = input.routingFlow?.rules ?? [];
  const machinesById = new Map(
    input.machines.map((m) => [m.id, toMachineLike(m)])
  );

  const jobBreakdowns: JobEstimateBreakdown[] = [];
  let totalMinutes = 0;

  for (const job of input.jobs) {
    const rule = findMatchingRoutingRule(rules, job.productionPath);
    const rollLength = rollMetresFromJob(job.rollLengthMetres);

    const est = estimateJobRouteMinutes(rule, machinesById, rollLength);
    totalMinutes += est.minutes;

    jobBreakdowns.push({
      jobId: job.id,
      productionPath: job.productionPath,
      rollLengthMetres: rollLength,
      routingRuleId: est.routingRuleId,
      minutes: est.minutes,
      steps: est.stepDetails.map((s) => ({
        machineName: s.machineName,
        machineDisplayName: s.machineDisplayName,
        effectiveSpeedMpm: s.effectiveSpeedMpm,
        minutes: s.minutes,
        skippedReason: s.skippedReason,
      })),
    });
  }

  const byMachine = new Map<string, number>();
  for (const jb of jobBreakdowns) {
    for (const st of jb.steps) {
      const prev = byMachine.get(st.machineName) ?? 0;
      byMachine.set(st.machineName, prev + st.minutes);
    }
  }

  const breakdown = Array.from(byMachine.entries()).map(
    ([machineName, subtotalMinutes]) => ({
      machineName,
      operations: [] as EstimateResult["breakdown"][0]["operations"],
      subtotalMinutes,
    })
  );

  return {
    totalMinutes,
    totalDisplay: formatMinutes(totalMinutes),
    machinesUsed: Array.from(byMachine.keys()),
    slitterThresholdTriggered: false,
    breakdown,
    jobBreakdowns,
    batchContext: {
      totalJobsInBatch: input.jobs.length,
      sharedSetups: [],
    },
  };
}
