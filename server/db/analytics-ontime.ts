import type pg from 'pg';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

import { getPrintOsPool } from './print-os-pool.js';

/** Business calendar timezone for order-date deadlines. */
const BUSINESS_TIMEZONE = 'Australia/Sydney';

/** Default allowance when `businessDays` query param is omitted. */
export const DEFAULT_ON_TIME_BUSINESS_DAYS = 5;

/** Production-finished (op004) or slitter (op003 / op006) marks production done. */
const PRODUCTION_DONE_OPERATIONS = ['op003', 'op004', 'op006'] as const;

export interface JobmanagerOnTimeJobRow {
    jobId: string;
    logsJobId: string;
    /** When the order was created in jobmanager (`created_at`, else start of `order_date`). */
    orderAt: Date;
    dueDate: Date | null;
    materialName: string | null;
}

export interface OnTimeJobRow {
    jobId: string;
    externalId: string;
    /** Order placed at (`public.jobs.created_at`). */
    orderAt: string;
    dueDate: string | null;
    /** End of allowed window (Sydney order day + business days allowance). */
    allowedUntil: string;
    productionDoneAt: string;
    /** Hours past deadline; 0 when on time. */
    hoursLate: number;
    material: string | null;
    status: 'on_time' | 'late';
}

/** @deprecated Use OnTimeJobRow — kept as alias for existing imports. */
export type OnTimeLateJobRow = OnTimeJobRow;

export interface OnTimeMetrics {
    businessDaysAllowance: number;
    totalDue: number;
    onTime: number;
    late: number;
    onTimePercent: number | null;
    /** Finished jobs in range (capped), late first then by order date. */
    jobs: OnTimeJobRow[];
}

/**
 * Logs `job_operation_duration.job_id` uses `{jobNumber}_{line}` (no Labex prefix, no leading zeros on job number).
 */
export function jobmanagerToLogsJobId(
    jobNumber: string,
    lineIdentifierNoPrefix: string | null
): string {
    const n = String(parseInt(String(jobNumber).trim(), 10));
    if (!Number.isFinite(Number(n)) || n === 'NaN') {
        return '';
    }
    const line = lineIdentifierNoPrefix?.trim();
    if (line) {
        return `${n}_${line}`;
    }
    return n;
}

/**
 * Sydney calendar day (as UTC date parts) for an order instant.
 */
export function sydneyCalendarDayUtc(orderAt: Date): Date {
    const syd = toZonedTime(orderAt, BUSINESS_TIMEZONE);
    return new Date(Date.UTC(syd.getFullYear(), syd.getMonth(), syd.getDate()));
}

/**
 * End of the Sydney day that is `businessDays` weekdays after the order's Sydney calendar day.
 */
export function endOfBusinessDeadlineFromOrderAtUtc(orderAt: Date, businessDays: number): Date {
    return endOfBusinessDeadlineUtc(sydneyCalendarDayUtc(orderAt), businessDays);
}

/**
 * End of the Sydney calendar day for a Postgres `date` (UTC date parts = calendar day).
 */
export function endOfSydneyDayUtc(dateOnly: Date): Date {
    const y = dateOnly.getUTCFullYear();
    const m = dateOnly.getUTCMonth();
    const d = dateOnly.getUTCDate();
    const wall = new Date(y, m, d, 23, 59, 59, 999);
    return fromZonedTime(wall, BUSINESS_TIMEZONE);
}

/**
 * End of the Sydney day that is `businessDays` weekdays after `orderDate` (order day not counted).
 * `businessDays === 0` → end of the order date itself.
 */
export function endOfBusinessDeadlineUtc(orderDate: Date, businessDays: number): Date {
    const days = Math.max(0, Math.floor(businessDays));
    if (days === 0) {
        return endOfSydneyDayUtc(orderDate);
    }

    const syd = toZonedTime(orderDate, BUSINESS_TIMEZONE);
    let counted = 0;
    while (counted < days) {
        syd.setDate(syd.getDate() + 1);
        const dow = syd.getDay();
        if (dow !== 0 && dow !== 6) {
            counted++;
        }
    }
    const wall = new Date(
        syd.getFullYear(),
        syd.getMonth(),
        syd.getDate(),
        23,
        59,
        59,
        999
    );
    return fromZonedTime(wall, BUSINESS_TIMEZONE);
}

export function parseBusinessDaysAllowance(raw: unknown): number {
    if (raw == null || raw === '') {
        return DEFAULT_ON_TIME_BUSINESS_DAYS;
    }
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    if (!Number.isFinite(n)) {
        return DEFAULT_ON_TIME_BUSINESS_DAYS;
    }
    return Math.min(60, Math.max(0, Math.floor(n)));
}

/**
 * Normalise op001 (Sydney wall) and op002+ (UTC naive) completion timestamps to UTC.
 * Same rules as analytics-api `tzNormalizedColumn`.
 */
export function tzNormalizedCompletedAtSql(alias: string): string {
    return `(CASE
        WHEN ${alias}.operation_id = 'op001'
            THEN ${alias}.operation_completed_at AT TIME ZONE 'Australia/Sydney'
        ELSE ${alias}.operation_completed_at AT TIME ZONE 'UTC'
    END)`;
}

/**
 * Earliest completion among op004 (production finished) and slitter ops (op003, op006).
 */
