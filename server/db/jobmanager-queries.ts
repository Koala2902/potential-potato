import { appPool } from './app-connection.js';
import logsPool from './connection.js';
import { isDedicatedLogsDatabase } from './database-config.js';
import { isUndefinedTableError } from './pg-errors.js';
import { prisma } from './prisma.js';
import {
    parseSchedulerModes,
    type SchedulerMode,
} from '../../src/lib/scheduler/machine-routing.ts';
import { encodeScanCodeTextWithImposition } from './scan-code-text.js';

/** job_operations + job_status_* views: logs pool when LOGS_DATABASE_URL ≠ DATABASE_URL. */
function poolForJobPipelineViews(): typeof appPool {
    return isDedicatedLogsDatabase() ? logsPool : appPool;
}

/**
 * Scan pipeline contract: `scanned_codes.operations` JSONB uses `{ "operations": ["op001", ...] }`
 * with lowercase op### ids matching `scheduler.Operation.id` or `plannerOperationId` (column `operation_id`).
 */
export function normalizeOperationsPayloadForStorage(
    operations: Record<string, any> | null | undefined
): Record<string, any> | null {
    if (operations == null || typeof operations !== 'object') {
        return operations ?? null;
    }
    const arr = operations.operations;
    if (!Array.isArray(arr)) {
        return operations;
    }
    return {
        ...operations,
        operations: arr.map((o) => {
            const s = typeof o === 'string' ? o.trim() : String(o);
            if (/^op\d+$/i.test(s)) {
                return s.toLowerCase();
            }
            return o;
        }),
    };
}

/** Extract job_id and version_tag from a Labex `file_id` (shared with scan pipeline). */
export function parseFileId(fileId: string): { jobId: string; versionTag: string } | null {
    // Skip file_ids without "labex" (case insensitive)
    if (!fileId.toLowerCase().includes('labex')) {
        return null;
    }
    
    // Pattern: FILE_<version>_Labex_<job_id>_*
    // Job_id can have multiple underscores (e.g., 4677_5995)
    // Example: FILE_1_Labex_4677_5995_80 -> version: 1, jobId: 4677_5995
    
    // Match the pattern: FILE_<version>_Labex_<everything_after>
    const match = fileId.match(/^FILE_(\d+)_Labex_(.+)$/);
    if (!match) {
        return null;
    }
    
    const versionTag = match[1];
    const afterLabex = match[2];
    
    // Split by underscore - the job_id is everything except the last part
    // The last part is usually a page number or identifier (e.g., 80, 1, etc.)
    const parts = afterLabex.split('_');
    let jobId: string;
    
    if (parts.length >= 2) {
        // Extract job_id: take numeric parts at the beginning (e.g., "4677_5995")
        // Stop when we encounter non-numeric or descriptive text
        // Example: "4677_5995_50 x 50 mm_Circle..." -> jobId: "4677_5995"
        const numericParts: string[] = [];
        for (const part of parts) {
            // Check if part is purely numeric (allows underscores in numbers)
            if (/^\d+$/.test(part)) {
                numericParts.push(part);
            } else {
                // Stop at first non-numeric part
                break;
            }
        }
        
        if (numericParts.length >= 2) {
            // Job_id is the numeric parts joined (e.g., "4677_5995")
            jobId = numericParts.join('_');
        } else {
            // Fallback: take all parts except the last one
            jobId = parts.slice(0, -1).join('_');
        }
    } else {
        // If only one part, use it as job_id (shouldn't happen normally, but handle it)
        jobId = afterLabex;
    }
    
    return { jobId, versionTag };
}

export interface Machine {
    machine_id: string;
    machine_name: string;
    machine_type: string;
    capabilities: string | null;
    hourly_rate_aud: number | null;
    max_web_width_mm: number | null;
    availability_status: string | null;
    maintenance_schedule: string | null;
    shift_hours: number | null;
}

export interface ScannedCode {
    scan_id: number;
    code_text: string;
    scanned_at: Date;
    machine_id: string | null;
    user_id: string | null;
    operations: Record<string, any> | null;
    metadata: Record<string, any> | null;
}

/**
 * Resolve `scheduler.Machine.id` for planner operation ids (e.g. op003 → slitter press).
 * Uses highest `sortOrder` when multiple operations match.
 */
export async function getMachineIdForPlannerOperations(
    plannerOperationIds: string[]
): Promise<string | null> {
    const ids = plannerOperationIds.map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (ids.length === 0) return null;
    const ops = await prisma.operation.findMany({
        where: {
            OR: [
                { id: { in: ids } },
                { plannerOperationId: { in: ids, mode: 'insensitive' } },
            ],
        },
        select: { machineId: true, sortOrder: true },
        orderBy: [{ sortOrder: 'desc' }],
    });
    return ops[0]?.machineId ?? null;
}

