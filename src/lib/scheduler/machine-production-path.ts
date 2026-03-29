import type { SchedulerJob } from "../../services/api";

import { findMatchingRoutingRule, type RoutingRule } from "./machine-routing";

/** Known `scheduler.Machine.name` values from seed / Config → `Job.productionPath`. */
const MACHINE_NAME_TO_PATH: Record<string, SchedulerJob["productionPath"]> = {
  hp_indigo_6900: "indigo_only",
  digicon_line: "digicon",
  digital_cutter: "digital_cutter",
  slitter_line: "slitter",
};

/**
 * Maps `scheduler.Machine.name` to `Job.productionPath` (Labex CSV / Switch paths).
 * Add entries in {@link MACHINE_NAME_TO_PATH} when you create machines in Config.
 */
export function productionPathForMachineName(machineName: string): SchedulerJob["productionPath"] | null {
  if (MACHINE_NAME_TO_PATH[machineName]) {
    return MACHINE_NAME_TO_PATH[machineName];
  }
  const n = machineName.toLowerCase();
  if (n.includes("slitter")) return "slitter";
  if (n.includes("digital") && n.includes("cut")) return "digital_cutter";
  if (n.includes("digicon")) return "digicon";
  if (n.includes("indigo")) return "indigo_only";
  return null;
}

export function jobMatchesMachine(job: SchedulerJob, machineName: string): boolean {
  const expected = productionPathForMachineName(machineName);
  if (!expected) return false;
  return job.productionPath === expected;
}

/**
 * Schedule view: show a job on a machine when routing rules say that machine is a step
 * for the job’s `productionPath` (operations resolved per step in Config → Routing).
 * If `rules` is empty, falls back to {@link jobMatchesMachine} (legacy name → path map).
 */
export function jobMatchesMachineForSchedule(
  job: SchedulerJob,
  machine: { id: string; name: string },
  rules: RoutingRule[]
): boolean {
  if (rules.length > 0) {
    const rule = findMatchingRoutingRule(rules, job.productionPath);
    if (!rule) return false;
    return rule.steps.some((step) => step.machineId === machine.id);
  }
  return jobMatchesMachine(job, machine.name);
}

/** Sort jobs for a selected machine: by step order in the matched routing rule, then material. */
export function compareJobsByRoutingStep(
  a: SchedulerJob,
  b: SchedulerJob,
  machineId: string,
  rules: RoutingRule[]
): number {
  if (rules.length === 0) return 0;
  const ruleA = findMatchingRoutingRule(rules, a.productionPath);
  const ruleB = findMatchingRoutingRule(rules, b.productionPath);
  const idxA = ruleA ? ruleA.steps.findIndex((s) => s.machineId === machineId) : 999;
  const idxB = ruleB ? ruleB.steps.findIndex((s) => s.machineId === machineId) : 999;
  if (idxA !== idxB) return idxA - idxB;
  return a.material.localeCompare(b.material);
}
