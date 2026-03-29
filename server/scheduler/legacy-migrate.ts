import { Prisma } from "@prisma/client";

import { prisma } from "../db/prisma.js";

/**
 * Copy Prisma scheduler rows from legacy `public."Machine"` / `public.machine` into `scheduler`
 * when needed. Does **not** copy from `public.machines` — presses are defined only in
 * `scheduler.Machine` (Config / seed / migrate scripts), avoiding duplicate rows vs jobmanager-style tables.
 * Idempotent — safe to run on every GET /config/machines.
 *
 * Skips rows that would violate unique `Machine.name` (e.g. same name already created in `scheduler`
 * with a different id) or FKs (only copies operations whose `machineId` exists in `scheduler`).
 */
export async function migrateLegacySchedulerFromPublicIfNeeded(): Promise<void> {
  const hasPublicMachinePascal = await tableExists("public", "Machine");
  const hasPublicMachineLower = await tableExists("public", "machine");

  if (hasPublicMachinePascal || hasPublicMachineLower) {
    const machineFrom = hasPublicMachinePascal
      ? `public."Machine"`
      : `public.machine`;

    try {
      await prisma.$executeRawUnsafe(`
      INSERT INTO scheduler."Machine" (id, name, "displayName", enabled, "sortOrder", constants)
      SELECT p.id, p.name, p."displayName", p.enabled, p."sortOrder", COALESCE(p.constants, '{}'::jsonb)
      FROM ${machineFrom} p
      WHERE NOT EXISTS (SELECT 1 FROM scheduler."Machine" s WHERE s.id = p.id)
        AND NOT EXISTS (SELECT 1 FROM scheduler."Machine" s WHERE s.name = p.name)
    `);
    } catch (e) {
      console.warn("[scheduler] Machine sync from public failed:", e);
    }
  }

  const copyOp = (from: string) =>
    prisma.$executeRawUnsafe(`
      INSERT INTO scheduler."Operation" (id, "machineId", name, type, "sortOrder", enabled, notes, "calcFnKey")
      SELECT o.id, o."machineId", o.name, o.type, o."sortOrder", o.enabled, o.notes, o."calcFnKey"
      FROM ${from} o
      WHERE NOT EXISTS (SELECT 1 FROM scheduler."Operation" s WHERE s.id = o.id)
        AND EXISTS (SELECT 1 FROM scheduler."Machine" m WHERE m.id = o."machineId")
    `);

  if (await tableExists("public", "Operation")) {
    try {
      await copyOp(`public."Operation"`);
    } catch (e) {
      console.warn("[scheduler] Operation sync failed:", e);
    }
  } else if (await tableExists("public", "operation")) {
    try {
      await copyOp("public.operation");
    } catch (e) {
      console.warn("[scheduler] operation sync failed:", e);
    }
  }

  if (await tableExists("public", "OperationParam")) {
    try {
      await prisma.$executeRawUnsafe(`
        INSERT INTO scheduler."OperationParam" (id, "operationId", key, value, "valueType", label, unit, "isConfigurable", "sortOrder")
        SELECT p.id, p."operationId", p.key, p.value, p."valueType", p.label, p.unit, p."isConfigurable", p."sortOrder"
        FROM public."OperationParam" p
        WHERE NOT EXISTS (SELECT 1 FROM scheduler."OperationParam" s WHERE s.id = p.id)
          AND EXISTS (SELECT 1 FROM scheduler."Operation" o WHERE o.id = p."operationId")
      `);
    } catch (e) {
      console.warn("[scheduler] OperationParam sync failed:", e);
    }
  }

  if (await tableExists("public", "BatchRule")) {
    try {
      await prisma.$executeRawUnsafe(`
        INSERT INTO scheduler."BatchRule" (id, "operationId", scope, "groupByFields", "appliesOnce", "thresholdValue", "routeToMachine", "conditionExpr")
        SELECT b.id, b."operationId", b.scope, b."groupByFields", b."appliesOnce", b."thresholdValue", b."routeToMachine", b."conditionExpr"
        FROM public."BatchRule" b
        WHERE NOT EXISTS (SELECT 1 FROM scheduler."BatchRule" s WHERE s.id = b.id)
          AND EXISTS (SELECT 1 FROM scheduler."Operation" o WHERE o.id = b."operationId")
      `);
    } catch (e) {
      console.warn("[scheduler] BatchRule sync failed:", e);
    }
  }
}

/** Debug: counts for support / UI diagnostics */
export async function getSchedulerSyncDiagnostics(): Promise<{
  database: string;
  schedulerMachineCount: number;
  schedulerOperationCount: number;
  publicMachineCount: number | null;
}> {
  const dbRows = await prisma.$queryRaw<{ db: string }[]>(Prisma.sql`
    SELECT current_database() AS db
  `);
  const database = dbRows[0]?.db ?? "(unknown)";

  const schedulerMachineCount = await prisma.machine.count();
  const schedulerOperationCount = await prisma.operation.count();

  let publicMachineCount: number | null = null;
  try {
    if (await tableExists("public", "Machine")) {
      const c = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS n FROM public."Machine"
      `);
      publicMachineCount = Number(c[0]?.n ?? 0);
    } else if (await tableExists("public", "machine")) {
      const c = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS n FROM public.machine
      `);
      publicMachineCount = Number(c[0]?.n ?? 0);
    } else if (await tableExists("public", "machines")) {
      const c = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS n FROM public.machines
      `);
      publicMachineCount = Number(c[0]?.n ?? 0);
    }
  } catch {
    publicMachineCount = null;
  }

  return { database, schedulerMachineCount, schedulerOperationCount, publicMachineCount };
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ exists: boolean }>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${schema}
        AND table_name = ${table}
    ) AS exists
  `);
  return Boolean(rows[0]?.exists);
}
