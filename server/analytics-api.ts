import { Router } from 'express';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

import {
    computeOnTimeMetrics,
    fetchJobmanagerJobsForOnTime,
    fetchProductionDoneByLogsJobId,
    parseBusinessDaysAllowance,
} from './db/analytics-ontime.js';
import { appPool } from './db/app-connection.js';
import logsPool from './db/connection.js';
import { prisma } from './db/prisma.js';
import { isDedicatedLogsDatabase } from './db/database-config.js';
import {
    IN_PROGRESS_LANE_FUNNEL_ORDER,
    JOB_STATUS_VIEW_IN_PROGRESS_WHERE_SQL,
    JOB_STATUS_VIEW_LANE_SQL,
} from '../src/lib/job-operation-lane-sql';

/** Business calendar timezone. Mirrors the op001 normalisation in server/index.ts. */
const BUSINESS_TIMEZONE = 'Australia/Sydney';

export const analyticsRouter = Router();

/** Same pattern as `poolForJobPipelineViews()` in jobmanager-queries.ts: logs DB when distinct. */
function poolForJobPipelineViews(): typeof appPool {
    return isDedicatedLogsDatabase() ? logsPool : appPool;
}

/**
 * Normalise op001 (Sydney wall time) and op002+ (UTC naive) `job_operation_duration` timestamps
 * to true UTC TIMESTAMPTZ in SQL. Mirrors the logic in server/index.ts:367-388 and the rationale
 * documented in migration 035-operation-duration-store-utc-naive.sql.
 *
 * Pass the table alias and column name; returns a SQL fragment producing TIMESTAMPTZ.
 */
function tzNormalizedColumn(alias: string, column: string): string {
    return `(CASE
        WHEN ${alias}.operation_id = 'op001'
            THEN ${alias}.${column} AT TIME ZONE 'Australia/Sydney'
        ELSE ${alias}.${column} AT TIME ZONE 'UTC'
    END)`;
}

/** Parse ?from / ?to ISO timestamps; defaults to last 30 days when omitted. */
function parseRange(req: { query: Record<string, unknown> }): { from: Date; to: Date } {
    const now = new Date();
    const fromRaw = typeof req.query.from === 'string' ? req.query.from : '';
    const toRaw = typeof req.query.to === 'string' ? req.query.to : '';
    const to = toRaw ? new Date(toRaw) : now;
    const from = fromRaw
        ? new Date(fromRaw)
        : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new Error('Invalid from/to ISO timestamp');
    }
    return { from, to };
}

/**
 * Expand a `from`/`to` pair to inclusive Sydney calendar-day bounds (as UTC instants).
 *
 * The UI sends `to = now`, but op001 completion times from Print OS are often stored as
 * Sydney wall-clock `job_complete_time` later in the same day. Filtering with
 * `completed_at <= now` drops those rows until that clock time passes, while scanner-based
 * op002–op004 (UTC-naive, usually in the past) still appear — making the bar chart look
 * like op001 is "not updating". Using end-of-day Sydney for `to` fixes that.
 */
function sydneyDayBoundsUtc(from: Date, to: Date): { fromUtc: Date; toUtc: Date } {
    const startSyd = toZonedTime(from, BUSINESS_TIMEZONE);
    startSyd.setHours(0, 0, 0, 0);
    const endSyd = toZonedTime(to, BUSINESS_TIMEZONE);
    endSyd.setHours(23, 59, 59, 999);
    return {
        fromUtc: fromZonedTime(startSyd, BUSINESS_TIMEZONE),
        toUtc: fromZonedTime(endSyd, BUSINESS_TIMEZONE),
    };
}

/** Utilisation denominator strategy. `calendar` = `to - from` seconds; `shift` = work days × hours/day. */
export type DenominatorKind = 'calendar' | 'shift';
export type WorkDaysSelector = 'all' | 'weekdays';

interface DenominatorSettings {
    kind: DenominatorKind;
    shiftHoursPerDay: number;
    workDays: WorkDaysSelector;
}

