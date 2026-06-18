import type { PoolClient } from "pg";
import logsPool from "./connection.js";
import { appPool } from "./app-connection.js";
import { getAppDatabaseUrl, getLogsDatabaseUrl } from "./database-config.js";
import { isUndefinedTableError } from "./pg-errors.js";

/**
 * Planner / scan SQL touches these tables (public schema unless you use search_path):
 *
 * | Table | Columns used in scan + queue |
 * |-------|--------------------------------|
 * | production_planner_paths | runlist_id, imposition_id |
 * | imposition_file_mapping | imposition_id, file_id, sequence_order (ORDER BY) — **logs DB only** ({@link withImpositionFileMappingClient}) |
 * | imposition_configurations | imposition_id, sheet_width, explanation, pdf_quantity, exact, layout_across, sheet_height |
 *
 * findRunlistByScan flow:
 * 1) WHERE runlist_id = $scan (exact)
 * 2) JOIN: ifm.file_id = $scan (exact barcode file_id) → ppp.runlist_id
 * 3) JOIN: ifm.file_id LIKE '%Labex_$scan%' (short QR, e.g. scan 5475_7066 vs DB Labex_5475_7066)
 * 4) WHERE runlist_id LIKE $scan% OR LIKE %$scan% (single row only; multiple → null)
 * 5) JOIN: ifm.file_id LIKE 'FILE_{version}_Labex_{jobId}_%' when scan has ≥3 _-segments (job_id_version_tag);
 *    then loose FILE_%_Labex_{jobId}_%, then LIKE '%Labex_{jobId}%' (imposition_file_mapping)
 *
 * Set PLANNER_USE_LOGS_ONLY=true to run all of the above only against LOGS_DATABASE_URL (debug).
 *
 * When `LOGS_DATABASE_URL` ≠ `DATABASE_URL` (dual-DB), planner tables are read from the **logs**
 * pool by default (no app attempt — avoids noise when planner data only exists on logs).
 * Set `PLANNER_USE_APP_PLANNER=true` to restore app-first + fallback (legacy).
 */
let loggedPlannerLogsOnly = false;
let loggedPlannerDualDbLogsDefault = false;

function plannerUseLogsOnly(): boolean {
    return process.env.PLANNER_USE_LOGS_ONLY?.trim() === "true";
}

/** Opt in to querying planner tables on the app DB first (dual-DB only). */
function plannerUseAppPlannerFirst(): boolean {
    return process.env.PLANNER_USE_APP_PLANNER?.trim() === "true";
}

/** Use logs pool for all planner reads without touching the app pool. */
function useLogsForPlannerWithoutAppTry(): boolean {
    if (plannerUseLogsOnly()) return true;
    if (plannerUrlsDiffer() && !plannerUseAppPlannerFirst()) {
        return true;
    }
    return false;
}

function logPlannerLogsOnlyOnce(): void {
    if (loggedPlannerLogsOnly || !plannerUseLogsOnly()) return;
    loggedPlannerLogsOnly = true;
    console.warn(
        "[planner] PLANNER_USE_LOGS_ONLY=true — planner queries use LOGS_DATABASE_URL only (production_planner_paths, imposition_file_mapping, imposition_configurations)."
    );
}

function logPlannerDualDbUsesLogsOnce(): void {
    if (loggedPlannerDualDbLogsDefault || !plannerUrlsDiffer() || plannerUseAppPlannerFirst()) return;
    if (plannerUseLogsOnly()) return;
    loggedPlannerDualDbLogsDefault = true;
    console.warn(
        "[planner] Dual-DB: planner tables read from LOGS_DATABASE_URL only. Set PLANNER_USE_APP_PLANNER=true to try app DB first."
    );
}

/** True when app and logs pools use different connection strings (dual-DB mode). */
export function plannerUrlsDiffer(): boolean {
    try {
        return getAppDatabaseUrl() !== getLogsDatabaseUrl();
    } catch {
        return false;
    }
}

/**
 * Pool for SQL that reads `production_planner_paths`, `imposition_configurations`, etc.
 * (not `imposition_file_mapping` — use {@link withImpositionFileMappingClient} for that table.)
 * Matches {@link withPlannerClient} / dual-DB logs-default behavior.
 */
export function getPlannerReadPool(): typeof appPool {
    logPlannerLogsOnlyOnce();
    logPlannerDualDbUsesLogsOnce();
    if (useLogsForPlannerWithoutAppTry()) {
        return logsPool;
    }
    return appPool;
}

function shouldFallbackPlannerToLogs(err: unknown): boolean {
    if (isUndefinedTableError(err)) return true;
    const code =
        typeof err === "object" && err !== null && "code" in err
            ? (err as { code?: string }).code
            : undefined;
    return (
        code === "ECONNREFUSED" ||
        code === "ETIMEDOUT" ||
        code === "ENOTFOUND" ||
        code === "EAI_AGAIN"
    );
}

/**
 * Planner tables: dual-DB defaults to logs only ({@link useLogsForPlannerWithoutAppTry});
 * single-DB uses app pool. Legacy app-first: set `PLANNER_USE_APP_PLANNER=true`.
 */
export async function withPlannerClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    logPlannerLogsOnlyOnce();
    logPlannerDualDbUsesLogsOnce();
    const run = async (pool: typeof appPool) => {
        const client = await pool.connect();
        try {
            return await fn(client);
        } finally {
            client.release();
        }
    };

    if (useLogsForPlannerWithoutAppTry()) {
        return run(logsPool);
    }

    try {
        return await run(appPool);
    } catch (e) {
        if (shouldFallbackPlannerToLogs(e)) {
            console.warn(
                "[planner] App DB missing planner tables or unreachable — retrying on logs DB."
            );
            return run(logsPool);
        }
        throw e;
    }
}

/**
 * Same pool selection as {@link withPlannerClient}. When app-first is enabled (rare), retries on logs
 * on error or empty result.
 */
export async function withPlannerAppThenLogsOnEmpty<T>(
    fn: (client: PoolClient) => Promise<T>,
    isEmpty: (result: T) => boolean
): Promise<T> {
    logPlannerLogsOnlyOnce();
    logPlannerDualDbUsesLogsOnce();
    const run = async (pool: typeof appPool) => {
        const client = await pool.connect();
        try {
            return await fn(client);
        } finally {
            client.release();
        }
    };

    if (useLogsForPlannerWithoutAppTry()) {
        return run(logsPool);
    }

    let first: T | undefined;
    try {
        first = await run(appPool);
        if (!isEmpty(first)) {
            return first;
        }
    } catch (e) {
        if (shouldFallbackPlannerToLogs(e)) {
            console.warn(
                "[planner] App DB missing planner tables or unreachable — retrying on logs DB."
            );
            return run(logsPool);
        }
        throw e;
    }

    if (plannerUrlsDiffer()) {
        console.warn("[planner] Empty result on app DB — retrying planner query on logs DB.");
        return run(logsPool);
    }

    return first as T;
}

/**
 * `imposition_file_mapping` is read only from LOGS_DATABASE_URL (never the app DB), including joins
 * to `production_planner_paths` / `imposition_configurations` on the same host.
 */
export async function withImpositionFileMappingClient<T>(
    fn: (client: PoolClient) => Promise<T>
): Promise<T> {
    const client = await logsPool.connect();
    try {
        return await fn(client);
    } finally {
        client.release();
    }
}
