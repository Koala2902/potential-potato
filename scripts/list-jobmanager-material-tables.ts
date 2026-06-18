/**
 * List public tables on the jobmanager / Print OS database whose names contain "material",
 * plus columns and primary-key hints. Uses JOBMANAGER_DATABASE_URL, or DATABASE_URL with DB name jobmanager.
 *
 * Usage: npx tsx scripts/list-jobmanager-material-tables.ts
 * Optional: npx tsx scripts/list-jobmanager-material-tables.ts --sample (adds LIMIT 3 row samples)
 */
import dotenv from "dotenv";
import pg from "pg";

import { resolveJobmanagerDatabaseUrl } from "./jobmanager-url.js";

dotenv.config();

const { Pool } = pg;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function main() {
  const wantSample = process.argv.includes("--sample");
  const url = resolveJobmanagerDatabaseUrl();
  const pool = new Pool({ connectionString: url });

  try {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
         AND table_name ILIKE '%material%'
       ORDER BY table_name`
    );

    if (tables.rows.length === 0) {
      console.log("No public base tables matched ILIKE '%material%'.");
      return;
    }

    for (const { table_name } of tables.rows) {
      console.log("\n===", table_name, "===");
      const cols = await pool.query(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [table_name]
      );
      console.table(cols.rows);

      const pk = await pool.query(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.table_schema = 'public'
           AND tc.table_name = $1
           AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY kcu.ordinal_position`,
        [table_name]
      );
      console.log(
        "PRIMARY KEY:",
        pk.rows.length ? pk.rows.map((r) => r.column_name).join(", ") : "(none in information_schema)"
      );

      if (wantSample) {
        const q = `SELECT * FROM public.${quoteIdent(table_name)} LIMIT 3`;
        try {
          const sample = await pool.query(q);
          console.log("Sample rows:", JSON.stringify(sample.rows, null, 2));
        } catch (e) {
          console.warn("Sample query failed:", e);
        }
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