/**
 * Count Sydney calendar days in [from, to] that match the workDays selector
 * (inclusive on both ends). Operates in the business TZ so day boundaries line up
 * with the working day — counting in UTC double-counts boundary days for AU users
 * (UTC+10/11 means a Sydney "Friday" spans two UTC dates).
 */
function countWorkDaysInRange(from: Date, to: Date, workDays: WorkDaysSelector): number {
    // toZonedTime returns a Date whose local-time getters expose Sydney calendar values.
    const startSyd = toZonedTime(from, BUSINESS_TIMEZONE);
    const endSyd = toZonedTime(to, BUSINESS_TIMEZONE);
    const start = new Date(
        startSyd.getFullYear(),
        startSyd.getMonth(),
        startSyd.getDate()
    );
    const end = new Date(endSyd.getFullYear(), endSyd.getMonth(), endSyd.getDate());
    if (end.getTime() < start.getTime()) return 0;
    let count = 0;
    for (
        const d = new Date(start);
        d.getTime() <= end.getTime();
        d.setDate(d.getDate() + 1)
    ) {
        if (workDays === 'all') {
            count++;
        } else {
            const dow = d.getDay();
            // 0 = Sunday, 6 = Saturday
            if (dow !== 0 && dow !== 6) count++;
        }
    }
    return count;
}

/** Read denominator options from query string; defaults to shift × 7h × weekdays. */
function parseDenominator(req: { query: Record<string, unknown> }): DenominatorSettings {
    const rawKind = typeof req.query.denominator === 'string' ? req.query.denominator : '';
    const kind: DenominatorKind = rawKind === 'calendar' ? 'calendar' : 'shift';

    const rawHours =
        typeof req.query.shiftHoursPerDay === 'string'
            ? Number(req.query.shiftHoursPerDay)
            : NaN;
    const shiftHoursPerDay =
        Number.isFinite(rawHours) && rawHours > 0 && rawHours <= 24 ? rawHours : 7;

    const rawWorkDays = typeof req.query.workDays === 'string' ? req.query.workDays : '';
    const workDays: WorkDaysSelector = rawWorkDays === 'all' ? 'all' : 'weekdays';

    return { kind, shiftHoursPerDay, workDays };
}

/** Compute the chosen denominator in seconds for [from, to]. */
function computeDenominatorSeconds(
    from: Date,
    to: Date,
    settings: DenominatorSettings
): { seconds: number; workDaysInRange: number } {
    if (settings.kind === 'calendar') {
        return {
            seconds: Math.max(1, Math.round((to.getTime() - from.getTime()) / 1000)),
            workDaysInRange: 0,
        };
    }
    const workDaysInRange = countWorkDaysInRange(from, to, settings.workDays);
    const seconds = Math.max(
        1,
        Math.round(workDaysInRange * settings.shiftHoursPerDay * 3600)
    );
    return { seconds, workDaysInRange };
}

/**
 * GET /api/analytics/kpis
 * Top-of-page summary. `from`/`to` apply to onTimePercent (on-time **production**, not shipping)
 * and avgCycleSeconds only;
 * the day/week counters always use a fresh Australia/Sydney clock window.
 */
