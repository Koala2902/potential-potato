import { Router } from "express";

import { prisma } from "./db/prisma.js";
import { getSchedulerSyncDiagnostics } from "./scheduler/legacy-migrate.js";
import { estimate } from "./scheduler/estimator/engine.js";
import {
  jobSwitchSchema,
  patchJobScheduleSchema,
} from "../src/lib/scheduler/validations/job.ts";
import { Prisma } from "@prisma/client";
import {
  createMachineSchema,
  createOperationBodySchema,
  patchMachineSchema,
  updateOperationBodySchema,
} from "../src/lib/scheduler/validations/config.ts";
import {
  SCHEDULER_ROUTING_KEY,
  schedulerRoutingFlowSchema,
} from "../src/lib/scheduler/machine-routing.ts";
import { compositeMaterialPrintColour } from "../src/lib/scheduler/job-material-key.ts";
import {
  SWITCH_FLOW_DEFAULTS,
  SWITCH_FLOW_DEFAULTS_KEY,
} from "./scheduler/switch-flow-defaults.js";

export const schedulerRouter = Router();

function mergeMachineConstants(
  existing: Prisma.JsonValue,
  patch: Record<string, unknown> | undefined
): Prisma.InputJsonValue {
  const base =
    typeof existing === "object" &&
    existing !== null &&
    !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (!patch) return base as Prisma.InputJsonValue;
  return { ...base, ...patch } as Prisma.InputJsonValue;
}

function parseConstantsJson(
  raw: string | null | undefined
): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const v = JSON.parse(raw) as unknown;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("constantsJson must be a JSON object");
  }
  return v as Record<string, unknown>;
}

/** DB + table counts (debug: why machines might not show). Call after /config/machines or rely on that route’s sync. */
schedulerRouter.get("/config/diagnostics", async (_req, res) => {
  try {
    const d = await getSchedulerSyncDiagnostics();
    res.json(d);
  } catch (e) {
    console.error("scheduler GET /config/diagnostics:", e);
    res.status(500).json({ error: "Failed to read diagnostics" });
  }
});

/** Machines + operations for scheduler config UI (includes disabled). */
schedulerRouter.get("/config/machines", async (_req, res) => {
  try {
    const machines = await prisma.machine.findMany({
      orderBy: { sortOrder: "asc" },
      include: {
        operations: {
          orderBy: { sortOrder: "asc" },
          include: {
            params: { orderBy: { sortOrder: "asc" } },
            batchRule: true,
          },
        },
      },
    });
    res.json(machines);
  } catch (e) {
    console.error("scheduler GET /config/machines:", e);
    res.status(500).json({ error: "Failed to list machines" });
  }
});

schedulerRouter.post("/config/machines", async (req, res) => {
  try {
    const parsed = createMachineSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const d = parsed.data;
    let constants: Record<string, unknown> = {};
    if (d.constantsJson != null && String(d.constantsJson).trim()) {
      try {
        constants = parseConstantsJson(String(d.constantsJson));
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : "Invalid constants JSON",
        });
        return;
      }
    }

    const machine = await prisma.machine.create({
      data: {
        name: d.name,
        displayName: d.displayName,
        sortOrder: d.sortOrder,
        enabled: d.enabled ?? true,
        constants,
      },
      include: {
        operations: {
          orderBy: { sortOrder: "asc" },
          include: { params: true, batchRule: true },
        },
      },
    });
    res.status(201).json(machine);
  } catch (e: unknown) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code?: string }).code === "P2002"
    ) {
      res.status(409).json({ error: "A machine with this name already exists" });
      return;
    }
    console.error("scheduler POST /config/machines:", e);
    res.status(500).json({ error: "Failed to create machine" });
  }
});