export async function fetchProductionDoneByLogsJobId(
    logsClient: pg.PoolClient,
    logsJobIds: string[]
): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (logsJobIds.length === 0) {
        return out;
    }

    const completedExpr = tzNormalizedCompletedAtSql('jod');
    const result = await logsClient.query<{ job_id: string; production_done_at: Date }>(
        `WITH normalized AS (
            SELECT
                jod.job_id,
                ${completedExpr} AS completed_at
            FROM job_operation_duration jod
            WHERE jod.operation_id = ANY($2::text[])
              AND jod.operation_completed_at IS NOT NULL
              AND jod.job_id = ANY($1::text[])
        )
        SELECT job_id, MIN(completed_at) AS production_done_at
        FROM normalized
        GROUP BY job_id`,
        [logsJobIds, PRODUCTION_DONE_OPERATIONS]
    );

    for (const row of result.rows) {
        if (row.production_done_at) {
            out.set(String(row.job_id), new Date(row.production_done_at));
        }
    }
    return out;
}

/**
 * Jobs from jobmanager ordered in [from, to] by `created_at` (falls back to `order_date`).
 */
export async function fetchJobmanagerJobsForOnTime(
    from: Date,
    to: Date
): Promise<JobmanagerOnTimeJobRow[]> {
    const pool = getPrintOsPool();
    const client = await pool.connect();
    try {
        const exists = await client.query<{ reg: string | null }>(
            `SELECT to_regclass('public.jobs')::text AS reg`
        );
        if (!exists.rows[0]?.reg) {
            console.warn(
                '[analytics-ontime] public.jobs not found — set JOBMANAGER_DATABASE_URL to the jobmanager database.'
            );
            return [];
        }

        const hasCreatedAt = await client.query<{ exists: boolean }>(
            `SELECT EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'jobs'
                  AND column_name = 'created_at'
            ) AS exists`
        );
        const orderAtExpr = hasCreatedAt.rows[0]?.exists
            ? 'COALESCE(j.created_at, j.order_date::timestamptz)'
            : 'j.order_date::timestamptz';

        const result = await client.query<{
            job_id: string;
            job_number: string;
            line_identifier_no_prefix: string | null;
            order_at: Date;
            due_date: Date | null;
            material_name: string | null;
        }>(
            `SELECT
                j.job_id,
                j.job_number,
                j.line_identifier_no_prefix,
                ${orderAtExpr} AS order_at,
                j.due_date,
                j.material_name
             FROM public.jobs j
             WHERE ${orderAtExpr} IS NOT NULL
               AND ${orderAtExpr} >= $1::timestamptz
               AND ${orderAtExpr} <= $2::timestamptz`,
            [from.toISOString(), to.toISOString()]
        );

        const rows: JobmanagerOnTimeJobRow[] = [];
        for (const row of result.rows) {
            const logsJobId = jobmanagerToLogsJobId(
                row.job_number,
                row.line_identifier_no_prefix
            );
            if (!logsJobId || !row.order_at) continue;
            rows.push({
                jobId: String(row.job_id),
                logsJobId,
                orderAt: new Date(row.order_at),
                dueDate: row.due_date,
                materialName: row.material_name,
            });
        }
        return rows;
    } finally {
        client.release();
    }
}

/** Max rows returned in the on-time production job list. */
const ON_TIME_JOBS_LIST_CAP = 200;

/**
 * On-time when production finishes on or before order time + `businessDaysAllowance` weekdays.
 * Unfinished jobs are excluded from the denominator.
 */
export function computeOnTimeMetrics(
    jobs: JobmanagerOnTimeJobRow[],
    productionDoneByLogsJobId: Map<string, Date>,
    businessDaysAllowance: number
): OnTimeMetrics {
    const finishedJobs: OnTimeJobRow[] = [];
    let onTime = 0;
    let late = 0;
    let totalDue = 0;
    const allowance = parseBusinessDaysAllowance(businessDaysAllowance);

    for (const job of jobs) {
        if (!job.orderAt) continue;
        const productionDoneAt = productionDoneByLogsJobId.get(job.logsJobId);
        if (!productionDoneAt) continue;

        totalDue++;
        const deadline = endOfBusinessDeadlineFromOrderAtUtc(job.orderAt, allowance);
        const diffMs = productionDoneAt.getTime() - deadline.getTime();

        const orderAtIso = job.orderAt.toISOString();
        const dueDateIso = job.dueDate?.toISOString().slice(0, 10) ?? null;
        const isLate = diffMs > 0;
        const hoursLate = isLate ? Math.round((diffMs / 3_600_000) * 10) / 10 : 0;

        if (isLate) {
            late++;
        } else {
            onTime++;
        }

        finishedJobs.push({
            jobId: job.jobId,
            externalId: job.logsJobId,
            orderAt: orderAtIso,
            dueDate: dueDateIso,
            allowedUntil: deadline.toISOString(),
            productionDoneAt: productionDoneAt.toISOString(),
            hoursLate,
            material: job.materialName,
            status: isLate ? 'late' : 'on_time',
        });
    }

    finishedJobs.sort((a, b) => {
        if (a.status !== b.status) {
            return a.status === 'late' ? -1 : 1;
        }
        if (a.status === 'late') {
            return b.hoursLate - a.hoursLate;
        }
        return b.orderAt.localeCompare(a.orderAt);
    });

    return {
        businessDaysAllowance: allowance,
        totalDue,
        onTime,
        late,
        onTimePercent: totalDue > 0 ? Math.round((onTime / totalDue) * 1000) / 10 : null,
        jobs: finishedJobs.slice(0, ON_TIME_JOBS_LIST_CAP),
    };
}