analyticsRouter.get('/kpis', async (req, res) => {
    try {
        const { from, to } = parseRange(req);
        const client = await poolForJobPipelineViews().connect();
        try {
            const completedExpr = tzNormalizedColumn('jod', 'operation_completed_at');
            const startedExpr = tzNormalizedColumn('jod', 'operation_started_at');

            // Distinct jobs that finished op004 today / this week (Sydney calendar).
            const completionsSql = `
                WITH normalized AS (
                    SELECT
                        jod.job_id,
                        jod.operation_id,
                        ${completedExpr} AS completed_at
                    FROM job_operation_duration jod
                    WHERE jod.operation_completed_at IS NOT NULL
                      AND jod.operation_id IN ('op001','op004')
                )
                SELECT
                    COUNT(DISTINCT CASE
                        WHEN operation_id = 'op004'
                          AND completed_at AT TIME ZONE 'Australia/Sydney'
                              >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Australia/Sydney')
                        THEN job_id
                    END) AS jobs_completed_today,
                    COUNT(DISTINCT CASE
                        WHEN operation_id = 'op004'
                          AND completed_at AT TIME ZONE 'Australia/Sydney'
                              >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Australia/Sydney') - INTERVAL '6 days'
                        THEN job_id
                    END) AS jobs_completed_week,
                    COUNT(DISTINCT CASE
                        WHEN operation_id = 'op001'
                          AND completed_at AT TIME ZONE 'Australia/Sydney'
                              >= DATE_TRUNC('day', NOW() AT TIME ZONE 'Australia/Sydney')
                        THEN job_id
                    END) AS versions_printed_today
                FROM normalized
            `;

            // End-to-end cycle: per job, MAX(op004 completed) - MIN(op001 started), averaged within range.
            const cycleSql = `
                WITH per_job AS (
                    SELECT
                        jod.job_id,
                        MIN(CASE WHEN jod.operation_id = 'op001' THEN ${startedExpr} END) AS start_at,
                        MAX(CASE WHEN jod.operation_id = 'op004' THEN ${completedExpr} END) AS end_at
                    FROM job_operation_duration jod
                    WHERE jod.operation_started_at IS NOT NULL
                       OR jod.operation_completed_at IS NOT NULL
                    GROUP BY jod.job_id
                )
                SELECT AVG(EXTRACT(EPOCH FROM (end_at - start_at))) AS avg_cycle_seconds
                FROM per_job
                WHERE start_at IS NOT NULL
                  AND end_at IS NOT NULL
                  AND end_at >= $1
                  AND end_at <= $2
            `;

            // "Online" = at least one duration row updated in the last 30 minutes.
            const machinesOnlineSql = `
                SELECT COUNT(DISTINCT machine_id) AS machines_online
                FROM job_operation_duration
                WHERE machine_id IS NOT NULL
                  AND updated_at >= NOW() - INTERVAL '30 minutes'
            `;

            const [completionsResult, cycleResult, machinesOnlineResult] = await Promise.all([
                client.query(completionsSql),
                client.query(cycleSql, [from.toISOString(), to.toISOString()]),
                client.query(machinesOnlineSql),
            ]);

            const businessDays = parseBusinessDaysAllowance(req.query.businessDays);
            const jmJobs = await fetchJobmanagerJobsForOnTime(from, to);
            const logsJobIds = [...new Set(jmJobs.map((j) => j.logsJobId))];
            const productionDoneByLogsJobId = await fetchProductionDoneByLogsJobId(
                client,
                logsJobIds
            );
            const onTimeMetrics = computeOnTimeMetrics(
                jmJobs,
                productionDoneByLogsJobId,
                businessDays
            );
            const onTimePercent = onTimeMetrics.onTimePercent;

            const completionsRow = completionsResult.rows[0] ?? {};
            const cycleRow = cycleResult.rows[0] ?? {};
            const machinesRow = machinesOnlineResult.rows[0] ?? {};

            res.json({
                jobsCompletedToday: Number(completionsRow.jobs_completed_today) || 0,
                jobsCompletedWeek: Number(completionsRow.jobs_completed_week) || 0,
                versionsPrintedToday: Number(completionsRow.versions_printed_today) || 0,
                avgCycleSeconds:
                    cycleRow.avg_cycle_seconds != null
                        ? Math.round(Number(cycleRow.avg_cycle_seconds))
                        : null,
                machinesOnline: Number(machinesRow.machines_online) || 0,
                onTimePercent,
            });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('analytics GET /kpis:', err);
        const detail = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'Failed to load KPIs', detail });
    }
});

/**
 * GET /api/analytics/throughput?from=&to=
 * Daily (Sydney calendar) bucketed count of distinct (job_id, version_tag) completions per operation.
 */
