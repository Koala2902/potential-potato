/**
 * Copy the Prisma `scheduler` schema (structure + data) from one PostgreSQL database to another.
 *
 * Usage:
 *   tsx scripts/migrate-scheduler-to-db.ts
 *   tsx scripts/migrate-scheduler-to-db.ts --remove-from-source
 *
 * Required env:
 *   SCHEDULER_MIGRATE_FROM_URL  — full postgresql:// URL of the source database (must have schema `scheduler`)
 *   SCHEDULER_MIGRATE_TO_URL    — full postgresql:// URL of the target database
 *
 * Optional:
 *   POSTGRES_ADMIN_URL          — postgresql:// URL connected as a role that can CREATE DATABASE (e.g. .../postgres).
 *                                 If unset, the target database must already exist.
 */
import { execSync } from "node:child_process";

import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const TABLES_IN_FK_ORDER = [
  "Machine",
  "Connector",
  "TimeEstimatorSettings",
  "Operation",
  "OperationParam",
  "BatchRule",
  "MaterialOverride",
  "OperationDependency",
  "Job",
] as const;

function assertSafeDbName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid database name: ${name}`);
  }
  return name;
}

/** Extract database name from a postgresql:// connection string. */
function databaseNameFromPostgresUrl(url: string): string {
  const m = url.match(/\/\/(?:[^@]+@)?[^/:]+(?::\d+)?\/([^?]+)/);
  if (!m?.[1]) {
    throw new Error("Could not parse database name from URL");
  }
  return decodeURIComponent(m[1]);
}

function qTable(name: string): string {
  return `scheduler."${name.replace(/"/g, '""')}"`;
}

async function columnNames(
  pool: pg.Pool,
  tableName: string
): Promise<string[]> {
  const r = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scheduler' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );
  return r.rows.map((x) => x.column_name);
}

async function copyTable(
  source: pg.Pool,
  target: pg.Pool,
  tableName: string
): Promise<number> {
  const cols = await columnNames(source, tableName);
  if (cols.length === 0) {
    return 0;
  }
  const quotedCols = cols
    .map((c) => `"${c.replace(/"/g, '""')}"`)
    .join(", ");
  const fq = qTable(tableName);
  const { rows } = await source.query(`SELECT ${quotedCols} FROM ${fq}`);
  if (rows.length === 0) {
    return 0;
  }
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const insertSql = `INSERT INTO ${fq} (${quotedCols}) VALUES (${placeholders})`;
  await target.query("BEGIN");
  try {
    for (const row of rows) {
      const values = cols.map((c) => row[c]);
      await target.query(insertSql, values);
    }
    await target.query("COMMIT");
  } catch (e) {
    await target.query("ROLLBACK");
    throw e;
  }
  return rows.length;
}

async function schemaExists(pool: pg.Pool): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'scheduler'`
  );
  return r.rows.length > 0;
}

async function main() {
  const sourceUrl = process.env.SCHEDULER_MIGRATE_FROM_URL?.trim();
  const targetUrl = process.env.SCHEDULER_MIGRATE_TO_URL?.trim();
  if (!sourceUrl || !targetUrl) {
    throw new Error(
      "Set SCHEDULER_MIGRATE_FROM_URL and SCHEDULER_MIGRATE_TO_URL (full postgresql:// URLs)."
    );
  }

  const fromDb = databaseNameFromPostgresUrl(sourceUrl);
  const toDb = databaseNameFromPostgresUrl(targetUrl);
  const removeFromSource = process.argv.includes("--remove-from-source");

  console.log(
    `[migrate-scheduler] ${fromDb} → ${toDb}${removeFromSource ? " (then drop scheduler on source)" : ""}`
  );

  const adminUrl = process.env.POSTGRES_ADMIN_URL?.trim();
  if (adminUrl) {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      const safeTo = assertSafeDbName(toDb);
      const exists = await admin.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [safeTo]
      );
      if (exists.rows.length === 0) {
        await admin.query(`CREATE DATABASE ${safeTo}`);
        console.log(`[migrate-scheduler] Created database "${safeTo}".`);
      }
    } finally {
      await admin.end();
    }
  }

  const source = new pg.Pool({ connectionString: sourceUrl });
  const target = new pg.Pool({ connectionString: targetUrl });

  try {
    if (!(await schemaExists(source))) {
      throw new Error(
        `Source database "${fromDb}" has no schema "scheduler". Nothing to migrate.`
      );
    }

    await target.query("DROP SCHEMA IF EXISTS scheduler CASCADE");
    console.log(
      `[migrate-scheduler] Dropped scheduler on "${toDb}" (if existed) — recreating via Prisma…`
    );

    execSync("tsx scripts/prisma-with-env.ts db push", {
      stdio: "inherit",
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: targetUrl,
      },
    });

    console.log("[migrate-scheduler] Copying rows…");
    let total = 0;
    for (const table of TABLES_IN_FK_ORDER) {
      const colsSource = await columnNames(source, table);
      if (colsSource.length === 0) {
        console.log(`  ${table}: (skipped — not in source)`);
        continue;
      }
      const n = await copyTable(source, target, table);
      total += n;
      console.log(`  ${table}: ${n} rows`);
    }
    console.log(`[migrate-scheduler] Done. ${total} rows copied to "${toDb}".`);

    if (removeFromSource) {
      await source.query("DROP SCHEMA IF EXISTS scheduler CASCADE");
      console.log(
        `[migrate-scheduler] Dropped schema "scheduler" on source "${fromDb}".`
      );
    } else {
      console.log(
        `[migrate-scheduler] Source "${fromDb}" unchanged. Re-run with --remove-from-source to drop scheduler there.`
      );
    }
  } finally {
    await source.end();
    await target.end();
  }

  console.log(
    `[migrate-scheduler] Set DATABASE_URL to SCHEDULER_MIGRATE_TO_URL so the app uses the target database ("${toDb}").`
  );
}

main().catch((e) => {
  console.error(
    "[migrate-scheduler] FAILED:",
    e instanceof Error ? e.message : e
  );
  process.exit(1);
});
