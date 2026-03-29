/**
 * Copy presses and operations from jobmanager into `scheduler.Machine` / `scheduler.Operation`
 * on DATABASE_URL (productioncapacity / app DB).
 *
 * - Operation ids are normalized to lowercase (op001).
 * - `machineId` on operations is rewritten by matching **machine_name** between source and target
 *   (case-insensitive, trimmed) so names tie operations to the correct press when IDs differ.
 *
 * Run: npm run run-migrations   then   npm run migrate-jobmanager-tables
 *
 * Source URL: JOBMANAGER_DATABASE_URL, or same URL as DATABASE_URL with database `jobmanager`.
 */
import dotenv from "dotenv";
import pg from "pg";

import { prisma } from "../server/db/prisma.js";

dotenv.config();

/** Legacy DB on the same cluster is often literally named `jobmanager`. */
function resolveJobmanagerDatabaseUrl(): string {
  const explicit = process.env.JOBMANAGER_DATABASE_URL?.trim();
  if (explicit) {
    return explicit;
  }
  const app = process.env.DATABASE_URL?.trim();
  if (!app) {
    throw new Error(
      "Set DATABASE_URL, or JOBMANAGER_DATABASE_URL for the legacy jobmanager database."
    );
  }
  try {
    const u = new URL(app);
    u.pathname = "/jobmanager";
    return u.toString();
  } catch {
    throw new Error(
      "Could not derive jobmanager URL from DATABASE_URL; set JOBMANAGER_DATABASE_URL explicitly."
    );
  }
}

async function tableExists(
  pool: pg.Pool,
  schema: string,
  table: string
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  return r.rows.length > 0;
}

function normalizeMachineName(name: unknown): string {
  if (name == null) return "";
  return String(name).trim().toLowerCase().replace(/\s+/g, " ");
}

/** Source machine_id → machine_name (jobmanager). */
async function loadSourceMachineNames(
  source: pg.Pool
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!(await tableExists(source, "public", "machines"))) {
    return map;
  }
  const { rows } = await source.query<{
    machine_id: string;
    machine_name: string | null;
  }>(
    `SELECT machine_id::text AS machine_id, machine_name FROM public.machines`
  );
  for (const r of rows) {
    map.set(String(r.machine_id).trim(), r.machine_name != null ? String(r.machine_name) : "");
  }
  return map;
}

/** Normalized display/name → target scheduler.Machine id (first wins). */
async function loadTargetNameToMachineId(): Promise<Map<string, string>> {
  const rows = await prisma.machine.findMany({
    select: { id: true, name: true, displayName: true },
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
  });
  const map = new Map<string, string>();
  for (const r of rows) {
    for (const label of [r.displayName, r.name]) {
      const key = normalizeMachineName(label);
      if (!key) continue;
      if (!map.has(key)) {
        map.set(key, r.id);
      }
    }
  }
  return map;
}

function remapOperationMachineId(
  oldMachineId: unknown,
  sourceIdToName: Map<string, string>,
  targetNameToId: Map<string, string>
): string | null {
  if (oldMachineId == null || String(oldMachineId).trim() === "") {
    return null;
  }
  const oid = String(oldMachineId).trim();
  const name = sourceIdToName.get(oid);
  if (name === undefined) {
    return null;
  }
  const key = normalizeMachineName(name);
  if (!key) {
    return null;
  }
  const newId = targetNameToId.get(key);
  return newId ?? null;
}

async function upsertMachinesFromSource(source: pg.Pool): Promise<number> {
  if (!(await tableExists(source, "public", "machines"))) {
    console.warn("[migrate-jobmanager] Source has no public.machines — skipping machines.");
    return 0;
  }
  const { rows } = await source.query<{
    machine_id: string;
    machine_name: string | null;
    machine_type: string | null;
    availability_status: string | null;
  }>(
    `SELECT machine_id::text AS machine_id, machine_name, machine_type, availability_status
     FROM public.machines
     ORDER BY machine_name NULLS LAST, machine_id`
  );
  if (rows.length === 0) {
    return 0;
  }
  const maxSo = await prisma.machine.aggregate({ _max: { sortOrder: true } });
  let nextOrder = (maxSo._max.sortOrder ?? -1) + 1;
  let n = 0;
  for (const p of rows) {
    const id = String(p.machine_id).trim();
    const displayName = String(
      p.machine_name?.trim() || id
    );
    const enabled =
      String(p.availability_status || "").toLowerCase() !== "inactive";
    await prisma.machine.upsert({
      where: { id },
      create: {
        id,
        name: id,
        displayName,
        sortOrder: nextOrder++,
        enabled,
        constants: {},
      },
      update: {
        displayName,
        enabled,
      },
    });
    n++;
  }
  console.log(`[migrate-jobmanager] scheduler.Machine: upserted ${n} row(s).`);
  return n;
}

