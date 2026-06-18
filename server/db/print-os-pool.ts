import pg from "pg";
import dotenv from "dotenv";

import appPool from "./app-connection.js";
import { getPrintOsDatabaseUrl } from "./database-config.js";

dotenv.config();

const { Pool } = pg;

let dedicatedPool: pg.Pool | null = null;

/**
 * Pool for `"print OS"` reads. Uses `JOBMANAGER_DATABASE_URL` when set; otherwise the app pool.
 */
export function getPrintOsPool(): pg.Pool {
  const url = getPrintOsDatabaseUrl();
  if (!url) {
    return appPool;
  }
  if (!dedicatedPool) {
    dedicatedPool = new Pool({ connectionString: url });
    dedicatedPool.on("error", (err) => {
      console.error("Unexpected error on idle Print OS / jobmanager DB client", err);
    });
  }
  return dedicatedPool;
}