analyticsRouter.get('/throughput', async (req, res) => {
    try {
        const { from, to } = parseRange(req);
        const { fromUtc, toUtc } = sydneyDayBoundsUtc(from, to);
        const client = await poolForJobPipelineViews().connect();
        try {
            const completedExpr = tzNormalizedColumn('jod', 'operation_completed_at');
            const sql = `
                WITH normalized AS (
                    SELECT
                        jod.job_id,
                        jod.version_tag,
                        jod.operation_id,
                        ${completedExpr} AS completed_at
                    FROM job_operation_duration jod
                    WHERE jod.operation_completed_at IS NOT NULL
                      AND jod.operation_id IN ('op001','op002','op003','op004')
                )
                SELECT
                    TO_CHAR(
                        DATE_TRUNC('day', completed_at AT TIME ZONE 'Australia/Sydney'),
                        'YYYY-MM-DD'
                    ) AS day,
                    operation_id,
                    COUNT(*) FILTER (WHERE version_tag IS NOT NULL) AS n
                FROM normalized
                WHERE completed_at >= $1
                  AND completed_at <= $2
                GROUP BY day, operation_id
                ORDER BY day ASC
            `;
            const result = await client.query(sql, [fromUtc.toISOString(), toUtc.toISOString()]);

            const byDay = new Map<
                string,
                { date: string; op001: number; op002: number; op003: number; op004: number }
            >();
            for (const row of result.rows) {
                const day = String(row.day);
                const op = String(row.operation_id);
                if (!byDay.has(day)) {
                    byDay.set(day, { date: day, op001: 0, op002: 0, op003: 0, op004: 0 });
                }
                const entry = byDay.get(day)!;
                if (op === 'op001' || op === 'op002' || op === 'op003' || op === 'op004') {
                    entry[op] = Number(row.n) || 0;
                }
            }
            res.json(Array.from(byDay.values()));
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('analytics GET /throughput:', err);
        const detail = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'Failed to load throughput', detail });
    }
});

/**
 * GET /api/analytics/machine-performance?from=&to=&denominator=&shiftHoursPerDay=&workDays=
 *
 * Per-machine summary: total busy seconds, jobs per hour, median operation duration.
 * Utilisation % = busy / denominator, where the denominator is either:
 *   - calendar: `to - from` (i.e. 24/7)
 *   - shift: work-days × shift hours/day (default: weekdays × 7h, matches a single-shift print shop)
 * The denominator settings are echoed in the response so the UI can label values correctly.
 */
analyticsRouter.get('/machine-performance', async (req, res) => {
    try {
        const { from, to } = parseRange(req);
        const { fromUtc, toUtc } = sydneyDayBoundsUtc(from, to);
        const denominator = parseDenominator(req);
        const client = await poolForJobPipelineViews().connect();
        try {
            const completedExpr = tzNormalizedColumn('jod', 'operation_completed_at');
            const sql = `
                WITH normalized AS (
                    SELECT
                        jod.machine_id,
                        jod.job_id,
                        jod.operation_duration_seconds AS dur,
                        ${completedExpr} AS completed_at
                    FROM job_operation_duration jod
                    WHERE jod.machine_id IS NOT NULL
                      AND jod.operation_completed_at IS NOT NULL
                      AND jod.operation_duration_seconds IS NOT NULL
                )
                SELECT
                    machine_id,
                    SUM(dur) AS busy_seconds,
                    COUNT(DISTINCT job_id) AS distinct_jobs,
                    COUNT(*) AS op_rows,
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY dur) AS median_seconds
                FROM normalized
                WHERE completed_at >= $1
                  AND completed_at <= $2
                GROUP BY machine_id
                ORDER BY busy_seconds DESC NULLS LAST
            `;
            const result = await client.query(sql, [fromUtc.toISOString(), toUtc.toISOString()]);

            const machines = await prisma.machine.findMany({
                select: { id: true, displayName: true, name: true },
            });
            const nameById = new Map(
                machines.map((m) => [m.id, m.displayName || m.name] as const)
            );

            const calendarSeconds = Math.max(
                1,
                Math.round((toUtc.getTime() - fromUtc.getTime()) / 1000)
            );
            const { seconds: denominatorSeconds, workDaysInRange } = computeDenominatorSeconds(
                from,
                to,
                denominator
            );
            const denominatorHours = denominatorSeconds / 3600;
            const rows = result.rows.map((row) => {
                const busy = Number(row.busy_seconds) || 0;
                const jobs = Number(row.distinct_jobs) || 0;
                return {
                    machineId: String(row.machine_id),
                    machineName: nameById.get(String(row.machine_id)) ?? String(row.machine_id),
                    busySeconds: busy,
                    denominatorSeconds,
                    calendarSeconds,
                    utilizationPct:
                        denominatorSeconds > 0
                            ? Math.round((busy / denominatorSeconds) * 1000) / 10
                            : 0,
                    jobsPerHour:
                        denominatorHours > 0
                            ? Math.round((jobs / denominatorHours) * 100) / 100
                            : 0,
                    medianDurationSeconds:
                        row.median_seconds != null ? Math.round(Number(row.median_seconds)) : null,
                    opRows: Number(row.op_rows) || 0,
                };
            });

            res.json({
                denominator: {
                    kind: denominator.kind,
                    shiftHoursPerDay: denominator.shiftHoursPerDay,
                    workDays: denominator.workDays,
                    seconds: denominatorSeconds,
                    workDaysInRange,
                    calendarSeconds,
                },
                rows,
            });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('analytics GET /machine-performance:', err);
        const detail = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'Failed to load machine performance', detail });
    }
});