async function upsertOperationsFromSource(
  source: pg.Pool,
  sourceIdToName: Map<string, string>,
  targetNameToId: Map<string, string>
): Promise<number> {
  if (!(await tableExists(source, "public", "operations"))) {
    console.warn("[migrate-jobmanager] Source has no public.operations — skipping operations.");
    return 0;
  }
  const { rows } = await source.query<{
    operation_id: string;
    operation_name: string | null;
    machine_id: string | null;
    operation_category: string | null;
    description: string | null;
  }>(
    `SELECT operation_id::text AS operation_id, operation_name, machine_id::text AS machine_id,
            operation_category, description
     FROM public.operations
     ORDER BY machine_id NULLS LAST, operation_id`
  );
  if (rows.length === 0) {
    return 0;
  }

  let unmappedMachine = 0;
  let remapped = 0;
  let inserted = 0;

  const byMachine = new Map<string, typeof rows>();
  for (const row of rows) {
    const mid = row.machine_id;
    const key = mid ?? "";
    if (!byMachine.has(key)) {
      byMachine.set(key, []);
    }
    byMachine.get(key)!.push(row);
  }

  for (const row of rows) {
    const rawMid = row.machine_id;
    const mapped = remapOperationMachineId(
      rawMid,
      sourceIdToName,
      targetNameToId
    );
    if (
      rawMid != null &&
      String(rawMid).trim() !== "" &&
      mapped == null
    ) {
      unmappedMachine++;
      console.warn(
        `[migrate-jobmanager] ${String(row.operation_id)}: could not map machine_id "${String(rawMid)}" (source name → target id). Skipping.`
      );
      continue;
    }
    if (
      mapped != null &&
      rawMid != null &&
      String(mapped) !== String(rawMid).trim()
    ) {
      remapped++;
    }
    if (mapped == null) {
      unmappedMachine++;
      continue;
    }

    const opId = String(row.operation_id).toLowerCase();
    const group = byMachine.get(row.machine_id ?? "") ?? [];
    const sortOrder =
      group.findIndex((r) => r.operation_id === row.operation_id) + 1;

    await prisma.operation.upsert({
      where: { id: opId },
      create: {
        id: opId,
        machineId: mapped,
        name: String(row.operation_name ?? row.operation_id),
        type: String(row.operation_category?.trim() || "production"),
        sortOrder,
        enabled: true,
        notes: row.description ?? undefined,
      },
      update: {
        machineId: mapped,
        name: String(row.operation_name ?? row.operation_id),
        type: String(row.operation_category?.trim() || "production"),
        sortOrder,
        notes: row.description ?? undefined,
      },
    });
    inserted++;
  }

  console.log(
    `[migrate-jobmanager] scheduler.Operation: upserted ${inserted} row(s); machine_id remapped ${remapped} time(s); ${unmappedMachine} row(s) skipped (unmapped machine).`
  );
  return inserted;
}

async function main(): Promise<void> {
  const sourceUrl = resolveJobmanagerDatabaseUrl();
  const targetUrl = process.env.DATABASE_URL?.trim();
  if (!targetUrl) {
    throw new Error("Set DATABASE_URL (target app database).");
  }

  const srcLabel = process.env.JOBMANAGER_DATABASE_URL?.trim()
    ? "JOBMANAGER_DATABASE_URL"
    : "DATABASE_URL → …/jobmanager";
  console.log(
    `[migrate-jobmanager] Source (${srcLabel}) → DATABASE_URL: scheduler.Machine, then scheduler.Operation`
  );

  const source = new pg.Pool({ connectionString: sourceUrl });

  try {
    await upsertMachinesFromSource(source);

    const sourceIdToName = await loadSourceMachineNames(source);
    const targetNameToId = await loadTargetNameToMachineId();
    console.log(
      `[migrate-jobmanager] Name map: ${sourceIdToName.size} source machine row(s), ${targetNameToId.size} distinct name(s) on target.`
    );

    await upsertOperationsFromSource(source, sourceIdToName, targetNameToId);
    console.log("[migrate-jobmanager] Done.");
  } finally {
    await source.end();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