schedulerRouter.patch("/config/machines/:machineId", async (req, res) => {
  try {
    const { machineId } = req.params;
    const parsed = patchMachineSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const d = parsed.data;

    const existing = await prisma.machine.findUnique({ where: { id: machineId } });
    if (!existing) {
      res.status(404).json({ error: "Machine not found" });
      return;
    }

    const constantsMerged = d.constants
      ? mergeMachineConstants(existing.constants, d.constants)
      : undefined;

    const updated = await prisma.machine.update({
      where: { id: machineId },
      data: {
        ...(d.displayName != null ? { displayName: d.displayName } : {}),
        ...(d.sortOrder != null ? { sortOrder: d.sortOrder } : {}),
        ...(d.enabled != null ? { enabled: d.enabled } : {}),
        ...(constantsMerged != null ? { constants: constantsMerged } : {}),
      },
      include: {
        operations: {
          orderBy: { sortOrder: "asc" },
          include: {
            params: { orderBy: { sortOrder: "asc" } },
            batchRule: true,
          },
        },
      },
    });
    res.json(updated);
  } catch (e) {
    console.error("scheduler PATCH /config/machines/:machineId:", e);
    res.status(500).json({ error: "Failed to update machine" });
  }
});

schedulerRouter.post("/config/machines/:machineId/operations", async (req, res) => {
  try {
    const { machineId } = req.params;
    const parsed = createOperationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const d = parsed.data;

    const exists = await prisma.machine.findUnique({ where: { id: machineId } });
    if (!exists) {
      res.status(404).json({ error: "Machine not found" });
      return;
    }

    const operation = await prisma.operation.create({
      data: {
        machineId,
        name: d.name,
        type: d.type,
        sortOrder: d.sortOrder,
        enabled: d.enabled ?? true,
        calcFnKey: d.calcFnKey ?? undefined,
        notes: d.notes ?? undefined,
        batchRule: {
          create: {
            scope: "per_job",
            groupByFields: [],
            appliesOnce: false,
          },
        },
      },
      include: {
        params: { orderBy: { sortOrder: "asc" } },
        batchRule: true,
      },
    });
    res.status(201).json(operation);
  } catch (e) {
    console.error("scheduler POST /config/machines/:id/operations:", e);
    res.status(500).json({ error: "Failed to create operation" });
  }
});

schedulerRouter.patch(
  "/config/machines/:machineId/operations/:operationId",
  async (req, res) => {
    try {
      const { machineId, operationId } = req.params;
      const parsed = updateOperationBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      const d = parsed.data;

      const existing = await prisma.operation.findFirst({
        where: { id: operationId, machineId },
      });
      if (!existing) {
        res.status(404).json({ error: "Operation not found for this machine" });
        return;
      }

      await prisma.$transaction(async (tx) => {
        await tx.operation.update({
          where: { id: operationId },
          data: {
            name: d.name,
            type: d.type,
            sortOrder: d.sortOrder,
            enabled: d.enabled ?? true,
            calcFnKey: d.calcFnKey ?? null,
            notes: d.notes ?? null,
          },
        });

        if (d.params !== undefined) {
          await tx.operationParam.deleteMany({ where: { operationId } });
          if (d.params.length > 0) {
            await tx.operationParam.createMany({
              data: d.params.map((p) => ({
                operationId,
                key: p.key,
                value: p.value as Prisma.InputJsonValue,
                valueType: p.valueType,
                label: p.label,
                unit: p.unit ?? null,
                isConfigurable: p.isConfigurable,
                sortOrder: p.sortOrder,
              })),
            });
          }
        }

        if (d.batchRule !== undefined && d.batchRule !== null) {
          await tx.batchRule.upsert({
            where: { operationId },
            create: {
              operationId,
              scope: d.batchRule.scope,
              groupByFields: d.batchRule.groupByFields,
              appliesOnce: d.batchRule.appliesOnce,
              thresholdValue: d.batchRule.thresholdValue ?? null,
              routeToMachine: d.batchRule.routeToMachine ?? null,
              conditionExpr: d.batchRule.conditionExpr ?? null,
            },
            update: {
              scope: d.batchRule.scope,
              groupByFields: d.batchRule.groupByFields,
              appliesOnce: d.batchRule.appliesOnce,
              thresholdValue: d.batchRule.thresholdValue ?? null,
              routeToMachine: d.batchRule.routeToMachine ?? null,
              conditionExpr: d.batchRule.conditionExpr ?? null,
            },
          });
        }
      });

      const updated = await prisma.operation.findUnique({
        where: { id: operationId },
        include: {
          params: { orderBy: { sortOrder: "asc" } },
          batchRule: true,
        },
      });
      res.json(updated);
    } catch (e) {
      console.error("scheduler PATCH /config/machines/.../operations/...:", e);
      res.status(500).json({ error: "Failed to update operation" });
    }
  }
);

