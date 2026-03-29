import { z } from "zod";

export const createMachineSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, "Use lowercase letters, numbers, and underscores only"),
  displayName: z.string().min(1),
  sortOrder: z.coerce.number().int(),
  enabled: z.coerce.boolean().optional(),
  constantsJson: z.string().optional().nullable(),
});

export type CreateMachineInput = z.infer<typeof createMachineSchema>;

export const createOperationBodySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  sortOrder: z.coerce.number().int(),
  enabled: z.coerce.boolean().optional(),
  calcFnKey: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export type CreateOperationBodyInput = z.infer<typeof createOperationBodySchema>;

export const operationParamRowSchema = z.object({
  key: z.string().min(1),
  /** Stored as JSON (number, string, object, etc.) */
  value: z.any(),
  valueType: z.string().min(1),
  label: z.string().min(1),
  unit: z.string().optional().nullable(),
  isConfigurable: z.coerce.boolean(),
  sortOrder: z.coerce.number().int(),
});

export const batchRuleBodySchema = z.object({
  scope: z.string().min(1),
  groupByFields: z.array(z.string()),
  appliesOnce: z.coerce.boolean(),
  thresholdValue: z.coerce.number().int().optional().nullable(),
  routeToMachine: z.string().optional().nullable(),
  conditionExpr: z.string().optional().nullable(),
});

export const updateOperationBodySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  sortOrder: z.coerce.number().int(),
  enabled: z.coerce.boolean().optional(),
  calcFnKey: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  params: z.array(operationParamRowSchema).optional(),
  batchRule: batchRuleBodySchema.optional().nullable(),
});

export type OperationParamRowInput = z.infer<typeof operationParamRowSchema>;
export type BatchRuleBodyInput = z.infer<typeof batchRuleBodySchema>;
export type UpdateOperationBodyInput = z.infer<typeof updateOperationBodySchema>;

export const patchMachineSchema = z.object({
  displayName: z.string().min(1).optional(),
  sortOrder: z.coerce.number().int().optional(),
  enabled: z.coerce.boolean().optional(),
  /** Shallow-merged into existing machine.constants */
  constants: z.record(z.unknown()).optional(),
});

export type PatchMachineInput = z.infer<typeof patchMachineSchema>;