/** Presses from `scheduler.Machine` on the app DB (`DATABASE_URL`) — single catalog (no `public.machines`). */
export async function getMachines(): Promise<Machine[]> {
    const rows = await prisma.machine.findMany({
        where: { enabled: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map((m) => ({
        machine_id: m.id,
        machine_name: m.displayName || m.name,
        machine_type: '',
        capabilities: null,
        hourly_rate_aud: null,
        max_web_width_mm: null,
        availability_status: m.enabled ? 'available' : 'inactive',
        maintenance_schedule: null,
        shift_hours: null,
    }));
}

/** Enabled operations for a machine (Ticket scan picker). */
export interface ScanCatalogOperation {
    scheduler_operation_id: string;
    planner_operation_id: string | null;
    operation_name: string;
    description?: string;
    created_at?: string;
}

/** @deprecated Use ScanCatalogOperation */
export type Operation = ScanCatalogOperation;

/** Preset bundles from `machine_modes` (optional). */
export interface MachineMode {
    mode_id: number;
    machine_id: string;
    label: string;
    operation_ids: string[];
    sort_order: number;
}

export async function getMachineModes(
    machineId: string | null | undefined
): Promise<MachineMode[]> {
    const mid = machineId?.trim();
    if (!mid) {
        return [];
    }
    const client = await appPool.connect();
    try {
        const result = await client.query(
            `SELECT mode_id, machine_id, label, operation_ids, sort_order
             FROM machine_modes
             WHERE machine_id = $1
             ORDER BY sort_order ASC, label ASC`,
            [mid]
        );
        return result.rows.map((r) => ({
            mode_id: r.mode_id,
            machine_id: r.machine_id,
            label: r.label,
            operation_ids: Array.isArray(r.operation_ids)
                ? r.operation_ids.map((x: string) => String(x).toLowerCase())
                : [],
            sort_order: Number(r.sort_order),
        }));
    } catch (e) {
        if (isUndefinedTableError(e)) {
            return [];
        }
        throw e;
    } finally {
        client.release();
    }
}

/** Operations for a press from `scheduler.Operation` (scan payload uses planner id when set). */
export async function getAvailableOperations(
    machineId?: string | null
): Promise<ScanCatalogOperation[]> {
    const mid = machineId?.trim() || null;
    if (!mid) {
        return [];
    }
    const rows = await prisma.operation.findMany({
        where: { machineId: mid, enabled: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map((o) => ({
        scheduler_operation_id: o.id,
        planner_operation_id: o.plannerOperationId ?? null,
        operation_name: o.name,
        description: o.notes ?? undefined,
        created_at: undefined,
    }));
}

/** Modes from `Machine.constants.schedulerModes` (config UI), not legacy `machine_modes`. */
export async function getSchedulerModesForMachine(
    machineId: string | null | undefined
): Promise<SchedulerMode[]> {
    const mid = machineId?.trim();
    if (!mid) return [];
    const m = await prisma.machine.findUnique({ where: { id: mid } });
    if (!m) return [];
    return parseSchedulerModes(m.constants);
}

// Legacy function for backward compatibility - maps operation_name to operation code
export function getOperationCode(operationName: string): string {
    const normalized = operationName.toLowerCase().trim();
    
    // Map operation names to codes
    if (normalized.includes('print')) return 'print';
    if (normalized.includes('coat')) return 'coating';
    if (normalized.includes('kiss') && normalized.includes('cut')) return 'kiss_cut';
    if (normalized.includes('backscore')) return 'backscore';
    if (normalized.includes('slit')) return 'slitter';
    
    // Default: return normalized version
    return normalized.replace(/\s+/g, '_');
}

// Record a scanned code (logs DB). Optional imposition id is embedded in code_text (see scan-code-text.ts).
export async function recordScannedCode(
    codeText: string,
    machineId: string | null,
    userId: string | null,
    operations: Record<string, any> | null = null,
    metadata: Record<string, any> | null = null,
    impositionId: string | null = null
): Promise<ScannedCode> {
    const client = await logsPool.connect();
    try {
        const storedCodeText = encodeScanCodeTextWithImposition(impositionId, codeText);
        const result = await client.query(
            `
            INSERT INTO scanned_codes (
                code_text,
                scanned_at,
                machine_id,
                user_id,
                operations,
                metadata
            )
            VALUES ($1, NOW(), $2, $3, $4, $5)
            RETURNING *
        `,
            [
                storedCodeText,
                machineId,
                userId,
                operations ? JSON.stringify(normalizeOperationsPayloadForStorage(operations)) : null,
                metadata ? JSON.stringify(metadata) : null,
            ]
        );

        return result.rows[0];
    } finally {
        client.release();
    }
}

// Record scans for all file_ids in a runlist
// When a runlist is scanned, create individual scanned_codes records for each file_id
// Store the original runlist_id in metadata for logging
export async function recordRunlistScans(
    runlistId: string,
    machineId: string | null,
    userId: string | null,
    operations: Record<string, any> | null = null,
    additionalMetadata: Record<string, any> | null = null
): Promise<ScannedCode[]> {
    const logsClient = await logsPool.connect();
    try {
        const fileRowsResult = await logsClient.query(
            `
            SELECT DISTINCT ON (ifm.file_id) ifm.file_id, ifm.imposition_id
            FROM imposition_file_mapping ifm
            INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
            WHERE ppp.runlist_id = $1
            ORDER BY ifm.file_id, ifm.imposition_id
        `,
            [runlistId]
        );

        const fileRows = fileRowsResult.rows as { file_id: string; imposition_id: string }[];
        console.log(`[recordRunlistScans] Found ${fileRows.length} file_ids in runlist ${runlistId}`);

        if (fileRows.length === 0) {
            console.warn(`[recordRunlistScans] No file_ids found for runlist ${runlistId}`);
            return [];
        }
        
        // Create metadata with original runlist_id
        const metadata = {
            ...additionalMetadata,
            derived_from_runlist: runlistId,
            original_scan_type: 'runlist',
            timestamp: new Date().toISOString()
        };
        
        // Record a scan for each file_id
        // Format code_text as job_id_version_tag (e.g., "4677_5995_1") instead of full file_id
        // Allow duplicate file_id scans - they're valid (same file can be scanned multiple times)
        // Handle scan_id conflicts gracefully by catching errors and continuing
        const recordedScans: ScannedCode[] = [];
        for (const row of fileRows) {
            const fileId = row.file_id;
            const impositionId = row.imposition_id;
            // Parse file_id to extract job_id and version_tag (do this outside try block for error handling)
            const parsed = parseFileId(fileId);
            if (!parsed) {
                console.warn(`[recordRunlistScans] Could not parse file_id: ${fileId}, skipping`);
                continue;
            }
            
            // Format as job_id_version_tag (e.g., "4677_5995_1"); imposition id in code_text prefix
            const baseCodeText = `${parsed.jobId}_${parsed.versionTag}`;
            const codeText = encodeScanCodeTextWithImposition(impositionId, baseCodeText);

            try {
                const result = await logsClient.query(
                    `
                    INSERT INTO scanned_codes (
                        code_text,
                        scanned_at,
                        machine_id,
                        user_id,
                        operations,
                        metadata
                    )
                    VALUES ($1, NOW(), $2, $3, $4, $5)
                    RETURNING *
                `,
                    [
                        codeText,
                        machineId,
                        userId,
                        operations ? JSON.stringify(normalizeOperationsPayloadForStorage(operations)) : null,
                        JSON.stringify(metadata),
                    ]
                );
                
                recordedScans.push(result.rows[0]);
                console.log(`[recordRunlistScans] Successfully inserted scan for file_id ${fileId} -> code_text: ${codeText} (scan_id: ${result.rows[0].scan_id})`);
            } catch (err: any) {
                // Handle duplicate key errors on scan_id (shouldn't happen with SERIAL, but handle it)
                // Also handle any other errors gracefully - continue with next file_id
                if (err.message.includes('duplicate key') || err.message.includes('unique constraint')) {
                    // If scan_id conflict, fix the sequence and retry
                    try {
                        // Get current max scan_id
                        const maxIdResult = await logsClient.query('SELECT MAX(scan_id) as max_id FROM scanned_codes');
                        const maxId = maxIdResult.rows[0].max_id || 0;
                        const nextId = maxId + 1;
                        
                        // Reset sequence to next available ID (use true to set is_called)
                        await logsClient.query(`SELECT setval('scanned_codes_scan_id_seq', $1, true)`, [nextId]);
                        console.log(`[recordRunlistScans] Fixed sequence to ${nextId} for file_id ${fileId}`);
                        
                        // Retry insert with the same codeText
                        const retryResult = await logsClient.query(
                            `
                            INSERT INTO scanned_codes (
                                code_text,
                                scanned_at,
                                machine_id,
                                user_id,
                                operations,
                                metadata
                            )
                            VALUES ($1, NOW(), $2, $3, $4, $5)
                            RETURNING *
                        `,
                            [
                                codeText,
                                machineId,
                                userId,
                                operations ? JSON.stringify(normalizeOperationsPayloadForStorage(operations)) : null,
                                JSON.stringify(metadata),
                            ]
                        );
                        
                        recordedScans.push(retryResult.rows[0]);
                        console.log(`[recordRunlistScans] Successfully inserted scan after retry for file_id ${fileId} -> code_text: ${codeText} (scan_id: ${retryResult.rows[0].scan_id})`);
                    } catch (retryErr: any) {
                        // If retry also fails, log error but continue with next file_id
                        console.error(`[recordRunlistScans] Failed to insert scan for file_id ${fileId} after sequence fix:`, retryErr.message);
                        // Don't throw - continue processing other file_ids
                    }
                } else {
                    // Other errors - log and continue
                    console.warn(`[recordRunlistScans] Error recording scan for file_id ${fileId}:`, err.message);
                }
            }
        }
        
        console.log(`[recordRunlistScans] Recorded ${recordedScans.length} scans for runlist ${runlistId}`);
        return recordedScans;
    } finally {
        logsClient.release();
    }
}

// Get job by job_id or job_number
export async function getJobByIdentifier(identifier: string): Promise<any | null> {
    const client = await appPool.connect();
    try {
        // Try job_id first
        let result = await client.query(`
            SELECT * FROM jobs WHERE job_id = $1 LIMIT 1
        `, [identifier]);

        if (result.rows.length === 0) {
            // Try job_number
            result = await client.query(`
                SELECT * FROM jobs WHERE job_number = $1 LIMIT 1
            `, [identifier]);
        }

        return result.rows.length > 0 ? result.rows[0] : null;
    } finally {
        client.release();
    }
}

export interface JobFilterOptions {
    labexOnly?: boolean;
    status?: string;
    excludeStatus?: string | string[];
    material?: string;
    finishing?: string;
    hasPrint?: boolean;
    hasCoating?: boolean;
    hasKissCut?: boolean;
    hasBackscore?: boolean;
    hasSlitter?: boolean;
    /** ISO — filters by latest_completed_at (last scan time) */
    dateFrom?: string;
    /** ISO — filters by latest_completed_at (last scan time) */
    dateTo?: string;
    limit?: number;
    offset?: number;
    /** Cursor marker for keyset-style paging on latest_completed_at. */
    markerLatestCompletedAt?: string;
    markerJobId?: string;
    /** Optional faster mode to avoid expensive latest_completed_at sorting. */
    sort?: 'latest' | 'none';
    /** Skip runlist resolution/join when consumer does not need runlist_id. */
    includeRunlist?: boolean;
}

// Removed getScannedOperationsFromScannedCodes() - no longer needed
// The SQL function has_scanned_operation() in the view now handles scanned_codes directly

/** WHERE fragment (after `WHERE 1=1`) for job_status_view / job_status_runlist_view filters. */
function buildJobStatusViewWhere(
    filters: JobFilterOptions | undefined,
    excludeFinished: boolean,
    onlyFinished: boolean
): { fragment: string; params: any[] } {
    const params: any[] = [];
    let i = 1;
    let fragment = '';
    if (onlyFinished) {
        fragment += ` AND status = 'production_finished'`;
    } else if (excludeFinished) {
        fragment += ` AND status != 'production_finished'`;
    } else {
        fragment += ` AND (
                status != 'production_finished' 
                OR latest_completed_at >= NOW() - INTERVAL '14 days'
            )`;
    }
    if (filters?.status && !onlyFinished) {
        fragment += ` AND status = $${i++}`;
        params.push(filters.status);
    }
    // Last scan / latest activity (filters out stale jobs when date range is set)
    if (filters?.dateFrom) {
        fragment += ` AND latest_completed_at >= $${i++}`;
        params.push(filters.dateFrom);
    }
    if (filters?.dateTo) {
        fragment += ` AND latest_completed_at <= $${i++}`;
        params.push(filters.dateTo);
    }
    if (filters?.markerLatestCompletedAt) {
        if (filters?.markerJobId) {
            fragment += ` AND (
                latest_completed_at < $${i}
                OR (latest_completed_at = $${i} AND job_id < $${i + 1})
            )`;
            params.push(filters.markerLatestCompletedAt, filters.markerJobId);
            i += 2;
        } else {
            fragment += ` AND latest_completed_at < $${i++}`;
            params.push(filters.markerLatestCompletedAt);
        }
    }
    return { fragment, params };
}

const RUNLIST_BATCH_SIZE = 80;

/** Resolve ALL runlist_ids for each job (a job can be in multiple runlists).
 * Returns Map<job_id, runlist_id[]>. Searches all version_tags per job. */
async function batchResolveRunlistIds(
    client: import('pg').PoolClient,
    rows: { job_id: string; version_tags?: string[] }[],
    /** imposition_file_mapping + production_planner_paths (logs DB only). */
    plannerClient?: import('pg').PoolClient
): Promise<Map<string, string[]>> {
    const planner = plannerClient ?? client;
    const patterns: { pattern: string; job_id: string }[] = [];
    for (const row of rows) {
        const versionTags = row.version_tags || [];
        // Search all version_tags - each can be in a different runlist
        for (const versionTag of versionTags) {
            patterns.push({
                pattern: `FILE_${versionTag}_Labex_${row.job_id}_%`,
                job_id: row.job_id,
            });
        }
    }
    if (patterns.length === 0) return new Map();

    const runlistMap = new Map<string, Set<string>>();
    for (let i = 0; i < patterns.length; i += RUNLIST_BATCH_SIZE) {
        const chunk = patterns.slice(i, i + RUNLIST_BATCH_SIZE);
        const orClauses = chunk.map((_, idx) => `ifm.file_id LIKE $${idx + 1}`).join(' OR ');
        const params = chunk.map((p) => p.pattern);
        try {
            const runlistResult = await planner.query(
                `SELECT DISTINCT ifm.file_id, ppp.runlist_id
                 FROM imposition_file_mapping ifm
                 INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
                 WHERE ppp.runlist_id IS NOT NULL AND (${orClauses})`,
                params
            );
            for (const r of runlistResult.rows) {
                const parsed = parseFileId(r.file_id);
                if (parsed) {
                    if (!runlistMap.has(parsed.jobId)) {
                        runlistMap.set(parsed.jobId, new Set());
                    }
                    runlistMap.get(parsed.jobId)!.add(r.runlist_id);
                }
            }
        } catch (err) {
            console.warn('Batch runlist resolution failed for chunk:', err);
        }
    }
    // Convert Set to array for easier consumption
    const result = new Map<string, string[]>();
    for (const [jobId, runlistIds] of runlistMap) {
        result.set(jobId, Array.from(runlistIds));
    }
    return result;
}

function mapJobStatusRow(row: any): any {
    return {
        job_id: row.job_id,
        total_versions: parseInt(row.total_versions, 10) || 0,
        completed_versions: parseInt(row.completed_versions, 10) || 0,
        version_tags: row.version_tags || [],
        status: row.status || 'print_ready',
        latest_completed_operation_id: row.latest_completed_operation_id || null,
        created_at: row.earliest_completed_at || null,
        updated_at: row.latest_completed_at || null,
        runlist_id: row.runlist_id ?? null,
    };
}

function mapJobStatusRowWithoutRunlist(row: any): any {
    return {
        job_id: row.job_id,
        total_versions: parseInt(row.total_versions, 10) || 0,
        completed_versions: parseInt(row.completed_versions, 10) || 0,
        version_tags: row.version_tags || [],
        status: row.status || 'print_ready',
        latest_completed_operation_id: row.latest_completed_operation_id || null,
        created_at: row.earliest_completed_at || null,
        updated_at: row.latest_completed_at || null,
        runlist_id: null,
    };
}

async function queryJobStatusViewFast(
    client: import('pg').PoolClient,
    fragment: string,
    baseParams: any[],
    limitValue: number | null,
    offsetValue: number | null,
    sortMode: 'latest' | 'none'
): Promise<any[]> {
    const params = [...baseParams];
    const orderBy =
        sortMode === 'none'
            ? 'job_id DESC'
            : 'latest_completed_at DESC NULLS LAST, job_id DESC';
    let query = `SELECT * FROM job_status_view WHERE 1=1 ${fragment} ORDER BY ${orderBy}`;
    if (limitValue) {
        query += ` LIMIT $${params.length + 1}`;
        params.push(limitValue);
        if (offsetValue != null) {
            query += ` OFFSET $${params.length + 1}`;
            params.push(offsetValue);
        }
    }
    const result = await client.query(query, params);
    return result.rows.map(mapJobStatusRowWithoutRunlist);
}

/** Primary path: read job_status_runlist_view (runlist resolved in Postgres). LIMIT applies to distinct jobs via CTE. */
async function queryJobStatusRunlistView(
    client: import('pg').PoolClient,
    fragment: string,
    baseParams: any[],
    limitValue: number | null,
    offsetValue: number | null,
    sortMode: 'latest' | 'none'
): Promise<any[]> {
    const params = [...baseParams];
    let primaryQuery: string;
    const orderBy =
        sortMode === 'none'
            ? 'v.job_id DESC, v.runlist_id NULLS LAST'
            : 'v.latest_completed_at DESC NULLS LAST, v.job_id DESC, v.runlist_id NULLS LAST';
    if (limitValue) {
        const limIdx = baseParams.length + 1;
        const offIdx = offsetValue != null ? limIdx + 1 : null;
        const limitedOrderBy =
            sortMode === 'none'
                ? 'job_id DESC'
                : 'latest_completed_at DESC NULLS LAST, job_id DESC';
        primaryQuery = `
      WITH limited_jobs AS (
        SELECT job_id FROM job_status_view WHERE 1=1 ${fragment}
        ORDER BY ${limitedOrderBy}
        LIMIT $${limIdx}
        ${offIdx != null ? `OFFSET $${offIdx}` : ''}
      )
      SELECT v.* FROM job_status_runlist_view v
      INNER JOIN limited_jobs lj ON v.job_id = lj.job_id
      ORDER BY ${orderBy}`;
        params.push(limitValue);
        if (offIdx != null) {
            params.push(offsetValue);
        }
    } else {
        primaryQuery = `SELECT * FROM job_status_runlist_view WHERE 1=1 ${fragment}
      ORDER BY ${orderBy}`;
    }

    try {
        const result = await client.query(primaryQuery, params);
        return result.rows.map(mapJobStatusRow);
    } catch (error: any) {
        if (error.message?.includes('column') && error.message?.includes('does not exist')) {
            const fbParams = [...baseParams];
            let fb: string;
            if (limitValue) {
                const limIdx = baseParams.length + 1;
                fb = `
      WITH limited_jobs AS (
        SELECT job_id FROM job_status_view WHERE 1=1 ${fragment}
        ORDER BY job_id DESC
        LIMIT $${limIdx}
      )
      SELECT v.* FROM job_status_runlist_view v
      INNER JOIN limited_jobs lj ON v.job_id = lj.job_id
      ORDER BY v.job_id DESC, v.runlist_id NULLS LAST`;
                fbParams.push(limitValue);
            } else {
                fb = `SELECT * FROM job_status_runlist_view WHERE 1=1 ${fragment}
      ORDER BY job_id DESC, runlist_id NULLS LAST`;
            }
            const result = await client.query(fb, fbParams);
            return result.rows.map(mapJobStatusRow);
        }
        throw error;
    }
}

/** Fallback when migration 016 is not applied: job_status_view + batched LIKE runlist resolution. */
async function getJobsUsingStatusViewAndBatch(
    client: import('pg').PoolClient,
    plannerClient: import('pg').PoolClient,
    filters: JobFilterOptions | undefined,
    excludeFinished: boolean,
    onlyFinished: boolean,
    limitValue: number | null,
    offsetValue: number | null,
    sortMode: 'latest' | 'none'
): Promise<any[]> {
    const { fragment, params: whereParams } = buildJobStatusViewWhere(filters, excludeFinished, onlyFinished);
    const params = [...whereParams];
    let query = `SELECT * FROM job_status_view WHERE 1=1${fragment}`;
    let result;
    try {
        if (sortMode === 'none') {
            query += ` ORDER BY job_id DESC`;
        } else {
            query += ` ORDER BY latest_completed_at DESC NULLS LAST, job_id DESC`;
        }
        if (limitValue) {
            query += ` LIMIT $${params.length + 1}`;
            params.push(limitValue);
            if (offsetValue != null) {
                query += ` OFFSET $${params.length + 1}`;
                params.push(offsetValue);
            }
        }
        result = await client.query(query, params);
    } catch (error: any) {
        if (error.message?.includes('column') && error.message?.includes('does not exist')) {
            const params2 = [...whereParams];
            let q2 = `SELECT * FROM job_status_view WHERE 1=1${fragment} ORDER BY job_id DESC`;
            if (limitValue) {
                q2 += ` LIMIT $${params2.length + 1}`;
                params2.push(limitValue);
            }
            result = await client.query(q2, params2);
        } else {
            throw error;
        }
    }

    const runlistMap = await batchResolveRunlistIds(client, result.rows, plannerClient);

    const seenJobIds = new Set<string>();
    const uniqueRows = result.rows.filter((row) => {
        if (seenJobIds.has(row.job_id)) return false;
        seenJobIds.add(row.job_id);
        return true;
    });

    const jobsWithRunlist: any[] = [];
    for (const row of uniqueRows) {
        const runlistIds = runlistMap.get(row.job_id) ?? [];
        const baseJob = {
            job_id: row.job_id,
            total_versions: parseInt(row.total_versions, 10) || 0,
            completed_versions: parseInt(row.completed_versions, 10) || 0,
            version_tags: row.version_tags || [],
            status: row.status || 'print_ready',
            latest_completed_operation_id: row.latest_completed_operation_id || null,
            created_at: row.earliest_completed_at || null,
            updated_at: row.latest_completed_at || null,
        };
        if (runlistIds.length === 0) {
            jobsWithRunlist.push({ ...baseJob, runlist_id: null });
        } else {
            for (const runlistId of runlistIds) {
                jobsWithRunlist.push({ ...baseJob, runlist_id: runlistId });
            }
        }
    }
    return jobsWithRunlist;
}

// Get all jobs from job_status_runlist_view (pipeline DB), or legacy path if view missing
export async function getJobs(filters?: JobFilterOptions): Promise<any[]> {
    const excludeFinished = Array.isArray(filters?.excludeStatus)
        ? filters!.excludeStatus!.includes('production_finished')
        : filters?.excludeStatus === 'production_finished';
    const onlyFinished = filters?.status === 'production_finished';
    const limitValue = filters?.limit && filters.limit > 0 ? filters.limit : null;
    const offsetValue = filters?.offset && filters.offset > 0 ? filters.offset : null;
    const sortMode: 'latest' | 'none' = filters?.sort === 'none' ? 'none' : 'latest';
    const includeRunlist = filters?.includeRunlist !== false;
    const { fragment, params: whereParams } = buildJobStatusViewWhere(filters, excludeFinished, onlyFinished);

    const viewPool = poolForJobPipelineViews();
    const client = await viewPool.connect();
    /** Runlist resolution reads `imposition_file_mapping` on logs only — same pool as pipeline views when dual-DB. */
    const plannerClient = client;
    try {
        if (!includeRunlist) {
            return await queryJobStatusViewFast(
                client,
                fragment,
                whereParams,
                limitValue,
                offsetValue,
                sortMode
            );
        }
        try {
            return await queryJobStatusRunlistView(
                client,
                fragment,
                whereParams,
                limitValue,
                offsetValue,
                sortMode
            );
        } catch (error: any) {
            const msg = String(error?.message || '');
            const missingRunlistView =
                error?.code === '42P01' ||
                (msg.includes('job_status_runlist_view') && msg.includes('does not exist'));
            if (missingRunlistView) {
                console.warn(
                    'job_status_runlist_view not found; using job_status_view + batched runlist resolution. Run migration 016.'
                );
                return await getJobsUsingStatusViewAndBatch(
                    client,
                    plannerClient,
                    filters,
                    excludeFinished,
                    onlyFinished,
                    limitValue,
                    offsetValue,
                    sortMode
                );
            }
            throw error;
        }
    } catch (error: any) {
        if (error.message.includes('does not exist') || error.message.includes('relation') || error.message.includes('view')) {
            console.warn('job_status_view not found, falling back to direct query. Run migration 002-create-job-status-view.sql');
            return getJobsFallback(filters);
        }
        throw error;
    } finally {
        client.release();
    }
}

// Fallback function if view doesn't exist (original implementation)
async function getJobsFallback(filters?: JobFilterOptions): Promise<any[]> {
    const client = await poolForJobPipelineViews().connect();
    const plannerClient = client;
    try {
        let query = `
            SELECT 
                jo.job_id,
                COUNT(DISTINCT jo.version_tag) as total_versions,
                COUNT(DISTINCT CASE WHEN jo.completed_at IS NOT NULL THEN jo.version_tag END) as completed_versions,
                MAX(CASE WHEN jo.completed_at IS NOT NULL THEN jo.sequence_order END) as max_completed_sequence,
                MAX(jo.sequence_order) as max_sequence,
                ARRAY_AGG(DISTINCT jo.version_tag ORDER BY jo.version_tag) as version_tags,
                MIN(jo.completed_at) as earliest_completed_at,
                MAX(jo.completed_at) as latest_completed_at
            FROM job_operations jo
            WHERE 1=1
        `;
        const params: any[] = [];
        let paramIndex = 1;

        const hasDateFrom = Boolean(filters?.dateFrom);
        const hasDateTo = Boolean(filters?.dateTo);
        if (hasDateFrom) {
            params.push(filters!.dateFrom);
            paramIndex++;
        }
        if (hasDateTo) {
            params.push(filters!.dateTo);
            paramIndex++;
        }

        query += ` GROUP BY jo.job_id`;

        if (hasDateFrom || hasDateTo) {
            let hi = 1;
            query += ` HAVING`;
            const parts: string[] = [];
            if (hasDateFrom) {
                parts.push(`MAX(jo.completed_at) >= $${hi++}`);
            }
            if (hasDateTo) {
                parts.push(`MAX(jo.completed_at) <= $${hi++}`);
            }
            query += ` ${parts.join(' AND ')}`;
        }

        let result;
        const limitValue = filters?.limit && filters.limit > 0 ? filters.limit : null;
        
        try {
            // Order by completion date DESC (most recent first), then by job_id for NULLs
            query += ` ORDER BY MAX(jo.completed_at) DESC NULLS LAST, jo.job_id DESC`;
            // Don't apply limit here - let frontend filter by status
            result = await client.query(query, params);
        } catch (error: any) {
            if (error.message.includes('column') && error.message.includes('does not exist')) {
                query = query.replace(/ORDER BY.*/, 'ORDER BY jo.job_id DESC');
                if (limitValue) {
                    const baseQuery = query.split('ORDER BY')[0];
                    query = baseQuery + ` ORDER BY jo.job_id DESC LIMIT $${paramIndex}`;
                    params.push(limitValue);
                }
                result = await client.query(query, params);
            } else {
                throw error;
            }
        }

        // Map results and get runlist_id for each job
        // Also determine status from latest completed operation_id
        const jobsWithRunlist = await Promise.all(result.rows.map(async (row) => {
            // Get all completed operations to determine status based on rules
            let status = 'print_ready';
            let latestCompletedOperationId: string | null = null;
            
            try {
                // Get latest completed operation for display
                const latestOpResult = await client.query(
                    `SELECT operation_id, completed_at
                     FROM job_operations 
                     WHERE job_id = $1 
                     AND completed_at IS NOT NULL 
                     ORDER BY completed_at DESC 
                     LIMIT 1`,
                    [row.job_id]
                );
                
                if (latestOpResult.rows.length > 0 && latestOpResult.rows[0].operation_id) {
                    latestCompletedOperationId = latestOpResult.rows[0].operation_id;
                }
                
                // Check which operations are completed to determine status
                // Mapping: op001→printed, op002→digital_cut, op003→production_finished, op004→production_finished
                const operationsResult = await client.query(
                    `SELECT 
                        BOOL_OR(LOWER(operation_id) = 'op001' AND completed_at IS NOT NULL) as has_op001,
                        BOOL_OR(LOWER(operation_id) = 'op002' AND completed_at IS NOT NULL) as has_op002,
                        BOOL_OR(LOWER(operation_id) = 'op003' AND completed_at IS NOT NULL) as has_op003,
                        BOOL_OR(LOWER(operation_id) = 'op004' AND completed_at IS NOT NULL) as has_op004,
                        BOOL_OR(LOWER(operation_id) = 'op005' AND completed_at IS NOT NULL) as has_op005,
                        BOOL_OR(LOWER(operation_id) = 'op006' AND completed_at IS NOT NULL) as has_op006
                     FROM job_operations
                     WHERE job_id = $1`,
                    [row.job_id]
                );
                
                if (operationsResult.rows.length > 0) {
                    const ops = operationsResult.rows[0];
                    // Apply status rules (in priority order):
                    // 1. If op004 is scanned, it's production_finished
                    if (ops.has_op004) {
                        status = 'production_finished';
                    }
                    // 2. If op006 is scanned, it's slitter
                    else if (ops.has_op006) {
                        status = 'slitter';
                    }
                    // 3. If both op002 and op003 are scanned, it's slitter
                    else if (ops.has_op002 && ops.has_op003) {
                        status = 'slitter';
                    }
                    // 4. If op003 is scanned alone, it's slitter
                    else if (ops.has_op003) {
                        status = 'slitter';
                    }
                    // 5. If op005 is scanned, it's digital_cut
                    else if (ops.has_op005) {
                        status = 'digital_cut';
                    }
                    // 6. If only op002 is scanned (without op003), it's digital_cut
                    else if (ops.has_op002) {
                        status = 'digital_cut';
                    }
                    // 7. If op001 is scanned, it's printed
                    else if (ops.has_op001) {
                        status = 'printed';
                    }
                }
            } catch (err) {
                console.warn(`Could not get operations for job ${row.job_id}:`, err);
            }

            // Get runlist_id for this job
            let runlistId: string | null = null;
            try {
                const versionTags = row.version_tags || [];
                if (versionTags.length > 0) {
                    const versionTag = versionTags[0];
                    const pattern = `FILE_${versionTag}_Labex_${row.job_id}_%`;
                    
                    const runlistResult = await plannerClient.query(
                        `SELECT DISTINCT ppp.runlist_id
                         FROM imposition_file_mapping ifm
                         INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
                         WHERE ifm.file_id LIKE $1
                         AND ppp.runlist_id IS NOT NULL
                         LIMIT 1`,
                        [pattern]
                    );
                    
                    if (runlistResult.rows.length > 0) {
                        runlistId = runlistResult.rows[0].runlist_id;
                    }
                }
            } catch (err) {
                console.warn(`Could not get runlist_id for job ${row.job_id}:`, err);
            }

            return {
                job_id: row.job_id,
                total_versions: parseInt(row.total_versions) || 0,
                completed_versions: parseInt(row.completed_versions) || 0,
                version_tags: row.version_tags || [],
                status: status,
                latest_completed_operation_id: latestCompletedOperationId,
                created_at: row.earliest_completed_at || null,
                updated_at: row.latest_completed_at || null,
                runlist_id: runlistId,
            };
        }));

        const excludeFinished = Array.isArray(filters?.excludeStatus)
            ? filters.excludeStatus.includes('production_finished')
            : filters?.excludeStatus === 'production_finished';
        const onlyFinished = filters?.status === 'production_finished';
        if (onlyFinished) {
            return jobsWithRunlist.filter((j: any) => j.status === 'production_finished');
        }
        if (excludeFinished) {
            return jobsWithRunlist.filter((j: any) => j.status !== 'production_finished');
        }
        return jobsWithRunlist;
    } finally {
        client.release();
    }
}