/**
 * GET /api/analytics/operation-durations?operationId=&from=&to=
 * Histogram + p50/p90/mean of `operation_duration_seconds` for one operation.
 * Defaults to op001 (Indigo print). 20 evenly-spaced bins between min and max.
 */
analyticsRouter.get('/operation-durations', async (req, res) => {
    try {
        const { from, to } = parseRange(req);
        const { fromUtc, toUtc } = sydneyDayBoundsUtc(from, to);
        const operationId =
            (typeof req.query.operationId === 'string' && req.query.operationId.trim()) || 'op001';
        const client = await poolForJobPipelineViews().connect();
        try {
            const completedExpr = tzNormalizedColumn('jod', 'operation_completed_at');
            const statsSql = `
                WITH normalized AS (
                    SELECT
                        jod.operation_duration_seconds AS dur,
                        ${completedExpr} AS completed_at
                    FROM job_operation_duration jod
                    WHERE jod.operation_id = $1
                      AND jod.operation_completed_at IS NOT NULL
                      AND jod.operation_duration_seconds IS NOT NULL
                )
                SELECT
                    COUNT(*) AS n,
                    AVG(dur) AS mean,
                    MIN(dur) AS min_d,
                    MAX(dur) AS max_d,
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY dur) AS p50,
                    percentile_cont(0.9) WITHIN GROUP (ORDER BY dur) AS p90
                FROM normalized
                WHERE completed_at >= $2
                  AND completed_at <= $3
            `;
            const statsResult = await client.query(statsSql, [
                operationId,
                fromUtc.toISOString(),
                toUtc.toISOString(),
            ]);
            const stats = statsResult.rows[0] ?? {};
            const n = Number(stats.n) || 0;
            const minD = stats.min_d != null ? Number(stats.min_d) : null;
            const maxD = stats.max_d != null ? Number(stats.max_d) : null;

            let bins: { rangeStart: number; rangeEnd: number; count: number }[] = [];
            if (n > 0 && minD != null && maxD != null && maxD > minD) {
                const binsSql = `
                    WITH normalized AS (
                        SELECT
                            jod.operation_duration_seconds AS dur,
                            ${completedExpr} AS completed_at
                        FROM job_operation_duration jod
                        WHERE jod.operation_id = $1
                          AND jod.operation_completed_at IS NOT NULL
                          AND jod.operation_duration_seconds IS NOT NULL
                    )
                    SELECT
                        width_bucket(dur, $4::float, $5::float, 20) AS bucket,
                        COUNT(*) AS n
                    FROM normalized
                    WHERE completed_at >= $2
                      AND completed_at <= $3
                    GROUP BY bucket
                    ORDER BY bucket
                `;
                const binsResult = await client.query(binsSql, [
                    operationId,
                    fromUtc.toISOString(),
                    toUtc.toISOString(),
                    minD,
                    maxD,
                ]);
                const binWidth = (maxD - minD) / 20;
                const buckets = new Map<number, number>();
                for (const row of binsResult.rows) {
                    const b = Number(row.bucket);
                    if (!Number.isFinite(b)) continue;
                    // width_bucket returns 21 for values equal to max; fold into last bin.
                    const idx = Math.max(1, Math.min(20, b));
                    buckets.set(idx, (buckets.get(idx) ?? 0) + (Number(row.n) || 0));
                }
                bins = [];
                for (let i = 1; i <= 20; i++) {
                    const rangeStart = minD + binWidth * (i - 1);
                    const rangeEnd = i === 20 ? maxD : minD + binWidth * i;
                    bins.push({
                        rangeStart: Math.round(rangeStart),
                        rangeEnd: Math.round(rangeEnd),
                        count: buckets.get(i) ?? 0,
                    });
                }
            }

            res.json({
                operationId,
                n,
                mean: stats.mean != null ? Math.round(Number(stats.mean)) : null,
                p50: stats.p50 != null ? Math.round(Number(stats.p50)) : null,
                p90: stats.p90 != null ? Math.round(Number(stats.p90)) : null,
                min: minD != null ? Math.round(minD) : null,
                max: maxD != null ? Math.round(maxD) : null,
                bins,
            });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('analytics GET /operation-durations:', err);
        const detail = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'Failed to load operation durations', detail });
    }
});