schedulerRouter.delete(
  "/config/machines/:machineId/operations/:operationId",
  async (req, res) => {
    try {
      const { machineId, operationId } = req.params;
      const op = await prisma.operation.findFirst({
        where: { id: operationId, machineId },
      });
      if (!op) {
        res.status(404).json({ error: "Operation not found for this machine" });
        return;
      }
      await prisma.operation.delete({ where: { id: operationId } });
      res.status(204).send();
    } catch (e) {
      console.error("scheduler DELETE /config/machines/.../operations/...:", e);
      res.status(500).json({ error: "Failed to delete operation" });
    }
  }
);

/** Routing rules for scheduler (productionPath → machine steps + modes). */
schedulerRouter.get("/settings/routing", async (_req, res) => {
  try {
    let row = await prisma.timeEstimatorSettings.findUnique({
      where: { key: SCHEDULER_ROUTING_KEY },
    });
    if (!row) {
      row = await prisma.timeEstimatorSettings.create({
        data: {
          key: SCHEDULER_ROUTING_KEY,
          label: "Scheduler routing (productionPath → steps)",
          flowProperties: { rules: [] },
        },
      });
    }
    res.json(row);
  } catch (e) {
    console.error("scheduler GET /settings/routing:", e);
    res.status(500).json({ error: "Failed to load routing settings" });
  }
});

schedulerRouter.put("/settings/routing", async (req, res) => {
  try {
    const parsed = schedulerRoutingFlowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const row = await prisma.timeEstimatorSettings.upsert({
      where: { key: SCHEDULER_ROUTING_KEY },
      create: {
        key: SCHEDULER_ROUTING_KEY,
        label: "Scheduler routing (productionPath → steps)",
        flowProperties: parsed.data,
      },
      update: {
        flowProperties: parsed.data,
      },
    });
    res.json(row);
  } catch (e) {
    console.error("scheduler PUT /settings/routing:", e);
    res.status(500).json({ error: "Failed to save routing settings" });
  }
});

/** Flow defaults for Production Time Estimator (Indigo, semi-rotary, cutting, finishing, coating/slitting constants). */
schedulerRouter.get("/settings/time-estimator", async (_req, res) => {
  try {
    let row = await prisma.timeEstimatorSettings.findUnique({
      where: { key: SWITCH_FLOW_DEFAULTS_KEY },
    });
    if (!row) {
      row = await prisma.timeEstimatorSettings.create({
        data: {
          key: SWITCH_FLOW_DEFAULTS_KEY,
          label: "Switch time_v1_sscript flow defaults (README v2.2)",
          flowProperties: SWITCH_FLOW_DEFAULTS,
        },
      });
    }
    res.json(row);
  } catch (e) {
    console.error("scheduler GET /settings/time-estimator:", e);
    res.status(500).json({ error: "Failed to load time estimator settings" });
  }
});

/** Merge/dedupe: prefer (connectorId, externalId) when both set. */
schedulerRouter.get("/jobs", async (_req, res) => {
  try {
    const rows = await prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { machineSchedules: true },
    });

    const byKey = new Map<string, (typeof rows)[0]>();
    for (const job of rows) {
      const key =
        job.connectorId && job.externalId
          ? `${job.connectorId}:${job.externalId}`
          : job.id;
      byKey.set(key, job);
    }

    res.json(Array.from(byKey.values()));
  } catch (e) {
    console.error("scheduler GET /jobs:", e);
    const detail = e instanceof Error ? e.message : String(e);
    res.status(500).json({
      error: "Failed to list scheduler jobs",
      detail,
    });
  }
});

