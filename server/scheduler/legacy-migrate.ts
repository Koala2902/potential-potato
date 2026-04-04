import { Prisma } from "@prisma/client";

import { prisma } from "../db/prisma.js";

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