/**
 * GET /api/analytics/lane-funnel
 * In-progress jobs by operation lane — same filters and bucketing as JobPage.
 */
analyticsRouter.get('/lane-funnel', async (_req, res) => {
    try {
        const client = await poolForJobPipelineViews().connect();
        try {
            const result = await client.query(
                `SELECT lane, COUNT(*)::bigint AS n
                 FROM (
                   SELECT ${JOB_STATUS_VIEW_LANE_SQL} AS lane
                   FROM job_status_view
                   WHERE ${JOB_STATUS_VIEW_IN_PROGRESS_WHERE_SQL}
                 ) lanes
                 WHERE lane != 'op004'
                 GROUP BY lane`
            );
            const counts = new Map<string, number>();
            for (const row of result.rows) {
                counts.set(String(row.lane), Number(row.n) || 0);
            }
            const rows = IN_PROGRESS_LANE_FUNNEL_ORDER.map((lane) => ({
                status: lane,
                count: counts.get(lane) ?? 0,
            }));
            res.json(rows);
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('analytics GET /lane-funnel:', err);
        const detail = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'Failed to load lane funnel', detail });
    }
});

/**
 * GET /api/analytics/on-time?from=&to=&businessDays=
 * On-time **production** (not shipping): jobmanager.public.jobs (`created_at`) ⨝ logs
 * job_operation_duration (earliest op004 / op003 / op006 completion).
 * Join: logs job_id = parseInt(job_number)_line.
 */
analyticsRouter.get('/on-time', async (req, res) => {
    try {
        const { from, to } = parseRange(req);
        const businessDays = parseBusinessDaysAllowance(req.query.businessDays);
        const jmJobs = await fetchJobmanagerJobsForOnTime(from, to);

        if (jmJobs.length === 0) {
            res.json({
                businessDaysAllowance: businessDays,
                totalDue: 0,
                onTime: 0,
                late: 0,
                onTimePercent: null,
                jobs: [],
            });
            return;
        }

        const logsJobIds = [...new Set(jmJobs.map((j) => j.logsJobId))];
        const client = await poolForJobPipelineViews().connect();
        let metrics;
        try {
            const productionDoneByLogsJobId = await fetchProductionDoneByLogsJobId(
                client,
                logsJobIds
            );
            metrics = computeOnTimeMetrics(
                jmJobs,
                productionDoneByLogsJobId,
                businessDays
            );
        } finally {
            client.release();
        }

        res.json(metrics);
    } catch (err) {
        console.error('analytics GET /on-time:', err);
        const detail = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'Failed to load on-time production data', detail });
    }
});
