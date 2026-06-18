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

/**
 * Legacy **jobmanager** database: on many installs `"print OS"` lives here while
 * Prisma + planner tables live on `DATABASE_URL`.
 *
 * When unset, `"print OS"` is read from the **app** pool (same as `DATABASE_URL`).
 * Set `JOBMANAGER_DATABASE_URL` (e.g. `…/jobmanager`) to match your Print OS location.
 */
export function getPrintOsDatabaseUrl(): string | null {
  const u = process.env.JOBMANAGER_DATABASE_URL?.trim();
  return u || null;
}

/**
 * When true (`PRINT_OS_CURSOR_USE_ROW_ID=true`): `processing_markers.print_os` stores the last `"print OS".id`,
 * polling uses `WHERE id > cursor ORDER BY id ASC`.
 * When false/unset: legacy `"print OS".marker` cursor.
 *
 * Cursor values are not interchangeable — after enabling, set `last_processed_id` from jobmanager `MAX(id)` once.
 */
export function printOsCursorUsesRowId(): boolean {
  const v = process.env.PRINT_OS_CURSOR_USE_ROW_ID?.trim().toLowerCase();
  return v === "true" || v === "1";
}

/** When true, skip Printbeat reads in production-status enrich (same DB pool as `"print OS"`). */
export function isPrintbeatRealtimeEnrichDisabled(): boolean {
  const v = process.env.PRINTBEAT_REALTIME_DISABLED?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/**
 * PostgreSQL identifier for the HP Printbeat realtime table (spaces allowed).
 * Override with PRINTBEAT_REALTIME_TABLE if your deployment uses a different name.
 */
export function getPrintbeatRealtimeTableSqlIdentifier(): string {
  const raw = process.env.PRINTBEAT_REALTIME_TABLE?.trim();
  const name = raw || 'Printbeat data Real time';
  return `"${name.replace(/"/g, '""')}"`;
}

/** Rows older than this are ignored as live press signal (minutes). */
export function getPrintbeatMaxAgeMinutes(): number {
  const n = parseInt(process.env.PRINTBEAT_MAX_AGE_MINUTES ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/**
 * Lowest Printbeat row `id` to consider (`WHERE id >= n`).Unset / invalid = no floor (0).
 * Use with test backfills from a known PK (e.g. 316298).
 */
export function getPrintbeatMinId(): number {
  const n = parseInt(process.env.PRINTBEAT_MIN_ID ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * When true: take the **next** Indigo Printbeat row with `id` greater than {@link processing_markers}
 * `processing_markers.printbeat_enrich` (ASC by id), then advance that marker. Ignores freshness window so
 * historical IDs work. Live mode stays default (false): latest row by `updated_at`, optional min id only.
 */
export function isPrintbeatIdMarkerSequentialEnabled(): boolean {
  const v = process.env.PRINTBEAT_USE_ID_MARKER?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** When true, skip Bladerunner cutter live reads for digital_cutter production-status enrich. */
export function isBladerunnerCutterLiveDisabled(): boolean {
  const v = process.env.BLADERUNNER_CUTTER_LIVE_DISABLED?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/**
 * PostgreSQL identifier for Bladerunner digital-cut live row (spaces allowed).
 * Override with BLADERUNNER_CUTTER_LIVE_TABLE if your deployment uses a different name.
 */
export function getBladerunnerCutterLiveTableSqlIdentifier(): string {
  const raw = process.env.BLADERUNNER_CUTTER_LIVE_TABLE?.trim();
  const name = raw || 'Bladerunner cutter live';
  return `"${name.replace(/"/g, '""')}"`;
}

/** Unquoted Postgres identifier (`FROM name`). Columns: `imposition_id`, `lm`. Override IMPOSITION_DURATION_VIEW_NAME. */
export function impositionDurationViewPlainIdentifier(): string {
  const raw = process.env.IMPOSITION_DURATION_VIEW_NAME?.trim().toLowerCase();
  if (raw && /^[a-z_][a-z0-9_]*$/.test(raw)) return raw;
  return 'imposition_duration_view';
}

/**
 * Transitional strict guards for op001 scan enrich. Disabled when set exactly to `false`.
 */
export function isOp001EnrichStrictGuardsEnabled(): boolean {
  return process.env.OP001_ENRICH_STRICT_GUARDS !== 'false';
}
