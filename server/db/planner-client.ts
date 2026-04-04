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
 * | imposition_file_mapping | imposition_id, file_id, sequence_order (ORDER BY) |
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
 */
let loggedPlannerLogsOnly = false;

function plannerUseLogsOnly(): boolean {
    return process.env.PLANNER_USE_LOGS_ONLY?.trim() === "true";
}

function logPlannerLogsOnlyOnce(): void {
    if (loggedPlannerLogsOnly || !plannerUseLogsOnly()) return;
    loggedPlannerLogsOnly = true;
    console.warn(
        "[planner] PLANNER_USE_LOGS_ONLY=true — planner queries use LOGS_DATABASE_URL only (production_planner_paths, imposition_file_mapping, imposition_configurations)."
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
 * Planner tables: use app DB first unless PLANNER_USE_LOGS_ONLY=true (logs only);
 * on missing relation or unreachable app host, retry once on logs DB.
 */
export async function withPlannerClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    logPlannerLogsOnlyOnce();
    const run = async (pool: typeof appPool) => {
        const client = await pool.connect();
        try {
            return await fn(client);
        } finally {
            client.release();
        }
    };

    if (plannerUseLogsOnly()) {
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
 * Run planner reads on app first (unless PLANNER_USE_LOGS_ONLY=true). Retry on logs when:
 * - App throws missing-table / connection errors (same as {@link withPlannerClient}), or
 * - App succeeds but the result is "empty" per `isEmpty`, and {@link plannerUrlsDiffer} is true.
 */
export async function withPlannerAppThenLogsOnEmpty<T>(
    fn: (client: PoolClient) => Promise<T>,
    isEmpty: (result: T) => boolean
): Promise<T> {
    logPlannerLogsOnlyOnce();
    const run = async (pool: typeof appPool) => {
        const client = await pool.connect();
        try {
            return await fn(client);
        } finally {
            client.release();
        }
    };

    if (plannerUseLogsOnly()) {
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
