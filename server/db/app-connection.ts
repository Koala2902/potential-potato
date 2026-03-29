import pg from "pg";
import dotenv from "dotenv";

import { getAppDatabaseUrl } from "./database-config.js";

dotenv.config();

const { Pool } = pg;

/** Raw SQL against the app database (same target as Prisma `DATABASE_URL`). */
export const appPool = new Pool({
  connectionString: getAppDatabaseUrl(),
});

appPool.on("error", (err) => {
  console.error("Unexpected error on idle app DB client", err);
});

export default appPool;
