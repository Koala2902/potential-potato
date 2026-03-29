import pg from "pg";
import dotenv from "dotenv";

import { getLogsDatabaseUrl } from "./database-config.js";

dotenv.config();

const { Pool } = pg;

/** Real-time pipeline DB: scanned_codes, job_operation_duration, duration helpers. */
const logsPool = new Pool({
  connectionString: getLogsDatabaseUrl(),
});

logsPool.on("error", (err) => {
  console.error("Unexpected error on idle logs DB client", err);
});

export default logsPool;
export { logsPool };
