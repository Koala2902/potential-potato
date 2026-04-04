/**
 * Quick sanity check: app DB (processing_markers, scheduler) and pipeline DB (job_status views).
 * Pipeline = logs pool when LOGS_DATABASE_URL ≠ DATABASE_URL, else same as app.
 */
import dotenv from "dotenv";

import { appPool } from "./app-connection.js";
import logsPool from "./connection.js";
import { getAppDatabaseUrl, getLogsDatabaseUrl, isDedicatedLogsDatabase } from "./database-config.js";

dotenv.config();

async function tableExists(
  client: import("pg").PoolClient,
  schema: string,
  name: string
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, name]
  );
  return r.rows.length > 0;
}

async function viewExists(
  client: import("pg").PoolClient,
  schema: string,
  name: string
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.views
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, name]
  );
  return r.rows.length > 0;
}

async function main() {
  const appUrl = getAppDatabaseUrl();
  const logsUrl = getLogsDatabaseUrl();
  const dual = isDedicatedLogsDatabase();
  console.log("App DB URL:", appUrl.replace(/:[^:@/]+@/, ":****@"));
  console.log("Logs DB URL:", logsUrl.replace(/:[^:@/]+@/, ":****@"));
  console.log("Dual-DB mode:", dual, "\n");

  const appClient = await appPool.connect();
  try {
    const pm = await tableExists(appClient, "public", "processing_markers");
    const jobs = await tableExists(appClient, "public", "jobs");
    console.log("[app] public.processing_markers:", pm ? "ok" : "MISSING — run npm run run-migrations");
    console.log("[app] public.jobs (legacy):", jobs ? "ok" : "(optional)");
    const sch = await appClient.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'scheduler' AND (table_name = 'Job' OR table_name = 'job')`
    );
    console.log("[app] scheduler Job (Prisma):", sch.rows.length ? "ok" : "MISSING — run npm run prisma:push");
  } finally {
    appClient.release();
  }

  const pipePool = dual ? logsPool : appPool;
  const pipeLabel = dual ? "logs (pipeline)" : "app (single-DB)";
  const pipeClient = await pipePool.connect();
  try {
    const v1 = await viewExists(pipeClient, "public", "job_status_view");
    const v2 = await viewExists(pipeClient, "public", "job_status_runlist_view");
    console.log(`[${pipeLabel}] public.job_status_view:`, v1 ? "ok" : "MISSING — run npm run run-migrations");
    console.log(
      `[${pipeLabel}] public.job_status_runlist_view:`,
      v2 ? "ok" : "MISSING — run npm run run-migrations"
    );
  } finally {
    pipeClient.release();
  }

  await appPool.end();
  await logsPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
