/**
 * Quick DB check: `npm run test-connection`
 * Verifies LOGS_DATABASE_URL / LOGS_DB_* and DATABASE_URL / APP_DB_*.
 */
import dotenv from "dotenv";
import pg from "pg";

import { getAppDatabaseUrl, getLogsDatabaseUrl } from "./database-config.js";

dotenv.config();

async function ping(label: string, connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString });
  try {
    const r = await pool.query(
      "SELECT current_database() AS db, current_user AS role"
    );
    console.log(
      `[${label}] OK — connected to`,
      r.rows[0].db,
      "as",
      r.rows[0].role
    );
  } finally {
    await pool.end();
  }
}

void (async () => {
  try {
    await ping("logs", getLogsDatabaseUrl());
    await ping("app", getAppDatabaseUrl());
    process.exit(0);
  } catch (e) {
    console.error(
      "FAILED:",
      e instanceof Error ? e.message : e
    );
    process.exit(1);
  }
})();