schedulerRouter.post("/jobs", async (req, res) => {
  try {
    const parsed = jobSwitchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const d = parsed.data;
    const job = await prisma.job.create({
      include: { machineSchedules: true },
      data: {
        source: "manual",
        pdfQty: d.pdfQty,
        material: compositeMaterialPrintColour(d.material, d.printColour),
        fileName: d.fileName ?? undefined,
        printColour: d.printColour,
        finishing: d.finishing,
        productionPath: d.productionPath,
        rollQty: d.rollQty ?? undefined,
        rollDirection: d.rollDirection ?? undefined,
        coreSizes: d.coreSizes ?? [],
        dueDate: d.dueDate ? new Date(d.dueDate) : undefined,
        labelWidthMm: d.labelWidthMm ?? undefined,
        labelHeightMm: d.labelHeightMm ?? undefined,
        labelGapMm: d.labelGapMm ?? undefined,
        labelsAcross: d.labelsAcross ?? undefined,
        rollLengthMetres: d.rollLengthMetres ?? undefined,
        overlaminateFilm: d.overlaminateFilm ?? undefined,
        forClient: d.forClient ?? undefined,
        copies: d.copies ?? undefined,
        dieNumberDigital: d.dieNumberDigital ?? undefined,
        plateHeightMm: d.plateHeightMm ?? undefined,
        switchDieInput: d.switchDieInput ?? undefined,
        switchEstimateOutput: d.switchEstimateOutput ?? undefined,
        timeEstimationStatus: d.timeEstimationStatus ?? undefined,
        timeEstimationError: d.timeEstimationError ?? undefined,
        timeEstimationAt: d.timeEstimationAt
          ? new Date(d.timeEstimationAt)
          : undefined,
      },
    });

    res.json(job);
  } catch (e) {
    console.error("scheduler POST /jobs:", e);
    res.status(500).json({ error: "Failed to create scheduler job" });
  }
});

schedulerRouter.patch("/jobs/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const parsed = patchJobScheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const existing = await prisma.job.findUnique({ where: { id: jobId } });
    if (!existing) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const { machineId, scheduledDate } = parsed.data;
    const machine = await prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine) {
      res.status(400).json({ error: "Machine not found" });
      return;
    }

    if (scheduledDate === null) {
      await prisma.jobMachineSchedule.deleteMany({
        where: { jobId, machineId },
      });
    } else {
      const d = new Date(scheduledDate);
      await prisma.jobMachineSchedule.upsert({
        where: {
          jobId_machineId: { jobId, machineId },
        },
        create: { jobId, machineId, scheduledDate: d },
        update: { scheduledDate: d },
      });
    }

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: { machineSchedules: true },
    });
    res.json(job);
  } catch (e) {
    console.error("scheduler PATCH /jobs/:jobId:", e);
    const detail = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: "Failed to update job schedule", detail });
  }
});

schedulerRouter.post("/estimate", async (req, res) => {
  try {
    const body = req.body as { jobIds?: string[] };
    const ids = body.jobIds ?? [];
    if (!ids.length) {
      res.status(400).json({ error: "jobIds required" });
      return;
    }

    const jobs = await prisma.job.findMany({ where: { id: { in: ids } } });
    const machines = await prisma.machine.findMany({
      orderBy: { sortOrder: "asc" },
      include: {
        operations: {
          orderBy: { sortOrder: "asc" },
          include: {
            params: { orderBy: { sortOrder: "asc" } },
            batchRule: true,
          },
        },
      },
    });

    const routingRow = await prisma.timeEstimatorSettings.findUnique({
      where: { key: SCHEDULER_ROUTING_KEY },
    });
    const routingParsed = routingRow?.flowProperties
      ? schedulerRoutingFlowSchema.safeParse(routingRow.flowProperties)
      : null;
    const routingFlow = routingParsed?.success ? routingParsed.data : null;

    const result = estimate({ jobs, machines, routingFlow });
    res.json(result);
  } catch (e) {
    console.error("scheduler POST /estimate:", e);
    res.status(500).json({ error: "Failed to estimate" });
  }
});
