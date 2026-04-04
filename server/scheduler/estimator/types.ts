import type { Job, Operation, BatchRule, OperationParam } from "@prisma/client";

export type OperationWithRules = Operation & {
  params: OperationParam[];
  batchRule: BatchRule | null;
};

export type JobEstimateStep = {
  machineId: string;
  machineName: string;
  machineDisplayName: string;
  effectiveSpeedMpm: number | null;
  minutes: number;
  skippedReason?: string;
};

export type JobEstimateBreakdown = {
  jobId: string;
  productionPath: string;
  rollLengthMetres: number | null;
  routingRuleId: string | null;
  minutes: number;
  steps: JobEstimateStep[];
};

export type EstimateResult = {
  totalMinutes: number;
  totalDisplay: string;
  machinesUsed: string[];
  slitterThresholdTriggered: boolean;
  breakdown: Array<{
    machineName: string;
    operations: Array<{
      operationName: string;
      minutes: number;
      isBatchShared: boolean;
      comboKey?: string;
      occurrences?: number;
      formulaUsed?: string;
    }>;
    subtotalMinutes: number;
  }>;
  /** Per-job routing + line-speed estimates */
  jobBreakdowns: JobEstimateBreakdown[];
  batchContext: {
    totalJobsInBatch: number;
    sharedSetups: Array<{ operationName: string; savedMinutes: number }>;
  };
};

export type MachineWithOps = {
  id: string;
  name: string;
  displayName: string;
  sortOrder: number;
  constants: unknown;
  operations: OperationWithRules[];
};

export type SchedulerRoutingFlowInput = {
  rules: Array<{
    id: string;
    match: { kind: "exact" | "prefix"; productionPath: string };
    steps: Array<{
      machineId: string;
      modeId: string | null;
      customOperationIds?: string[];
    }>;
  }>;
};

export type EstimateInput = {
  jobs: Job[];
  machines: MachineWithOps[];
  routingFlow: SchedulerRoutingFlowInput | null;
};
