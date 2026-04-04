/**
 * Dual-database configuration: real-time pipeline (logs) vs app (Prisma + planner + jobs).
 * All connection strings come from environment — no database names or hosts hardcoded here.
 */

function missingVarMessage(name: string): string {
  return `Missing required environment variable: ${name}. See .env.example for LOGS_DATABASE_URL / DATABASE_URL (or LOGS_DB_* / APP_DB_*).`;
}

function requireTrimmed(name: string): string {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === "") {
    throw new Error(missingVarMessage(name));
  }
  return String(v).trim();
}

/**
 * Real-time pipeline: scanned_codes, job_operation_duration, duration SQL functions.
 *
 * If `LOGS_DATABASE_URL` / `LOGS_DB_*` are unset, uses `DATABASE_URL` so a single database
 * can serve both pools (common until you create a dedicated `logs` database).
 */
export function getLogsDatabaseUrl(): string {
  const url = process.env.LOGS_DATABASE_URL?.trim();
  if (url) return url;

  const host = process.env.LOGS_DB_HOST?.trim();
  const name = process.env.LOGS_DB_NAME?.trim();
  if (host && name) {
    const port = process.env.LOGS_DB_PORT?.trim() || "5432";
    const user = requireTrimmed("LOGS_DB_USER");
    const pass = process.env.LOGS_DB_PASSWORD ?? "";
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${name}`;
  }

  const appUrl = process.env.DATABASE_URL?.trim();
  if (appUrl) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        "[db] LOGS_DATABASE_URL (and LOGS_DB_*) unset — using DATABASE_URL for the logs pool."
      );
    }
    return appUrl;
  }

  throw new Error(
    "Set LOGS_DATABASE_URL, or LOGS_DB_HOST + LOGS_DB_NAME + LOGS_DB_USER, or DATABASE_URL for single-DB mode."
  );
}

/**
 * Application DB: Prisma `scheduler` schema (machines, operations), jobs, planner tables.
 */
export function getAppDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (url) return url;
  const host = requireTrimmed("APP_DB_HOST");
  const port = process.env.APP_DB_PORT?.trim() || "5432";
  const name = requireTrimmed("APP_DB_NAME");
  const user = requireTrimmed("APP_DB_USER");
  const pass = process.env.APP_DB_PASSWORD ?? "";
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${name}`;
}

/** True when logs and app use different connection strings (dual-DB mode). */
export function isDedicatedLogsDatabase(): boolean {
  try {
    return getLogsDatabaseUrl() !== getAppDatabaseUrl();
  } catch {
    return false;
  }
}
