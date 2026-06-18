/**
 * Scan processing: validates operation ids against `scheduler.Operation` (Prisma on app DB)
 * (canonical catalog; see `operations-catalog.ts`). Logs `scanned_codes` hold the payload.
 */
import dotenv from 'dotenv';
import type { PoolClient } from 'pg';

import { appPool } from './app-connection.js';
import {
    getBladerunnerCutterLiveTableSqlIdentifier,
    getPrintbeatMaxAgeMinutes,
    getPrintbeatMinId,
    getPrintbeatRealtimeTableSqlIdentifier,
    impositionDurationViewPlainIdentifier,
    isBladerunnerCutterLiveDisabled,
    isPrintbeatIdMarkerSequentialEnabled,
    isDedicatedLogsDatabase,
    isOp001EnrichStrictGuardsEnabled,
    isPrintbeatRealtimeEnrichDisabled,
    printOsCursorUsesRowId,
} from './database-config.js';
import { getPrintOsPool } from './print-os-pool.js';
import {
    OP001_SCAN_ENRICH_ROW_LIMIT,
    POST_PRINT_SCAN_ENRICH_ROW_LIMIT,
    PRINT_OS_ENRICH_ROW_LIMIT,
    PRODUCTION_COMPLETED_JOBS_PER_MACHINE,
} from './production-status-limits.js';
import logsPool from './connection.js';

/** `job_operations` / `imposition_operations`: dual-DB migrations apply these to LOGS_DATABASE_URL. */
function poolForPipelineTables(): typeof appPool {
    return isDedicatedLogsDatabase() ? logsPool : appPool;
}
import {
    withImpositionFileMappingClient,
    withPlannerAppThenLogsOnEmpty,
    withPlannerClient,
} from './planner-client.js';
import { isUndefinedColumnError, isUndefinedTableError } from './pg-errors.js';
import { prisma } from './prisma.js';
import {
    getCachedSchedulerMachineByUniqueName,
    getCachedSchedulerMachinesForMerge,
    getCachedSchedulerPrintOperationId,
} from './scheduler-catalog-cache.js';
import {
    canonicalCompositeJobIdForDisplay,
    fileIdPatternLoose,
    fileIdPatternStrict,
    isNumericVersionSuffix,
    labexJobIdSegmentPattern,
    parseJobIdVersionFromScanCode,
    parseJobIdVersionTagScan,
    parseMultiJobLabexBarcode,
    scanCodeToJobDisplayId,
} from './scan-job-version.js';
import { decodeScanCodeText } from './scan-code-text.js';
import { parseFileId } from './jobmanager-queries.js';
import { pgTimestampToIsoUtc } from './pg-timestamp.js';

dotenv.config();

/**
 * All distinct (job_id, version_tag) pairs for an imposition from `imposition_file_mapping` FILE_* Labex rows.
 */
async function getJobMapFromImpositionId(impositionId: string): Promise<Map<string, Set<string>> | null> {
    const trimmed = impositionId.trim();
    if (!trimmed) return null;
    const client = await logsPool.connect();
    try {
        const check = await client.query(
            `SELECT 1 FROM imposition_file_mapping WHERE imposition_id = $1 LIMIT 1`,
            [trimmed]
        );
        if (check.rows.length === 0) return null;
        const files = await client.query(
            `SELECT file_id FROM imposition_file_mapping WHERE imposition_id = $1 ORDER BY sequence_order NULLS LAST, file_id`,
            [trimmed]
        );
        const jobMap = new Map<string, Set<string>>();
        for (const row of files.rows) {
            const parsed = parseFileId(row.file_id as string);
            if (parsed) {
                if (!jobMap.has(parsed.jobId)) jobMap.set(parsed.jobId, new Set());
                jobMap.get(parsed.jobId)!.add(parsed.versionTag);
            }
        }
        if (jobMap.size === 0) return null;
        return jobMap;
    } finally {
        client.release();
    }
}

/** When code_text is exactly a planner imposition_id, expand to jobs from file_ids. */
async function tryJobMapFromImpositionCode(
    candidate: string
): Promise<{
    jobMap: Map<string, Set<string>>;
    fileIdImpositions: string[];
} | null> {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    const jobMap = await getJobMapFromImpositionId(trimmed);
    if (!jobMap) return null;
    return { jobMap, fileIdImpositions: [trimmed] };
}

/**
 * When an imposition operation is marked complete by a scan, ensure every job/version in that imposition
 * has `job_operation_duration` completed for this operation (not only the job(s) matched by the scan).
 * Print (op001) stays owned by Print OS — same rule as {@link updateJobOperation} finally.
 */
async function flagJobOperationDurationsForImpositionJobs(
    impositionId: string,
    operationId: string,
    completedAt: Date
): Promise<void> {
    if (operationId === 'op001') return;

    const jobMap = await getJobMapFromImpositionId(impositionId);
    if (!jobMap || jobMap.size === 0) return;

    const logsClient = await logsPool.connect();
    try {
        for (const [jobId, versionTags] of jobMap.entries()) {
            for (const versionTag of versionTags) {
                try {
                    await logsClient.query(`SELECT update_operation_duration($1, $2, $3)`, [
                        jobId,
                        versionTag,
                        operationId,
                    ]);
                } catch (durationError: unknown) {
                    const msg = durationError instanceof Error ? durationError.message : String(durationError);
                    console.warn(
                        `[flagJobOperationDurationsForImpositionJobs] update_operation_duration failed for ${jobId}/${versionTag}/${operationId}:`,
                        msg
                    );
                }

                const u = await logsClient.query(
                    `UPDATE job_operation_duration
                     SET operation_completed_at = COALESCE(
                         operation_completed_at,
                         COALESCE(operation_started_at, $4::timestamp)
                     ),
                     updated_at = NOW()
                     WHERE job_id = $1 AND version_tag = $2 AND operation_id = $3`,
                    [jobId, versionTag, operationId, completedAt]
                );

                if (u.rowCount === 0) {
                    await logsClient.query(
                        `INSERT INTO job_operation_duration (
                            job_id,
                            version_tag,
                            operation_id,
                            machine_id,
                            operation_duration_seconds,
                            operation_started_at,
                            operation_completed_at,
                            updated_at
                        )
                        VALUES ($1, $2, $3, NULL, NULL, $4::timestamp, $4::timestamp, NOW())
                        ON CONFLICT (job_id, version_tag, operation_id) DO UPDATE SET
                            operation_completed_at = COALESCE(
                                job_operation_duration.operation_completed_at,
                                EXCLUDED.operation_completed_at
                            ),
                            operation_started_at = COALESCE(
                                job_operation_duration.operation_started_at,
                                EXCLUDED.operation_started_at
                            ),
                            updated_at = NOW()`,
                        [jobId, versionTag, operationId, completedAt]
                    );
                }
            }
        }
    } finally {
        logsClient.release();
    }
}

/** Log once if `"print OS"` table is absent (avoids spam every processing tick). */
let printOsTableMissingLogged = false;

/** Log once if `production_planner_paths` is missing on the app DB. */
let productionPlannerPathsMissingLogged = false;

/** Log once if legacy `public.jobs` is missing on the app DB (Prisma-only installs). */
let jobsTableMissingLogged = false;

interface PrintOSRecord {
    id: number;
    name: string; // imposition_id
    status: string; // 'PRINTED' or 'ABORTED'
    marker: number;
    job_complete_time: Date;
    copies: number;
    payload?: any; // JSONB payload containing jobElapseTime, jobSubmitTime, etc.
}

/**
 * Get last processed marker for a given marker type
 */
async function getLastProcessedMarker(
    markerType: 'print_os' | 'scanned_codes' | 'printbeat_enrich'
): Promise<number> {
    const client = await appPool.connect();
    try {
        const result = await client.query(
            'SELECT last_processed_id FROM processing_markers WHERE marker_type = $1',
            [markerType]
        );
        
        if (result.rows.length === 0) {
            return 0;
        }
        
        return parseInt(result.rows[0].last_processed_id) || 0;
    } catch (e) {
        if (isUndefinedTableError(e)) {
            console.warn(
                '[getLastProcessedMarker] processing_markers missing on app DB — run npm run run-migrations. Using 0.'
            );
            return 0;
        }
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Update last processed marker
 */
async function updateLastProcessedMarker(
    markerType: 'print_os' | 'scanned_codes' | 'printbeat_enrich',
    markerId: number
): Promise<void> {
    const client = await appPool.connect();
    try {
        // Use INSERT ... ON CONFLICT to create marker if it doesn't exist
        await client.query(
            `INSERT INTO processing_markers (marker_type, last_processed_id, last_processed_at, updated_at)
             VALUES ($1, $2, NOW(), NOW())
             ON CONFLICT (marker_type) DO UPDATE SET
                 last_processed_id = EXCLUDED.last_processed_id,
                 last_processed_at = NOW(),
                 updated_at = NOW()`,
            [markerType, markerId]
        );
    } catch (e) {
        if (isUndefinedTableError(e)) {
            console.warn(
                '[updateLastProcessedMarker] processing_markers missing on app DB — run npm run run-migrations. Skipping.'
            );
            return;
        }
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Get file_ids for an imposition_id
 */
export async function getFileIdsForImposition(impositionId: string): Promise<string[]> {
    return withImpositionFileMappingClient(async (client) => {
        const result = await client.query(
            'SELECT file_id FROM imposition_file_mapping WHERE imposition_id = $1 ORDER BY sequence_order NULLS LAST, file_id',
            [impositionId]
        );
        return result.rows.map((row) => row.file_id);
    });
}

/**
 * Check if Print OS name is a manual prepress file (Labex_<job_id> format)
 * Example: "Labex_4604_5889" -> job_id: "4604_5889"
 * Example: "Labex_4670_5988_MixedLabels_140 x 150 mm_Paper_Matt Laminate_1" -> job_id: "4670_5988"
 * Note: Extracts job_id from beginning, allows additional text after job_id
 */
export function parseManualPrepressFile(name: string): { jobId: string } | null {
    // Pattern: Labex_<job_id> where job_id is numbers separated by underscores
    // Allows additional text after job_id (e.g., "Labex_4670_5988_MixedLabels_...")
    // This distinguishes from full imposition_id format like "Labex_4aa0cb5cd7_100x210_..."
    // The job_id pattern is: \d+(_\d+)+ (at least two numbers separated by underscore)
    const match = name.match(/^Labex_(\d+(_\d+)+)(?:_|$)/);
    if (!match) {
        return null;
    }
    // Regex can absorb a trailing `_<version>` (e.g. Labex_5790_7522_1). Collapse to composite id.
    const jobId = canonicalCompositeJobIdForDisplay(match[1]!);
    return { jobId };
}

function jobDisplayIdFromImpositionFileId(fileId: string): string | null {
    const parsed = parseFileId(fileId);
    if (parsed?.jobId) return canonicalCompositeJobIdForDisplay(parsed.jobId);
    const manual = parseManualPrepressFile(fileId);
    if (manual?.jobId) return manual.jobId;
    return null;
}

function escapeSqlLikePattern(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Distinct strings to try against `imposition_file_mapping` (imposition id, raw scan, legacy prefix). */
function scanCodeDecodeCandidates(storedCodeText: string): string[] {
    const { baseCodeText, legacyImpositionPrefix } = decodeScanCodeText(storedCodeText);
    const out: string[] = [];
    if (legacyImpositionPrefix?.trim()) out.push(legacyImpositionPrefix.trim());
    const b = baseCodeText.trim();
    if (b) out.push(b);
    const s = (storedCodeText ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
    return [...new Set(out)];
}

/**
 * Resolve display job id(s) for Production enrich: imposition_id and file_id rows in
 * `imposition_file_mapping` (version from FILE_* / Labex_*), then Labex substring match, then scan parsers.
 */
async function jobDisplayIdsFromImpositionFileMappingClient(
    client: PoolClient,
    candidates: string[]
): Promise<{ ok: true; ids: string[] } | { ok: false; reason: 'missing_table' }> {
    const out = new Set<string>();

    const safeQuery = async <T>(run: () => Promise<T>): Promise<T | null> => {
        try {
            return await run();
        } catch (e) {
            if (isUndefinedTableError(e)) return null;
            throw e;
        }
    };

    for (const key of candidates) {
        const q = await safeQuery(() =>
            client.query(
                `SELECT file_id FROM imposition_file_mapping WHERE imposition_id = $1 ORDER BY sequence_order NULLS LAST, file_id`,
                [key]
            )
        );
        if (q === null) return { ok: false, reason: 'missing_table' };
        if (q.rows.length > 0) {
            for (const r of q.rows) {
                const id = jobDisplayIdFromImpositionFileId(r.file_id as string);
                if (id) out.add(id);
            }
            if (out.size > 0) return { ok: true, ids: Array.from(out) };
        }
    }

    for (const key of candidates) {
        const q = await safeQuery(() =>
            client.query(`SELECT file_id FROM imposition_file_mapping WHERE file_id = $1 LIMIT 1`, [key])
        );
        if (q === null) return { ok: false, reason: 'missing_table' };
        if (q.rows.length > 0) {
            const id = jobDisplayIdFromImpositionFileId(q.rows[0].file_id as string);
            if (id) return { ok: true, ids: [id] };
        }
    }

    for (const key of candidates) {
        if (!/labex/i.test(key)) continue;
        const esc = escapeSqlLikePattern(key);
        const likeRows = await safeQuery(() =>
            client.query(
                `SELECT file_id FROM imposition_file_mapping WHERE file_id LIKE $1 ESCAPE '\\' LIMIT 25`,
                [`%${esc}%`]
            )
        );
        if (likeRows === null) return { ok: false, reason: 'missing_table' };
        for (const r of likeRows.rows) {
            const id = jobDisplayIdFromImpositionFileId(r.file_id as string);
            if (id) out.add(id);
        }
        if (out.size > 0) return { ok: true, ids: Array.from(out) };
    }

    return { ok: true, ids: [] };
}

async function resolveJobDisplayIdsFromScanCode(
    client: PoolClient,
    storedCodeText: string
): Promise<string[]> {
    const candidates = scanCodeDecodeCandidates(storedCodeText);

    let fromIfm = await jobDisplayIdsFromImpositionFileMappingClient(client, candidates);
    if (!fromIfm.ok && isDedicatedLogsDatabase()) {
        const ac = await appPool.connect();
        try {
            fromIfm = await jobDisplayIdsFromImpositionFileMappingClient(ac, candidates);
        } finally {
            ac.release();
        }
    }

    if (fromIfm.ok && fromIfm.ids.length > 0) return fromIfm.ids;

    const decoded = decodeScanCodeText(storedCodeText);
    const primary = scanCodeToJobDisplayId(decoded.baseCodeText);
    if (primary) return [primary];
    for (const key of candidates) {
        const d = scanCodeToJobDisplayId(key);
        if (d) return [d];
    }
    return [];
}

/**
 * Get all version_tags for a job_id from job_operations table
 */
async function getAllVersionTagsForJob(jobId: string): Promise<string[]> {
    const client = await poolForPipelineTables().connect();
    try {
        const result = await client.query(
            'SELECT DISTINCT version_tag FROM job_operations WHERE job_id = $1',
            [jobId]
        );
        return result.rows.map(row => row.version_tag);
    } finally {
        client.release();
    }
}

/**
 * Get operation_id for print operation from scheduler.Operation
 */
async function getPrintOperationId(): Promise<string> {
    return getCachedSchedulerPrintOperationId();
}

/**
 * Get all job_ids and version_tags from file_ids
 */
export function extractJobIdsFromFileIds(fileIds: string[]): Map<string, Set<string>> {
    // Map: jobId -> Set of versionTags
    const jobMap = new Map<string, Set<string>>();
    
    for (const fileId of fileIds) {
        const parsed = parseFileId(fileId);
        if (parsed) {
            if (!jobMap.has(parsed.jobId)) {
                jobMap.set(parsed.jobId, new Set());
            }
            jobMap.get(parsed.jobId)!.add(parsed.versionTag);
        }
    }
    
    return jobMap;
}

/**
 * Update imposition_operations table
 */
async function updateImpositionOperation(
    impositionId: string,
    operationId: string,
    status: 'completed' | 'aborted',
    sourceId: number,
    completedAt: Date,
    completedBy: 'scanner' | 'print_os' = 'scanner'
): Promise<void> {
    const client = await poolForPipelineTables().connect();
    try {
        // Try UPDATE first (row should already exist in imposition_operations)
        // If row doesn't exist, that's okay - it means this operation wasn't planned for this imposition
        const updateResult = await client.query(
            `UPDATE imposition_operations 
             SET completed_at = $1,
                 completed_by = $2,
                 source_id = $3,
                 status = $4
             WHERE imposition_id = $5 
             AND operation_id = $6`,
            [completedAt, completedBy, sourceId, status, impositionId, operationId]
        );
        
        // If no rows updated, log a warning but don't fail (operation might not be planned for this imposition)
        if (updateResult.rowCount === 0) {
            console.warn(`No imposition_operations row found for imposition_id=${impositionId}, operation_id=${operationId} - skipping update`);
        }
    } catch (error: any) {
        // If status column doesn't exist, try without it
        const errorMsg = error.message || String(error);
        if (errorMsg.includes('column') && errorMsg.includes('status')) {
            try {
                const updateResult = await client.query(
                    `UPDATE imposition_operations 
                     SET completed_at = $1,
                         completed_by = $2,
                         source_id = $3
                     WHERE imposition_id = $4 
                     AND operation_id = $5`,
                    [completedAt, completedBy, sourceId, impositionId, operationId]
                );
                if (updateResult.rowCount === 0) {
                    console.warn(`No imposition_operations row found for imposition_id=${impositionId}, operation_id=${operationId} - skipping update`);
                }
                // Successfully handled - don't re-throw, just return silently
                return;
            } catch (retryError: any) {
                // If retry also fails, log but don't throw (to avoid double error logging)
                console.warn(`Retry update failed for imposition_id=${impositionId}, operation_id=${operationId}:`, retryError.message);
                return; // Don't throw - error already handled
            }
        } else {
            throw error;
        }
    } finally {
        client.release();
    }
}

/**
 * Update job_operations table
 */
async function updateJobOperation(
    jobId: string,
    versionTag: string,
    operationId: string,
    status: 'completed' | 'aborted',
    sourceId: number,
    completedAt: Date,
    completedBy: 'scanner' | 'print_os' = 'scanner'
): Promise<void> {
    const client = await poolForPipelineTables().connect();
    try {
        // Try UPDATE (row should already exist in job_operations)
        // If row doesn't exist, that's okay - it means this operation wasn't planned for this job
        const updateResult = await client.query(
            `UPDATE job_operations 
             SET completed_at = $1,
                 completed_by = $2,
                 source_id = $3,
                 status = $4
             WHERE job_id = $5 
             AND version_tag = $6 
             AND operation_id = $7`,
            [completedAt, completedBy, sourceId, status, jobId, versionTag, operationId]
        );
        
        // If no rows updated, try to create the row (operation might not have been planned)
        if (updateResult.rowCount === 0) {
            console.log(`No job_operations row found for job_id=${jobId}, version_tag=${versionTag}, operation_id=${operationId} - creating new row`);
            try {
                // Generate job_operation_id (format: job_id_version_tag_operation_id)
                const jobOperationId = `${jobId}_${versionTag}_${operationId}`;
                
                // Try INSERT with ON CONFLICT to handle race conditions
                const insertResult = await client.query(
                    `INSERT INTO job_operations (
                        job_operation_id,
                        job_id,
                        version_tag,
                        operation_id,
                        completed_at,
                        completed_by,
                        source_id,
                        status,
                        sequence_order,
                        required
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, false)
                    ON CONFLICT (job_operation_id) DO UPDATE SET
                        completed_at = EXCLUDED.completed_at,
                        completed_by = EXCLUDED.completed_by,
                        source_id = EXCLUDED.source_id,
                        status = EXCLUDED.status
                    RETURNING *`,
                    [jobOperationId, jobId, versionTag, operationId, completedAt, completedBy, sourceId, status]
                );
                
                if (insertResult.rowCount === 0) {
                    console.warn(`Failed to create job_operations row for job_id=${jobId}, version_tag=${versionTag}, operation_id=${operationId}`);
                    return; // duration still applied in outer finally (logs DB)
                }
                
                console.log(`✓ Created job_operations row for job_id=${jobId}, version_tag=${versionTag}, operation_id=${operationId}`);
            } catch (insertError: any) {
                // If insert fails, try UPDATE again (might have been created by another process)
                const retryUpdateResult = await client.query(
                    `UPDATE job_operations 
                     SET completed_at = $1,
                         completed_by = $2,
                         source_id = $3,
                         status = $4
                     WHERE job_id = $5 
                     AND version_tag = $6 
                     AND operation_id = $7`,
                    [completedAt, completedBy, sourceId, status, jobId, versionTag, operationId]
                );
                
                if (retryUpdateResult.rowCount === 0) {
                    console.warn(`Could not create or update job_operations row for job_id=${jobId}, version_tag=${versionTag}, operation_id=${operationId}:`, insertError.message);
                    return; // duration still applied in outer finally (logs DB)
                }
            }
        }

        // For op001 (print operation) from Print OS, duration will be set separately
        // when processing Print OS records (they have access to payload with jobElapseTime)
    } catch (error: any) {
        // If status column doesn't exist, try without it
        const errorMsg = error.message || String(error);
        if (errorMsg.includes('column') && errorMsg.includes('status')) {
            try {
                const updateResult = await client.query(
                    `UPDATE job_operations 
                     SET completed_at = $1,
                         completed_by = $2,
                         source_id = $3
                     WHERE job_id = $4 
                     AND version_tag = $5 
                     AND operation_id = $6`,
                    [completedAt, completedBy, sourceId, jobId, versionTag, operationId]
                );
                if (updateResult.rowCount === 0) {
                    // Try to create the row
                    const jobOperationId = `${jobId}_${versionTag}_${operationId}`;
                    try {
                        await client.query(
                            `INSERT INTO job_operations (
                                job_operation_id,
                                job_id,
                                version_tag,
                                operation_id,
                                completed_at,
                                completed_by,
                                source_id,
                                sequence_order,
                                required
                            )
                            VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, false)
                            ON CONFLICT (job_operation_id) DO UPDATE SET
                                completed_at = EXCLUDED.completed_at,
                                completed_by = EXCLUDED.completed_by,
                                source_id = EXCLUDED.source_id`,
                            [jobOperationId, jobId, versionTag, operationId, completedAt, completedBy, sourceId]
                        );
                        console.log(`✓ Created job_operations row (retry path) for job_id=${jobId}, version_tag=${versionTag}, operation_id=${operationId}`);
                    } catch (insertError: any) {
                        console.warn(`Could not create job_operations row for job_id=${jobId}, version_tag=${versionTag}, operation_id=${operationId}:`, insertError.message);
                    }
                }
                // Successfully handled - don't re-throw, just return silently
                return;
            } catch (retryError: any) {
                // If retry also fails, log but don't throw (to avoid double error logging)
                console.warn(`Retry update failed for job_id=${jobId}, version_tag=${versionTag}, operation_id=${operationId}:`, retryError.message);
                return; // Don't throw - error already handled
            }
        } else {
            throw error;
        }
    } finally {
        // job_operation_duration is on logs DB and comes from scanned_codes; refresh even when
        // job_operations INSERT fails (e.g. FK to public.jobs on Prisma-only installs without legacy jobs rows).
        if (completedBy === 'scanner' && status === 'completed' && operationId !== 'op001') {
            const logsClient = await logsPool.connect();
            try {
                await logsClient.query(`SELECT update_operation_duration($1, $2, $3)`, [
                    jobId,
                    versionTag,
                    operationId,
                ]);
            } catch (durationError: any) {
                console.warn(
                    `Could not calculate operation duration for job_id=${jobId}, version_tag=${versionTag}, operation_id=${operationId}:`,
                    durationError.message
                );
            } finally {
                logsClient.release();
            }
        }
        client.release();
    }
}

/**
 * Prisma `scheduler.Machine.id` for Indigo (matches GET /api/machines).
 */
export async function getCachedIndigoMachineId(): Promise<string | null> {
    const m = await getCachedSchedulerMachineByUniqueName('hp_indigo_6900');
    return m?.id ?? null;
}

export async function getCachedDigitalCutterMachineId(): Promise<string | null> {
    const m = await getCachedSchedulerMachineByUniqueName('digital_cutter');
    return m?.id ?? null;
}

/** One-time style backfill: legacy Print OS rows used machine_id HP_INDIGO_6900. */
export async function backfillLegacyIndigoMachineIdsOnLogs(): Promise<void> {
    const id = await getCachedIndigoMachineId();
    if (!id) return;
    const client = await logsPool.connect();
    try {
        const r = await client.query(
            `UPDATE job_operation_duration SET machine_id = $1, updated_at = NOW()
             WHERE machine_id = 'HP_INDIGO_6900'`,
            [id]
        );
        if (r.rowCount && r.rowCount > 0) {
            console.log(
                `[backfill] job_operation_duration: ${r.rowCount} row(s) HP_INDIGO_6900 → Indigo machine UUID`
            );
        }
    } catch (e: any) {
        console.warn('[backfill] legacy Indigo machine_id:', e?.message || e);
    } finally {
        client.release();
    }
}

/**
 * Update operation duration from Print OS payload (for op001 only)
 * Extracts jobElapseTime from Print OS payload and stores it in job_operation_duration
 */
async function updatePrintOSDuration(
    jobId: string,
    versionTag: string,
    operationId: string,
    printOSPayload: any,
    completedAt: Date
): Promise<void> {
    const client = await logsPool.connect();
    try {
        const indigoMachineId = (await getCachedIndigoMachineId()) ?? 'HP_INDIGO_6900';

        // Extract duration from Print OS payload (optional — still write completion time without payload)
        let durationSeconds: number | null = null;
        let startedAt: Date | null = null;

        if (printOSPayload) {
            const payload = typeof printOSPayload === 'string' ? JSON.parse(printOSPayload) : printOSPayload;

            // jobElapseTime is in seconds
            if (payload.jobElapseTime !== undefined && payload.jobElapseTime !== null) {
                durationSeconds = parseInt(String(payload.jobElapseTime), 10) || null;
            }

            // Calculate started_at from completed_at and duration
            if (durationSeconds !== null && completedAt) {
                startedAt = new Date(completedAt.getTime() - durationSeconds * 1000);
            } else if (payload.jobSubmitTime) {
                startedAt = new Date(payload.jobSubmitTime);
            }
        }

        // Format timestamps as Australian local time strings for storage
        // This ensures PostgreSQL stores them as Australian time, not UTC
        const formatAuTimestamp = (date: Date | null): string | null => {
            if (!date) return null;
            const formatter = new Intl.DateTimeFormat('en-AU', {
                timeZone: 'Australia/Sydney',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
            });

            const parts = formatter.formatToParts(date);
            const year = parts.find((p) => p.type === 'year')?.value;
            const month = parts.find((p) => p.type === 'month')?.value;
            const day = parts.find((p) => p.type === 'day')?.value;
            const hour = parts.find((p) => p.type === 'hour')?.value;
            const minute = parts.find((p) => p.type === 'minute')?.value;
            const second = parts.find((p) => p.type === 'second')?.value;

            return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
        };

        const startedAtString = formatAuTimestamp(startedAt);
        const completedAtString = formatAuTimestamp(completedAt);

        await client.query(
            `
            INSERT INTO job_operation_duration (
                job_id,
                version_tag,
                operation_id,
                machine_id,
                operation_duration_seconds,
                operation_started_at,
                operation_completed_at,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (job_id, version_tag, operation_id) DO UPDATE SET
                machine_id = EXCLUDED.machine_id,
                operation_duration_seconds = COALESCE(
                    EXCLUDED.operation_duration_seconds,
                    job_operation_duration.operation_duration_seconds
                ),
                operation_started_at = COALESCE(EXCLUDED.operation_started_at, job_operation_duration.operation_started_at),
                operation_completed_at = COALESCE(EXCLUDED.operation_completed_at, job_operation_duration.operation_completed_at),
                updated_at = NOW();
        `,
            [jobId, versionTag, operationId, indigoMachineId, durationSeconds, startedAtString, completedAtString]
        );
    } catch (error: any) {
        // Log but don't fail - duration update is optional
        console.warn(
            `Could not update Print OS duration for job_id=${jobId}, version_tag=${versionTag}, operation_id=${operationId}:`,
            error.message
        );
    } finally {
        client.release();
    }
}

/**
 * Update jobs.operations JSONB field and status
 */
async function updateJobOperationsField(
    jobId: string,
    operationName: string,
    value: boolean
): Promise<void> {
    const client = await appPool.connect();
    try {
        // Update the operations JSONB field and status
        await client.query(
            `UPDATE jobs 
             SET operations = jsonb_set(
                 COALESCE(operations, '{}'::jsonb),
                 $1,
                 $2::text::jsonb,
                 true
             ),
             status = CASE 
                 WHEN status IS NULL OR status = '' THEN 'started'
                 WHEN status = 'pending' THEN 'started'
                 ELSE status
             END,
             updated_at = NOW()
             WHERE job_id = $3`,
            [`{${operationName}}`, JSON.stringify(value), jobId]
        );
    } catch (e) {
        if (isUndefinedTableError(e)) {
            if (!jobsTableMissingLogged) {
                jobsTableMissingLogged = true;
                console.warn(
                    '[processScannedCodes] public.jobs missing on app DB — skipping jobs.operations JSONB updates (Prisma-only installs).'
                );
            }
            return;
        }
        throw e;
    } finally {
        client.release();
    }
}

/** UPDATE public.jobs — no-op if the legacy table is absent (Prisma-only app DB). */
async function safeUpdateJobsOnApp(
    client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
    text: string,
    values: unknown[]
): Promise<boolean> {
    try {
        await client.query(text, values);
        return true;
    } catch (e) {
        if (isUndefinedTableError(e)) {
            if (!jobsTableMissingLogged) {
                jobsTableMissingLogged = true;
                console.warn(
                    '[checkAndUpdateJobPrintStatus] public.jobs missing on app DB — skipping jobs.operations updates (Prisma-only installs).'
                );
            }
            return false;
        }
        throw e;
    }
}

/**
 * Get all file_ids for a job_id across all impositions
 */
async function getAllFileIdsForJob(jobId: string, versionTag: string): Promise<string[]> {
    return withImpositionFileMappingClient(async (client) => {
        const pattern = fileIdPatternStrict(jobId, versionTag);

        const result = await client.query(
            `SELECT DISTINCT file_id 
             FROM imposition_file_mapping 
             WHERE file_id LIKE $1`,
            [pattern]
        );

        let ids = result.rows.map((row) => row.file_id);

        if (ids.length === 0 && isNumericVersionSuffix(versionTag)) {
            const loose = await client.query(
                `SELECT DISTINCT file_id 
                 FROM imposition_file_mapping 
                 WHERE file_id LIKE $1`,
                [fileIdPatternLoose(jobId)]
            );
            ids = loose.rows.map((row) => row.file_id);
        }

        if (ids.length === 0) {
            const labex = await client.query(
                `SELECT DISTINCT file_id 
                 FROM imposition_file_mapping 
                 WHERE file_id LIKE $1`,
                [labexJobIdSegmentPattern(jobId)]
            );
            ids = labex.rows.map((row) => row.file_id);
        }

        return ids;
    });
}

/**
 * Check if all files for a job are printed and update job status accordingly
 */
async function checkAndUpdateJobPrintStatus(jobId: string, versionTag: string): Promise<void> {
    const pipelineClient = await poolForPipelineTables().connect();
    const appClient = await appPool.connect();

    try {
        const fileIds = await getAllFileIdsForJob(jobId, versionTag);

        if (fileIds.length === 0) {
            return;
        }

        const printOperationId = await getPrintOperationId();

        const impositionIds = await withImpositionFileMappingClient(async (planner) => {
            const impositionResult = await planner.query(
                `SELECT DISTINCT imposition_id 
                 FROM imposition_file_mapping 
                 WHERE file_id = ANY($1)`,
                [fileIds]
            );
            return impositionResult.rows.map((row) => row.imposition_id as string);
        });
        
        if (impositionIds.length === 0) {
            return;
        }

        // Count how many impositions have been printed (completed status)
        const result = await pipelineClient.query(
            `SELECT COUNT(*) as total_impositions,
                    COUNT(CASE WHEN status = 'completed' THEN 1 END) as printed_impositions,
                    COUNT(CASE WHEN status = 'aborted' THEN 1 END) as aborted_impositions
             FROM imposition_operations
             WHERE imposition_id = ANY($1)
             AND operation_id = $2`,
            [impositionIds, printOperationId]
        );

        const stats = result.rows[0];
        const totalImpositions = parseInt(stats.total_impositions) || 0;
        const printedImpositions = parseInt(stats.printed_impositions) || 0;
        const abortedImpositions = parseInt(stats.aborted_impositions) || 0;

        // Update job status based on completion
        if (printedImpositions === totalImpositions && totalImpositions > 0) {
            // All impositions printed - update operations and status
            const ok = await safeUpdateJobsOnApp(
                appClient,
                `UPDATE jobs 
                 SET operations = jsonb_set(
                     COALESCE(operations, '{}'::jsonb),
                     '{print}',
                     'true'::jsonb,
                     true
                 ),
                 status = CASE 
                     WHEN status IS NULL OR status = '' THEN 'started'
                     WHEN status = 'pending' THEN 'started'
                     ELSE status
                 END,
                 updated_at = NOW()
                 WHERE job_id = $1`,
                [jobId]
            );
            if (ok) {
                console.log(`  ✓ Job ${jobId} (v${versionTag}): All ${totalImpositions} impositions printed`);
            }
        } else if (abortedImpositions === totalImpositions && totalImpositions > 0) {
            // All impositions aborted
            const ok = await safeUpdateJobsOnApp(
                appClient,
                `UPDATE jobs 
                 SET operations = jsonb_set(
                     COALESCE(operations, '{}'::jsonb),
                     '{print}',
                     'false'::jsonb,
                     true
                 ),
                 updated_at = NOW()
                 WHERE job_id = $1`,
                [jobId]
            );
            if (ok) {
                console.log(`  ✗ Job ${jobId} (v${versionTag}): All ${totalImpositions} impositions aborted`);
            }
        } else if (printedImpositions > 0) {
            // Partial completion - update status to started
            const ok = await safeUpdateJobsOnApp(
                appClient,
                `UPDATE jobs 
                 SET status = CASE 
                     WHEN status IS NULL OR status = '' THEN 'started'
                     WHEN status = 'pending' THEN 'started'
                     ELSE status
                 END,
                 updated_at = NOW()
                 WHERE job_id = $1`,
                [jobId]
            );
            if (ok) {
                console.log(`  ⚠ Job ${jobId} (v${versionTag}): Partial completion (${printedImpositions}/${totalImpositions} impositions printed)`);
            }
        }
    } finally {
        pipelineClient.release();
        appClient.release();
    }
}

/**
 * Process Print OS records and update job statuses
 */
export async function processPrintOSRecords(): Promise<{
    processed: number;
    jobsUpdated: number;
    lastMarker: number;
    errors: string[];
}> {
    const errors: string[] = [];
    let processed = 0;
    let jobsUpdated = 0;

    const lastProcessedMarker = await getLastProcessedMarker('print_os');
    const useRowId = printOsCursorUsesRowId();
    const cursorColumn = useRowId ? 'id' : 'marker';
    console.log(`Processing Print OS records with ${cursorColumn} > ${lastProcessedMarker}`);

    let lastCursorReported = lastProcessedMarker;

    // Get unprocessed Print OS records (JOBMANAGER_DATABASE_URL when set, else app DB)
    const printOSClient = await getPrintOsPool().connect();

    try {
        // Query "print OS" table (note: table name has space, must be quoted)
        // Fetch new rows, deduplicate by name (imposition_id) — keep latest by id or marker
        let printOSResult;
        try {
            printOSResult = await printOSClient.query(
                // Press emits Sydney local wall-clock but tags it `+00:00` (see payload jobCompleteTime vs
                // jobCompleteTimeLocalized — identical digits). Stored timestamptz is therefore +10h late.
                // Strip the bogus UTC label and reinterpret the digits as Sydney to recover the true instant.
                `SELECT id, name, status, marker,
                        ((job_complete_time AT TIME ZONE 'UTC') AT TIME ZONE 'Australia/Sydney') AS job_complete_time,
                        copies, payload
                 FROM "print OS"
                 WHERE ${cursorColumn} > $1
                 ORDER BY ${cursorColumn} ASC`,
                [lastProcessedMarker]
            );
        } catch (e) {
            if (isUndefinedTableError(e)) {
                if (!printOsTableMissingLogged) {
                    printOsTableMissingLogged = true;
                    console.warn(
                        '[processPrintOSRecords] table "print OS" missing on Print OS DB (set JOBMANAGER_DATABASE_URL if it lives on jobmanager) — skipping Print OS processing.'
                    );
                }
                return {
                    processed: 0,
                    jobsUpdated: 0,
                    lastMarker: lastProcessedMarker,
                    errors: [],
                };
            }
            throw e;
        }

        if (printOSResult.rows.length === 0) {
            return { processed: 0, jobsUpdated: 0, lastMarker: lastProcessedMarker, errors: [] };
        }

        const recordsMap = new Map<string, PrintOSRecord>();
        for (const row of printOSResult.rows) {
            const name = row.name;
            const marker = parseInt(String(row.marker), 10) || 0;
            const rawId = Number(String(row.id));

            const prev = recordsMap.get(name);
            const isNewer = !prev || (useRowId ? prev.id < rawId : prev.marker < marker);
            if (isNewer) {
                recordsMap.set(name, {
                    id: rawId,
                    name: name,
                    status: row.status,
                    marker,
                    job_complete_time: row.job_complete_time,
                    copies: parseInt(String(row.copies), 10) || 0,
                    payload: row.payload,
                });
            }
        }

        const records = Array.from(recordsMap.values());
        const duplicateCount = printOSResult.rows.length - records.length;

        const maxFetchedCursor = printOSResult.rows.reduce((m, r) => {
            const v = useRowId ? Number(String(r.id)) : parseInt(String(r.marker), 10) || 0;
            return Math.max(m, v);
        }, 0);

        console.log(`Found ${printOSResult.rows.length} new Print OS records`);
        if (duplicateCount > 0) {
            console.log(
                `  Deduplicated: ${duplicateCount} duplicate records removed (latest by ${useRowId ? 'id' : 'marker'})`
            );
        }
        console.log(`  Processing ${records.length} unique records`);

        // Get operation_id for print operation
        const printOperationId = await getPrintOperationId();
        console.log(`Using operation_id: ${printOperationId} for print operations`);

        // Process each record
        for (const record of records) {
            try {
                const name = record.name;
                const status = record.status === 'PRINTED' ? 'completed' : 'aborted';
                
                // job_complete_time is timestamptz on jobmanager `"print OS"` (absolute instant).
                let completedAt: Date;
                const completedIso = pgTimestampToIsoUtc(record.job_complete_time);
                if (completedIso) {
                    completedAt = new Date(completedIso);
                } else {
                    completedAt = new Date();
                }

                // Resolve job/version coverage (hyphen Labex multi-job, IFM imposition id, Labex manual, fallback)
                const jobIdsListed = await resolveJobIdsFromPressLine(name);

                const workingJobMap = new Map<string, Set<string>>();
                const fileIdsFromName = await getFileIdsForImposition(name.trim());
                const ifmJobs = extractJobIdsFromFileIds(fileIdsFromName);
                if (ifmJobs.size > 0) {
                    for (const [jid, vTags] of ifmJobs) {
                        workingJobMap.set(jid, new Set(vTags));
                    }
                }
                for (const jid of jobIdsListed) {
                    if (workingJobMap.has(jid)) continue;
                    const vt = await getAllVersionTagsForJob(jid);
                    workingJobMap.set(jid, new Set(vt.length > 0 ? vt : ['1']));
                }

                if (workingJobMap.size === 0) {
                    if (name.toLowerCase().includes('labex')) {
                        console.warn(`Labex file found but jobs not resolved: ${name}`);
                        errors.push(`Labex file but jobs not resolved: ${name}`);
                    } else {
                        console.warn(`Print OS name produced no jobs: ${name}`);
                    }
                    continue;
                }

                if (fileIdsFromName.length > 0) {
                    await updateImpositionOperation(
                        name.trim(),
                        printOperationId,
                        status,
                        record.id,
                        completedAt,
                        'print_os'
                    );
                }

                const uniqueJobs = new Set<string>();
                for (const [jobId, versionTags] of workingJobMap) {
                    for (const versionTag of versionTags) {
                        await updateJobOperation(
                            jobId,
                            versionTag,
                            printOperationId,
                            status,
                            record.id,
                            completedAt,
                            'print_os'
                        );

                        if (status === 'completed' && printOperationId === 'op001') {
                            await updatePrintOSDuration(
                                jobId,
                                versionTag,
                                printOperationId,
                                record.payload,
                                completedAt
                            );
                        }

                        uniqueJobs.add(`${jobId}_${versionTag}`);
                    }
                }

                jobsUpdated += uniqueJobs.size;
                processed++;

                console.log(`✓ Processed Print OS record ${record.id}: ${name}, status: ${status}, updated ${uniqueJobs.size} job/version row(s)`);

                for (const jobKey of uniqueJobs) {
                    const lastUnderscore = jobKey.lastIndexOf('_');
                    if (lastUnderscore > 0) {
                        const jobIdPart = jobKey.substring(0, lastUnderscore);
                        const versionTagPart = jobKey.substring(lastUnderscore + 1);
                        await checkAndUpdateJobPrintStatus(jobIdPart, versionTagPart);
                    }
                }

            } catch (error: any) {
                console.error(`✗ Error processing Print OS record ${record.id}:`, error.message);
                errors.push(`Record ${record.id}: ${error.message}`);
            }
        }

        if (maxFetchedCursor > lastProcessedMarker) {
            await updateLastProcessedMarker('print_os', maxFetchedCursor);
            lastCursorReported = maxFetchedCursor;
            console.log(
                `Updated last processed ${cursorColumn} cursor to ${maxFetchedCursor} (processed ${processed}, unique ${records.length}, errors ${errors.length})`
            );
        }

    } finally {
        printOSClient.release();
    }

    return {
        processed,
        jobsUpdated,
        lastMarker: lastCursorReported,
        errors,
    };
}

/**
 * Verify that an operation_id exists in scheduler.Operation (app DB).
 * Match is case-insensitive on primary `id` or `plannerOperationId` (DB column operation_id).
 */
async function verifyOperationIdExists(operationId: string): Promise<boolean> {
    const found = await prisma.operation.findFirst({
        where: {
            OR: [
                { id: { equals: operationId, mode: 'insensitive' } },
                { plannerOperationId: { equals: operationId, mode: 'insensitive' } },
            ],
        },
        select: { id: true },
    });
    return found != null;
}

/**
 * Get operation name by planner id or primary id.
 */
async function getOperationNameById(operationId: string): Promise<string | null> {
    const op = await prisma.operation.findFirst({
        where: {
            OR: [
                { id: { equals: operationId, mode: 'insensitive' } },
                { plannerOperationId: { equals: operationId, mode: 'insensitive' } },
            ],
        },
        select: { name: true },
    });
    return op?.name ?? null;
}

/**
 * Map operation name to operation_id
 * This maps frontend operation names to database operation_ids
 */
async function getOperationIdByName(operationName: string): Promise<string | null> {
    const normalized = operationName.toLowerCase().trim();

    const operationMap: Record<string, string> = {
        print: 'op001',
        printing: 'op001',
        coat: 'op002',
        coating: 'op002',
        'kiss-cut': 'op003',
        'kiss cut': 'op003',
        kisscut: 'op003',
        slit: 'op004',
        slitter: 'op004',
        slitting: 'op004',
        laminate: 'op005',
        laminating: 'op005',
    };

    if (operationMap[normalized]) {
        return operationMap[normalized];
    }

    const op = await prisma.operation.findFirst({
        where: {
            name: { contains: normalized, mode: 'insensitive' },
            enabled: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { id: true, plannerOperationId: true },
    });
    if (op) {
        const planner = op.plannerOperationId?.trim();
        if (planner) return planner.toLowerCase();
        return op.id.toLowerCase();
    }

    return null;
}

/**
 * Check if code_text is a runlist_id
 */
async function isRunlistId(codeText: string): Promise<boolean> {
    if (productionPlannerPathsMissingLogged) {
        return false;
    }
    try {
        return await withPlannerAppThenLogsOnEmpty(async (client) => {
            const result = await client.query(
                'SELECT EXISTS(SELECT 1 FROM production_planner_paths WHERE runlist_id = $1 LIMIT 1)',
                [codeText]
            );
            return Boolean(result.rows[0]?.exists);
        }, (exists) => !exists);
    } catch (e) {
        if (isUndefinedTableError(e)) {
            productionPlannerPathsMissingLogged = true;
            return false;
        }
        throw e;
    }
}

/**
 * Get all job_ids from a runlist_id
 */
async function getJobIdsFromRunlist(runlistId: string): Promise<Map<string, Set<string>>> {
    if (productionPlannerPathsMissingLogged) {
        return new Map();
    }
    try {
        return await withImpositionFileMappingClient(async (client) => {
            console.log(`[getJobIdsFromRunlist] Getting jobs for runlist: ${runlistId}`);
            let impositionsResult;
            try {
                impositionsResult = await client.query(
                    'SELECT DISTINCT imposition_id FROM production_planner_paths WHERE runlist_id = $1',
                    [runlistId]
                );
            } catch (e) {
                if (isUndefinedTableError(e)) {
                    if (!productionPlannerPathsMissingLogged) {
                        productionPlannerPathsMissingLogged = true;
                        console.warn(
                            '[getJobIdsFromRunlist] table "production_planner_paths" missing — run migrations. Skipping runlist expansion.'
                        );
                    }
                    return new Map();
                }
                throw e;
            }

            console.log(`[getJobIdsFromRunlist] Found ${impositionsResult.rows.length} impositions in runlist`);
            const jobMap = new Map<string, Set<string>>();

            for (const row of impositionsResult.rows) {
                const impositionId = row.imposition_id;
                const fileResult = await client.query(
                    'SELECT file_id FROM imposition_file_mapping WHERE imposition_id = $1 ORDER BY sequence_order NULLS LAST, file_id',
                    [impositionId]
                );
                const fileIds = fileResult.rows.map((r) => r.file_id);
                console.log(`[getJobIdsFromRunlist] Imposition ${impositionId} has ${fileIds.length} file_ids`);

                for (const fileId of fileIds) {
                    const parsed = parseFileId(fileId);
                    if (parsed) {
                        console.log(
                            `[getJobIdsFromRunlist] Parsed file_id "${fileId}" -> jobId: "${parsed.jobId}", version: "${parsed.versionTag}"`
                        );
                        if (!jobMap.has(parsed.jobId)) {
                            jobMap.set(parsed.jobId, new Set());
                        }
                        jobMap.get(parsed.jobId)!.add(parsed.versionTag);
                    } else {
                        console.log(`[getJobIdsFromRunlist] Could not parse file_id: "${fileId}"`);
                    }
                }
            }

            console.log(`[getJobIdsFromRunlist] Extracted ${jobMap.size} unique jobs from runlist`);
            for (const [jobId, versions] of jobMap.entries()) {
                console.log(`[getJobIdsFromRunlist] Job "${jobId}" has versions: ${Array.from(versions).join(', ')}`);
            }

            return jobMap;
        });
    } catch (e) {
        if (isUndefinedTableError(e)) {
            productionPlannerPathsMissingLogged = true;
            return new Map();
        }
        throw e;
    }
}

/**
 * Find runlist_id from job_id_version_tag scan
 */
async function findRunlistByJobScan(codeText: string): Promise<string | null> {
    if (productionPlannerPathsMissingLogged) {
        return null;
    }
    const jv = parseJobIdVersionTagScan(codeText);
    if (!jv) {
        return null;
    }

    try {
        return await withImpositionFileMappingClient(async (client) => {
            const tryQuery = async (pattern: string, limit: number) =>
                client.query(
                    `SELECT DISTINCT ppp.runlist_id
                     FROM imposition_file_mapping ifm
                     INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
                     WHERE ifm.file_id LIKE $1
                     AND ppp.runlist_id IS NOT NULL
                     LIMIT $2`,
                    [pattern, limit]
                );

            try {
                const strictPat = fileIdPatternStrict(jv.jobId, jv.versionTag);
                const result = await tryQuery(strictPat, 1);

                if (result.rows.length > 0) {
                    return result.rows[0].runlist_id as string;
                }

                if (isNumericVersionSuffix(jv.versionTag)) {
                    const loose = await tryQuery(fileIdPatternLoose(jv.jobId), 3);
                    if (loose.rows.length === 1) {
                        return loose.rows[0].runlist_id as string;
                    }
                    if (loose.rows.length > 1) {
                        console.warn(
                            `[findRunlistByJobScan] loose match for job ${jv.jobId} returned multiple runlists; skipping`
                        );
                    }
                }

                const labex = await tryQuery(labexJobIdSegmentPattern(jv.jobId), 3);
                if (labex.rows.length === 1) {
                    return labex.rows[0].runlist_id as string;
                }
                if (labex.rows.length > 1) {
                    console.warn(
                        `[findRunlistByJobScan] Labex_${jv.jobId} matched multiple runlists; skipping`
                    );
                }

                return null;
            } catch (e) {
                if (isUndefinedTableError(e)) {
                    productionPlannerPathsMissingLogged = true;
                    return null;
                }
                throw e;
            }
        });
    } catch (e) {
        if (isUndefinedTableError(e)) {
            productionPlannerPathsMissingLogged = true;
            return null;
        }
        throw e;
    }
}

/**
 * Get impositions for a job_id
 */
async function getImpositionsForJob(jobId: string, versionTag: string): Promise<string[]> {
    try {
        return await withImpositionFileMappingClient(async (client) => {
            const pattern = fileIdPatternStrict(jobId, versionTag);

            try {
                const result = await client.query(
                    `SELECT DISTINCT imposition_id 
                     FROM imposition_file_mapping 
                     WHERE file_id LIKE $1`,
                    [pattern]
                );

                let ids = result.rows.map((row) => row.imposition_id);

                if (ids.length === 0 && isNumericVersionSuffix(versionTag)) {
                    const loose = await client.query(
                        `SELECT DISTINCT imposition_id 
                         FROM imposition_file_mapping 
                         WHERE file_id LIKE $1`,
                        [fileIdPatternLoose(jobId)]
                    );
                    ids = loose.rows.map((row) => row.imposition_id);
                }

                if (ids.length === 0) {
                    const labex = await client.query(
                        `SELECT DISTINCT imposition_id 
                         FROM imposition_file_mapping 
                         WHERE file_id LIKE $1`,
                        [labexJobIdSegmentPattern(jobId)]
                    );
                    ids = labex.rows.map((row) => row.imposition_id);
                }

                return ids;
            } catch (e) {
                if (isUndefinedTableError(e)) {
                    return [];
                }
                throw e;
            }
        });
    } catch (e) {
        if (isUndefinedTableError(e)) {
            return [];
        }
        throw e;
    }
}

/**
 * Process scanned codes and update job statuses
 */
type ProcessScannedCodesResult = {
    processed: number;
    jobsUpdated: number;
    lastScanId: number;
    errors: string[];
};

let scannedCodesProcessInFlight: Promise<ProcessScannedCodesResult> | null = null;
let scannedCodesProcessRerunRequested = false;

async function processScannedCodesOnce(): Promise<ProcessScannedCodesResult> {
    const errors: string[] = [];
    let processed = 0;
    let jobsUpdated = 0;
    let lastScanId = 0;

    // Get last processed scan_id
    const lastProcessedScanId = await getLastProcessedMarker('scanned_codes');
    console.log(`[processScannedCodes] Processing scanned codes with scan_id > ${lastProcessedScanId}`);

    const scannedClient = await logsPool.connect();

    try {
        // Get new scanned codes from primary app DB
        let scannedResult;
        try {
            scannedResult = await scannedClient.query(
                `SELECT scan_id, code_text, scanned_at, machine_id, operations, metadata
             FROM scanned_codes
             WHERE scan_id > $1
             ORDER BY scan_id ASC`,
                [lastProcessedScanId]
            );
        } catch (e) {
            if (isUndefinedTableError(e)) {
                return {
                    processed: 0,
                    jobsUpdated: 0,
                    lastScanId: lastProcessedScanId,
                    errors: [],
                };
            }
            throw e;
        }

        const scans = scannedResult.rows;
        console.log(`[processScannedCodes] Found ${scans.length} new scanned codes to process`);
        
        if (scans.length > 0) {
            console.log(`[processScannedCodes] Scan IDs range: ${scans[0].scan_id} to ${scans[scans.length - 1].scan_id}`);
        }

        if (scans.length === 0) {
            return { processed: 0, jobsUpdated: 0, lastScanId: lastProcessedScanId, errors: [] };
        }

        // Process each scan
        for (const scan of scans) {
            try {
                const storedCodeText = scan.code_text;
                const { baseCodeText, legacyImpositionPrefix } = decodeScanCodeText(storedCodeText);
                const codeText = baseCodeText;
                const scanId = parseInt(scan.scan_id);
                const scannedAt = scan.scanned_at || new Date();
                const operations = scan.operations || {};
                
                // Parse metadata JSONB if it's a string
                let metadata: Record<string, any> = {};
                if (scan.metadata) {
                    if (typeof scan.metadata === 'string') {
                        try {
                            metadata = JSON.parse(scan.metadata);
                        } catch (e) {
                            metadata = {};
                        }
                    } else {
                        metadata = scan.metadata;
                    }
                }

                // Parse operations JSONB
                let operationsObj: Record<string, any> = {};
                if (typeof operations === 'string') {
                    try {
                        operationsObj = JSON.parse(operations);
                    } catch (e) {
                        operationsObj = {};
                    }
                } else if (operations) {
                    operationsObj = operations;
                }

                // Extract operations array if it exists
                // Operations are stored as operation_ids (e.g., 'op001', 'op002')
                const operationsArray = operationsObj.operations || [];
                if (!Array.isArray(operationsArray) || operationsArray.length === 0) {
                    console.warn(`[processScannedCodes] Scan ${scanId}: No operations found in operations field: ${JSON.stringify(operationsObj)}`);
                    lastScanId = Math.max(lastScanId, scanId);
                    continue;
                }

                // Validate operation_ids against scheduler.Operation (canonical catalog on app DB)
                const validOperationIds: string[] = [];
                for (const op of operationsArray) {
                    const opId = typeof op === 'string' ? op : String(op);
                    const trimmed = opId.trim();

                    if (/^op\d+$/i.test(trimmed)) {
                        const canonical = trimmed.toLowerCase();
                        const exists = await verifyOperationIdExists(canonical);
                        if (exists) {
                            validOperationIds.push(canonical);
                        } else {
                            console.warn(`Scan ${scanId}: Operation ID ${canonical} not found in database`);
                            errors.push(`Scan ${scanId}: Invalid operation_id: ${canonical}`);
                        }
                    } else {
                        const convertedId = await getOperationIdByName(opId);
                        if (convertedId) {
                            validOperationIds.push(convertedId.toLowerCase());
                        } else {
                            console.warn(`Scan ${scanId}: Could not find operation_id for: ${opId}`);
                            errors.push(`Scan ${scanId}: Unknown operation: ${opId}`);
                        }
                    }
                }

                if (validOperationIds.length === 0) {
                    console.warn(`Scan ${scanId}: No valid operations found`);
                    lastScanId = Math.max(lastScanId, scanId);
                    continue;
                }

                // Determine scan type and get job_ids to update
                // Note: Runlist scans are now stored as individual file_id scans with metadata.derived_from_runlist
                let jobMap = new Map<string, Set<string>>();
                let isRunlistScan = false;
                let isFileIdScan = false;
                let fileIdImpositions: string[] = []; // For file_id scans, track imposition_ids
                let runlistIdForProcessing: string | null = null; // Store runlist_id for later use
                
                // Check if this scan was derived from a runlist scan (stored in metadata)
                const derivedFromRunlist = metadata.derived_from_runlist;

                /** Imposition id for imposition_operations updates (legacy prefix or IFM match only). */
                let embeddedImpositionId: string | null = legacyImpositionPrefix || null;

                if (derivedFromRunlist) {
                    // This is a file_id scan that was derived from a runlist scan
                    // Get all jobs from the runlist for updating
                    console.log(`Scan ${scanId}: Detected as file_id derived from runlist ${derivedFromRunlist}`);
                    jobMap = await getJobIdsFromRunlist(derivedFromRunlist);
                    isRunlistScan = true;
                    runlistIdForProcessing = derivedFromRunlist; // Store for later use

                    // Also get impositions for this specific file_id
                    const parsed = parseFileId(codeText);
                    if (parsed) {
                        const impositions = await getImpositionsForJob(parsed.jobId, parsed.versionTag);
                        fileIdImpositions = impositions;
                        isFileIdScan = true;
                    }
                } else if (codeText.trim().toLowerCase().startsWith('labex_')) {
                    // Device Labex barcodes first: IFM may have a row whose imposition_id equals the full scan string;
                    // that path uses FILE_* keys (job_id 4941_6330, version 1) while parseJobIdVersionFromScanCode
                    // must match job_operation_duration rows, not split 4941 + 6330.
                    const multiJobs = parseMultiJobLabexBarcode(codeText);
                    if (multiJobs && multiJobs.length > 0) {
                        for (const jid of multiJobs) {
                            jobMap.set(jid, new Set(['1']));
                        }
                        console.log(
                            `Scan ${scanId}: Labex multi-job barcode → ${multiJobs.length} job(s): ${multiJobs.join(', ')}`
                        );
                    } else {
                        const labexJv = parseJobIdVersionFromScanCode(codeText);
                        if (labexJv) {
                            jobMap.set(labexJv.jobId, new Set([labexJv.versionTag]));
                            console.log(
                                `Scan ${scanId}: Labex barcode → job_id=${labexJv.jobId}, version_tag=${labexJv.versionTag}`
                            );
                        } else {
                            console.warn(`Scan ${scanId}: Could not parse Labex code_text: ${codeText}`);
                            errors.push(`Scan ${scanId}: Could not parse Labex code_text`);
                            lastScanId = Math.max(lastScanId, scanId);
                            continue;
                        }
                    }
                } else {
                    const impositionOnlyResult = await tryJobMapFromImpositionCode(storedCodeText);
                    embeddedImpositionId =
                        legacyImpositionPrefix || (impositionOnlyResult ? storedCodeText.trim() : null);

                    if (impositionOnlyResult) {
                        console.log(
                            `Scan ${scanId}: code_text is imposition_id ${storedCodeText.trim()} — expanded to ${impositionOnlyResult.jobMap.size} job(s)`
                        );
                        jobMap = impositionOnlyResult.jobMap;
                        isFileIdScan = true;
                        fileIdImpositions = impositionOnlyResult.fileIdImpositions;
                    } else if (await isRunlistId(codeText)) {
                        // Legacy: Direct runlist_id scan (shouldn't happen with new approach, but handle it)
                        console.log(`Scan ${scanId}: Detected as direct runlist_id: ${codeText}`);
                        jobMap = await getJobIdsFromRunlist(codeText);
                        isRunlistScan = true;
                        runlistIdForProcessing = codeText; // Store for later use
                    } else {
                        // Try to parse as file_id pattern (job_id_version_tag)
                        const parts = codeText.split('_');
                        if (parts.length >= 3) {
                            const versionTag = parts[parts.length - 1];
                            const jobId = parts.slice(0, -1).join('_');

                            // Check if this matches a file_id pattern by finding impositions
                            const impositions = await getImpositionsForJob(jobId, versionTag);

                            if (impositions.length > 0) {
                                // This is a file_id scan - found impositions
                                console.log(
                                    `Scan ${scanId}: Detected as file_id pattern: ${codeText}, found ${impositions.length} impositions`
                                );
                                isFileIdScan = true;
                                fileIdImpositions = impositions;
                                jobMap.set(jobId, new Set([versionTag]));
                            } else {
                                // Try to find runlist from job_id_version_tag
                                const runlistId = await findRunlistByJobScan(codeText);
                                if (runlistId) {
                                    console.log(`Scan ${scanId}: Found runlist ${runlistId} from job scan: ${codeText}`);
                                    jobMap = await getJobIdsFromRunlist(runlistId);
                                    isRunlistScan = true;
                                } else {
                                    // Single job scan - parse job_id_version_tag (no impositions found, but still valid job)
                                    jobMap.set(jobId, new Set([versionTag]));
                                    console.log(
                                        `Scan ${scanId}: Single job scan (no impositions found): ${jobId}, version: ${versionTag}`
                                    );
                                }
                            }
                        } else {
                            console.warn(`Scan ${scanId}: Could not parse code_text: ${codeText}`);
                            errors.push(`Scan ${scanId}: Could not parse code_text`);
                            lastScanId = Math.max(lastScanId, scanId);
                            continue;
                        }
                    }
                }

                if (jobMap.size === 0) {
                    console.warn(`Scan ${scanId}: No jobs found for code_text: ${codeText}`);
                    errors.push(`Scan ${scanId}: No jobs found`);
                    lastScanId = Math.max(lastScanId, scanId);
                    continue;
                }

                // Process each operation (using validated operation_ids)
                const uniqueJobs = new Set<string>();
                console.log(`Scan ${scanId}: Processing ${jobMap.size} jobs from runlist/file scan`);
                
                // For runlist scans, get ALL impositions in the runlist upfront
                let allRunlistImpositions: string[] = [];
                if (isRunlistScan) {
                    const runlistIdToQuery = runlistIdForProcessing || codeText;
                    if (productionPlannerPathsMissingLogged) {
                        allRunlistImpositions = [];
                    } else {
                        try {
                            const allImpositionsResult = await withPlannerClient((c) =>
                                c.query(
                                    'SELECT DISTINCT imposition_id FROM production_planner_paths WHERE runlist_id = $1',
                                    [runlistIdToQuery]
                                )
                            );
                            allRunlistImpositions = allImpositionsResult.rows.map(
                                (row: { imposition_id: string }) => row.imposition_id
                            );
                        } catch (e) {
                            if (isUndefinedTableError(e)) {
                                productionPlannerPathsMissingLogged = true;
                                console.warn(
                                    '[processScannedCodes] table "production_planner_paths" missing — run migrations. Runlist imposition updates skipped.'
                                );
                                allRunlistImpositions = [];
                            } else {
                                throw e;
                            }
                        }
                    }
                    console.log(`Scan ${scanId}: Found ${allRunlistImpositions.length} impositions in runlist ${runlistIdToQuery}`);
                }
                
                for (const operationId of validOperationIds) {
                    // Update job_operations for each job_id/version_tag
                    for (const [jobId, versionTags] of Array.from(jobMap.entries())) {
                        console.log(`Scan ${scanId}: Updating job "${jobId}" with versions: ${Array.from(versionTags).join(', ')}`);
                        for (const versionTag of Array.from(versionTags)) {
                            await updateJobOperation(
                                jobId,
                                versionTag,
                                operationId,
                                'completed',
                                scanId,
                                scannedAt,
                                'scanner'
                            );

                            uniqueJobs.add(`${jobId}_${versionTag}`);
                        }
                    }

                    // Update imposition_operations for runlist scans
                    // Update ALL impositions in the runlist (not just for specific jobs)
                    if (isRunlistScan) {
                        console.log(`Scan ${scanId}: Updating ${allRunlistImpositions.length} impositions in runlist for operation ${operationId}`);
                        for (const impositionId of allRunlistImpositions) {
                            await updateImpositionOperation(
                                impositionId,
                                operationId,
                                'completed',
                                scanId,
                                scannedAt,
                                'scanner'
                            );
                            await flagJobOperationDurationsForImpositionJobs(
                                impositionId,
                                operationId,
                                scannedAt
                            );
                        }
                    } else if (isFileIdScan) {
                        const impositionsForUpdate =
                            embeddedImpositionId &&
                            fileIdImpositions.includes(embeddedImpositionId)
                                ? [embeddedImpositionId]
                                : fileIdImpositions;
                        for (const impositionId of impositionsForUpdate) {
                            await updateImpositionOperation(
                                impositionId,
                                operationId,
                                'completed',
                                scanId,
                                scannedAt,
                                'scanner'
                            );
                            await flagJobOperationDurationsForImpositionJobs(
                                impositionId,
                                operationId,
                                scannedAt
                            );
                        }
                    }
                    
                    // Update jobs.operations JSONB field for each job
                    const operationName = await getOperationNameById(operationId);
                    if (operationName) {
                        for (const [jobId, versionTags] of Array.from(jobMap.entries())) {
                            await updateJobOperationsField(jobId, operationName, true);
                        }
                    }
                }

                jobsUpdated += uniqueJobs.size;
                processed++;
                lastScanId = Math.max(lastScanId, scanId);

                console.log(
                    `[processScannedCodes] ✓ Processed scan ${scanId}: ${storedCodeText}, updated ${uniqueJobs.size} jobs, operations: ${validOperationIds.join(', ')}`
                );

            } catch (error: any) {
                const errorMsg = error.message || String(error);
                // Don't log "status column does not exist" errors as they're already handled in update functions
                if (!errorMsg.includes('column') || !errorMsg.includes('status')) {
                    console.error(`[processScannedCodes] ✗ Error processing scan ${scan.scan_id}:`, errorMsg);
                    if (error.stack) {
                        console.error(`[processScannedCodes] Stack:`, error.stack);
                    }
                    errors.push(`Scan ${scan.scan_id}: ${errorMsg}`);
                }
                lastScanId = Math.max(lastScanId, parseInt(scan.scan_id));
            }
        }

        // Update last processed scan_id
        // Always update marker to highest scan_id we've seen (even if skipped)
        if (scans.length > 0) {
            const highestScanId = Math.max(...scans.map(s => parseInt(s.scan_id)));
            await updateLastProcessedMarker('scanned_codes', highestScanId);
            console.log(`[processScannedCodes] Updated last processed scan_id to ${highestScanId} (processed ${processed}, skipped ${scans.length - processed})`);
        } else if (lastScanId > lastProcessedScanId) {
            // Update marker even if no scans were processed but we saw a scan_id (from errors)
            await updateLastProcessedMarker('scanned_codes', lastScanId);
            console.log(`[processScannedCodes] Updated last processed scan_id to ${lastScanId} (no scans processed)`);
        } else {
            console.log(`[processScannedCodes] No new scans to process (last processed: ${lastProcessedScanId})`);
        }

    } finally {
        scannedClient.release();
    }

    return {
        processed,
        jobsUpdated,
        lastScanId,
        errors,
    };
}

export async function processScannedCodes(): Promise<ProcessScannedCodesResult> {
    if (scannedCodesProcessInFlight) {
        // Another caller is already processing scans. Request one immediate follow-up pass.
        scannedCodesProcessRerunRequested = true;
        return scannedCodesProcessInFlight;
    }

    scannedCodesProcessInFlight = (async () => {
        const aggregate: ProcessScannedCodesResult = {
            processed: 0,
            jobsUpdated: 0,
            lastScanId: 0,
            errors: [],
        };

        try {
            do {
                scannedCodesProcessRerunRequested = false;
                const run = await processScannedCodesOnce();
                aggregate.processed += run.processed;
                aggregate.jobsUpdated += run.jobsUpdated;
                if (run.lastScanId > aggregate.lastScanId) {
                    aggregate.lastScanId = run.lastScanId;
                }
                if (run.errors.length > 0) {
                    aggregate.errors.push(...run.errors);
                }
            } while (scannedCodesProcessRerunRequested);

            return aggregate;
        } finally {
            scannedCodesProcessInFlight = null;
        }
    })();

    return scannedCodesProcessInFlight;
}

/** Latest HP Indigo Printbeat telemetry for GET /api/production-status (production overview). */
export type ProductionStatusPrintbeatLive = {
    press_state: string | null;
    meters_per_hour: number | null;
    meters: number | null;
    updated_at: string;
};

/** Latest runlist-derived scan + imposition view `lm` / scheduler.rollLengthMetres + implied m/h (GET /api/production-status). */
export type ProductionStatusRunlistLinearGauge = {
    latest_runlist_id: string | null;
    scanned_at: string | null;
    composite_job_id: string | null;
    pipeline_status: string | null;
    roll_length_metres: number | null;
    meters_per_hour: number | null;
};

/** @deprecated prefer {@link ProductionStatusRunlistLinearGauge} */
export type ProductionStatusDigitalCutGauge = ProductionStatusRunlistLinearGauge;
export type ProductionStatusSlitterGauge = ProductionStatusRunlistLinearGauge;

export type ProductionStatusGroup = {
    machine_id: string;
    completed: any[];
    processing: any[];
    /** Set for `hp_indigo_6900` (Printbeat) or `digital_cutter` (Bladerunner cutter live); omitted when disabled. */
    printbeat_live?: ProductionStatusPrintbeatLive | null;
    /** Set for `digital_cutter` from latest runlist scan; roll length: imposition `lm` view, then scheduler.Job. */
    digital_cut_gauge?: ProductionStatusRunlistLinearGauge | null;
    /** Set for `slitter_line` from latest scanned_codes row with derived_from_runlist + op003/op004/op006. */
    slitter_gauge?: ProductionStatusRunlistLinearGauge | null;
};

function coerceProductionJobDurationSeconds(v: unknown): number | null {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Combine durations from duplicate API rows; `??` cannot be used because `0` is a valid DB value but must not hide the other row's positive duration. */
export function mergeProductionJobDurationSeconds(
    dNew: number | null,
    dOld: number | null
): number | null {
    const a = dNew != null && Number.isFinite(dNew) ? dNew : null;
    const b = dOld != null && Number.isFinite(dOld) ? dOld : null;
    if (a != null && a > 0) return a;
    if (b != null && b > 0) return b;
    if (a != null) return a;
    if (b != null) return b;
    return null;
}

/** Prefer the row with the newer `last_completed_at`, but keep `duration_seconds` from either side when one is missing (UUID vs machine-name buckets often duplicate the same job). */
function mergeProductionJobDuplicatesPreferNewer(a: any, b: any): any {
    const tsA = a?.last_completed_at ? new Date(a.last_completed_at).getTime() : 0;
    const tsB = b?.last_completed_at ? new Date(b.last_completed_at).getTime() : 0;
    const newer = tsB >= tsA ? b : a;
    const older = tsB >= tsA ? a : b;
    const dNew = coerceProductionJobDurationSeconds(newer?.duration_seconds);
    const dOld = coerceProductionJobDurationSeconds(older?.duration_seconds);
    return {
        ...newer,
        duration_seconds: mergeProductionJobDurationSeconds(dNew, dOld),
    };
}

function dedupeProductionJobsByJobId(jobs: any[]): any[] {
    const byId = new Map<string, any>();
    for (const j of jobs) {
        const id = j?.job_id;
        if (id == null) continue;
        const prev = byId.get(id);
        if (!prev) {
            byId.set(id, j);
            continue;
        }
        byId.set(id, mergeProductionJobDuplicatesPreferNewer(prev, j));
    }
    return Array.from(byId.values());
}

/**
 * Collapse duplicate machine buckets when the same press is keyed by Prisma `Machine.id`
 * and by `Machine.name` (e.g. UUID vs `slitter_line`) — otherwise Production Overview shows two Slitter cards.
 */
export async function mergeProductionStatusGroupsByCanonicalMachineId(
    grouped: Record<string, ProductionStatusGroup>
): Promise<void> {
    const machines = await getCachedSchedulerMachinesForMerge();
    const toCanonical = new Map<string, string>();

    const registerAlias = (raw: string | null | undefined, id: string) => {
        if (!raw || !String(raw).trim()) return;
        const s = String(raw).trim();
        toCanonical.set(s, id);
        toCanonical.set(s.toLowerCase(), id);
        toCanonical.set(s.toUpperCase(), id);
    };

    for (const m of machines) {
        toCanonical.set(m.id, m.id);
        registerAlias(m.name, m.id);
        registerAlias(m.displayName, m.id);
    }

    const indigoUuid = await getCachedIndigoMachineId();
    if (indigoUuid) {
        registerAlias('HP_INDIGO_6900', indigoUuid);
    }

    const keys = Object.keys(grouped);
    for (const key of keys) {
        const canonical = toCanonical.get(key) ?? key;
        if (canonical === key) continue;
        if (!grouped[canonical]) {
            grouped[canonical] = {
                machine_id: canonical,
                completed: [],
                processing: [],
            };
        }
        const pbLive = grouped[canonical].printbeat_live ?? grouped[key].printbeat_live;
        const dcGauge = grouped[canonical].digital_cut_gauge ?? grouped[key].digital_cut_gauge;
        const slGauge = grouped[canonical].slitter_gauge ?? grouped[key].slitter_gauge;
        grouped[canonical].completed.push(...grouped[key].completed);
        grouped[canonical].processing.push(...grouped[key].processing);
        grouped[canonical].printbeat_live = pbLive;
        grouped[canonical].digital_cut_gauge = dcGauge;
        grouped[canonical].slitter_gauge = slGauge;
        delete grouped[key];
    }

    for (const g of Object.values(grouped)) {
        const completedDeduped = dedupeProductionJobsByJobId(g.completed).sort(
            (a, b) =>
                new Date(b.last_completed_at).getTime() -
                new Date(a.last_completed_at).getTime()
        );
        const processingDeduped = dedupeProductionJobsByJobId(g.processing).sort(
            (a, b) =>
                new Date(b.last_completed_at).getTime() -
                new Date(a.last_completed_at).getTime()
        );
        const processingIds = new Set(
            processingDeduped.map((j) => j.job_id).filter((id): id is string => id != null)
        );
        // Live processing (e.g. Printbeat current_job) wins over a stale completed row for the same job_id.
        g.processing = processingDeduped;
        g.completed = completedDeduped
            .filter((j) => j.job_id == null || !processingIds.has(j.job_id))
            .slice(0, PRODUCTION_COMPLETED_JOBS_PER_MACHINE);
    }
}

async function pgRetrySleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

async function withPgRetryThrowing<T>(label: string, fn: () => Promise<T>, attempts = 2): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            if (i < attempts - 1) {
                await pgRetrySleep(200 * (i + 1));
                continue;
            }
            console.warn(`[${label}] failed after ${attempts} attempt(s):`, e instanceof Error ? e.message : e);
            throw e;
        }
    }
    throw lastErr;
}

/** Undo common press UI / clipboard variants so IFM equality matches planner imposition ids. */
function normalizePrintbeatJobLine(raw: string): string {
    return raw
        .trim()
        .replace(/^\ufeff/, '')
        .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
        .replace(/[\u2010-\u2015\u2212]/g, '-');
}

/** Map Printbeat / press job line to job_ids (aligned with scanners + Print OS `name`). */
export async function resolveJobIdsFromPressLine(raw: string): Promise<string[]> {
    const name = normalizePrintbeatJobLine(raw);
    if (!name) return [];

    /** Hyphen-separated Labex multi-job filenames (same as labex scanners). */
    const multiJobs = parseMultiJobLabexBarcode(name);
    if (multiJobs?.length) {
        const sorted = [...new Set(multiJobs.map((j) => canonicalCompositeJobIdForDisplay(j)))].sort();
        return sorted;
    }

    const manual = parseManualPrepressFile(name);
    if (manual) return [canonicalCompositeJobIdForDisplay(manual.jobId)];

    const fileIds = await getFileIdsForImposition(name);
    if (fileIds.length > 0) {
        const jobMap = extractJobIdsFromFileIds(fileIds);
        return Array.from(jobMap.keys()).map(canonicalCompositeJobIdForDisplay).sort();
    }

    if (name.toLowerCase().startsWith('labex_')) {
        const dj = scanCodeToJobDisplayId(name);
        if (dj) return [canonicalCompositeJobIdForDisplay(dj)];
    }

    return [];
}

async function jobHasCompletedNonOp001(client: PoolClient, jobId: string): Promise<boolean> {
    try {
        const r = await client.query(
            `SELECT 1 FROM job_operation_duration
             WHERE job_id = $1
               AND operation_completed_at IS NOT NULL
               AND operation_id <> 'op001'
             LIMIT 1`,
            [jobId]
        );
        return r.rows.length > 0;
    } catch {
        return false;
    }
}

/**
 * Latest `operation_started_at` for an in-progress job on the Indigo card (same TZ rules as GET /api/production-status).
 * Used when Printbeat supplies `current_job` but JOD has not yet produced a SQL `processing` row — avoids showing
 * Printbeat `updated_at` (heartbeat) as the activity time.
 */
async function fetchIndigoJodIncompleteStartedInstantMs(
    client: PoolClient,
    jobId: string,
    indigoMachineId: string
): Promise<number | null> {
    try {
        const r = await client.query(
            `SELECT MAX(
                CASE
                    WHEN jod.operation_started_at IS NOT NULL THEN
                        CASE WHEN jod.operation_id = 'op001' THEN
                            jod.operation_started_at AT TIME ZONE 'Australia/Sydney'
                        ELSE
                            jod.operation_started_at AT TIME ZONE 'UTC'
                        END
                    ELSE NULL
                END
            ) AS t
            FROM job_operation_duration jod
            WHERE jod.job_id = $1
              AND jod.operation_completed_at IS NULL
              AND jod.operation_started_at IS NOT NULL
              AND (
                  jod.machine_id = $2
                  OR TRIM(COALESCE(jod.machine_id::text, '')) = TRIM(COALESCE($2::text, ''))
                  OR jod.machine_id = 'HP_INDIGO_6900'
              )`,
            [jobId, indigoMachineId]
        );
        const v = r.rows[0]?.t;
        if (v == null) return null;
        const d = v instanceof Date ? v : new Date(v);
        const ms = d.getTime();
        return Number.isFinite(ms) ? ms : null;
    } catch {
        return null;
    }
}

function parsedOperationsArray(operations: unknown): string[] {
    let obj: unknown = operations;
    if (typeof obj === 'string') {
        try {
            obj = JSON.parse(obj);
        } catch {
            return [];
        }
    }
    if (!obj || typeof obj !== 'object') return [];
    const arr = (obj as { operations?: unknown }).operations;
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

/** Strict guard: scan row lists exactly op001 in operations.operations. */
function scanRowIsOnlyOp001(operations: unknown): boolean {
    const ops = parsedOperationsArray(operations);
    return ops.length === 1 && ops[0] === 'op001';
}

/** Post-print completion ops merged from scanned_codes into GET /api/production-status (JOD can lag or carry legacy TZ rows). */
function enrichPostPrintOperationIdFromScanRow(operations: unknown): 'op004' | 'op005' | 'op006' {
    const s = typeof operations === 'string' ? operations : JSON.stringify(operations ?? {});
    const t = s.toLowerCase();
    if (t.includes('op006')) return 'op006';
    if (t.includes('op005')) return 'op005';
    return 'op004';
}

/** Persist Printbeat PK to BIGINT marker; skips if outside Number precision. */
function bigintToSafeMarkerNumber(id: bigint): number | null {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (id > max || id < -max) {
        console.warn('[printbeat_enrich] Printbeat row id exceeds Number.MAX_SAFE_INTEGER; cannot store marker.');
        return null;
    }
    return Number(id);
}

interface PrintbeatIndigoRow {
    /** PK on jobmanager `"Printbeat data Real time"`. Used for sequential marker advancement. */
    id: bigint;
    current_job: string;
    updated_at: Date;
}

async function fetchIndigoPrintbeatRow(client: PoolClient): Promise<PrintbeatIndigoRow | null> {
    const table = getPrintbeatRealtimeTableSqlIdentifier();
    const minId = getPrintbeatMinId();

    if (isPrintbeatIdMarkerSequentialEnabled()) {
        const lastId = await getLastProcessedMarker('printbeat_enrich');
        const clauses: string[] = [
            `current_job IS NOT NULL`,
            `TRIM(current_job) <> ''`,
            `(press_name ILIKE '%Indigo%' OR press_name ILIKE '%6900%')`,
        ];
        const params: bigint[] = [];
        let n = 1;
        if (minId > 0) {
            clauses.push(`id >= $${n}::bigint`);
            params.push(BigInt(minId));
            n++;
        }
        clauses.push(`id > $${n}::bigint`);
        params.push(BigInt(lastId));
        const q = `
            SELECT id, current_job, updated_at
            FROM ${table}
            WHERE ${clauses.join('\n              AND ')}
            ORDER BY id ASC NULLS LAST
            LIMIT 1
        `;
        const r = await client.query(q, params);
        if (r.rows.length === 0) return null;
        const row = r.rows[0];
        return {
            id: BigInt(String(row.id)),
            current_job: String(row.current_job),
            updated_at: row.updated_at ? new Date(row.updated_at) : new Date(),
        };
    }

    const maxAge = getPrintbeatMaxAgeMinutes();
    const paramsLive: unknown[] = [maxAge];
    let idx = 2;
    let minFrag = '';
    if (minId > 0) {
        minFrag = ` AND id >= $${idx++}::bigint `;
        paramsLive.push(BigInt(minId));
    }
    const qLive = `
        SELECT id, current_job, updated_at
        FROM ${table}
        WHERE updated_at > NOW() - ($1::integer * INTERVAL '1 minute')
          AND current_job IS NOT NULL
          AND TRIM(current_job) <> ''
          AND (press_name ILIKE '%Indigo%' OR press_name ILIKE '%6900%')
          ${minFrag}
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
    `;
    const rLive = await client.query(qLive, paramsLive);
    if (rLive.rows.length === 0) return null;
    const row = rLive.rows[0];
    return {
        id: BigInt(String(row.id)),
        current_job: String(row.current_job),
        updated_at: row.updated_at ? new Date(row.updated_at) : new Date(),
    };
}

async function fetchIndigoPrintbeatRowWithRetry(client: PoolClient): Promise<PrintbeatIndigoRow | null> {
    try {
        return await withPgRetryThrowing('printbeat_realtime', () => fetchIndigoPrintbeatRow(client));
    } catch (e) {
        if (isUndefinedTableError(e)) return null;
        console.warn('[enrichProductionStatus] Printbeat:', e instanceof Error ? e.message : e);
        return null;
    }
}

/**
 * Newest Indigo / 6900 row by `updated_at` within PRINTBEAT_MAX_AGE_MINUTES (telemetry only; does not require current_job).
 */
async function fetchIndigoPrintbeatLiveDisplayRow(client: PoolClient): Promise<ProductionStatusPrintbeatLive | null> {
    const table = getPrintbeatRealtimeTableSqlIdentifier();
    const maxAge = getPrintbeatMaxAgeMinutes();
    const minId = getPrintbeatMinId();
    const params: unknown[] = [maxAge];
    let idx = 2;
    let minFrag = '';
    if (minId > 0) {
        minFrag = ` AND id >= $${idx++}::bigint `;
        params.push(BigInt(minId));
    }
    const q = `
        SELECT press_state, meters_per_hour, meters, updated_at
        FROM ${table}
        WHERE updated_at > NOW() - ($1::integer * INTERVAL '1 minute')
          AND (press_name ILIKE '%Indigo%' OR press_name ILIKE '%6900%')
          ${minFrag}
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
    `;
    const r = await client.query(q, params);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const updatedAt = row.updated_at ? new Date(row.updated_at) : new Date();
    const mph = row.meters_per_hour;
    const m = row.meters;
    return {
        press_state: row.press_state != null && String(row.press_state).trim() ? String(row.press_state).trim() : null,
        meters_per_hour: mph != null && Number.isFinite(Number(mph)) ? Number(mph) : null,
        meters: m != null && Number.isFinite(Number(m)) ? Number(m) : null,
        updated_at: updatedAt.toISOString(),
    };
}

async function fetchIndigoPrintbeatLiveDisplayRowWithRetry(
    client: PoolClient
): Promise<ProductionStatusPrintbeatLive | null> {
    try {
        return await withPgRetryThrowing('printbeat_live_display', () =>
            fetchIndigoPrintbeatLiveDisplayRow(client)
        );
    } catch (e) {
        if (isUndefinedTableError(e)) return null;
        console.warn(
            '[enrichProductionStatus] Printbeat live display:',
            e instanceof Error ? e.message : e
        );
        return null;
    }
}

/** Newest Bladerunner row by `updated_at` within PRINTBEAT_MAX_AGE_MINUTES (digital cut live status). */
async function fetchBladerunnerCutterLiveDisplayRow(
    client: PoolClient
): Promise<ProductionStatusPrintbeatLive | null> {
    const table = getBladerunnerCutterLiveTableSqlIdentifier();
    const maxAge = getPrintbeatMaxAgeMinutes();
    const q = `
        SELECT press_state, updated_at
        FROM ${table}
        WHERE updated_at > NOW() - ($1::integer * INTERVAL '1 minute')
          AND (
            press_name ILIKE '%bladerunner%'
            OR device_serial_number ILIKE '%blade%'
          )
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
    `;
    const r = await client.query(q, [maxAge]);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const updatedAt = row.updated_at ? new Date(row.updated_at) : new Date();
    return {
        press_state: row.press_state != null && String(row.press_state).trim() ? String(row.press_state).trim() : null,
        meters_per_hour: null,
        meters: null,
        updated_at: updatedAt.toISOString(),
    };
}

async function fetchBladerunnerCutterLiveDisplayRowWithRetry(
    client: PoolClient
): Promise<ProductionStatusPrintbeatLive | null> {
    try {
        return await withPgRetryThrowing('bladerunner_cutter_live_display', () =>
            fetchBladerunnerCutterLiveDisplayRow(client)
        );
    } catch (e) {
        if (isUndefinedTableError(e)) return null;
        console.warn(
            '[enrichProductionStatus] Bladerunner cutter live:',
            e instanceof Error ? e.message : e
        );
        return null;
    }
}

/**
 * Merge recent `PRINTED` rows from `"print OS"` (Indigo) and `scanned_codes` carrying op004 / op005 / op006
 * into grouped production status so the UI reflects source tables when `job_operation_duration` lags.
 */
export async function enrichProductionStatusWithSourceTables(
    grouped: Record<string, ProductionStatusGroup>
): Promise<void> {
    const indigoId = await getCachedIndigoMachineId();
    if (!indigoId) {
        console.warn(
            '[enrichProductionStatus] No scheduler.Machine `hp_indigo_6900` — Indigo Print OS enrich skipped. Run `npx prisma db seed` or ensure Machine exists.'
        );
    }

    if (indigoId) {
        if (!grouped[indigoId]) {
            grouped[indigoId] = { machine_id: indigoId, completed: [], processing: [] };
        }
        const poClient = await getPrintOsPool().connect();
        try {
            if (!isPrintbeatRealtimeEnrichDisabled()) {
                grouped[indigoId].printbeat_live =
                    (await fetchIndigoPrintbeatLiveDisplayRowWithRetry(poClient)) ?? null;
            }
            let osRows;
            try {
                osRows = await withPgRetryThrowing('enrich_print_os', () =>
                    poClient.query(
                        // job_complete_time is Sydney wall-clock mislabeled `+00:00` by the press (+10h late as stored).
                        // Reinterpret the wall-clock digits as Sydney to recover the true instant.
                        `SELECT name, marker,
                                ((job_complete_time AT TIME ZONE 'UTC') AT TIME ZONE 'Australia/Sydney') AS job_complete_time,
                                payload
                         FROM "print OS"
                         WHERE status = 'PRINTED'
                         ORDER BY id DESC NULLS LAST
                         LIMIT ${PRINT_OS_ENRICH_ROW_LIMIT}`
                    )
                );
            } catch (e) {
                if (isUndefinedTableError(e)) {
                    osRows = { rows: [] };
                } else {
                    throw e;
                }
            }

            const candidates: {
                job_id: string;
                last_completed_at: string;
                duration_seconds: number | null;
            }[] = [];

            for (const row of osRows.rows) {
                const name = String(row.name);
                if (row.job_complete_time == null) {
                    continue;
                }
                const completedIso = pgTimestampToIsoUtc(row.job_complete_time);
                if (!completedIso) continue;
                let durationSeconds: number | null = null;
                if (row.payload) {
                    try {
                        const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
                        if (p?.jobElapseTime != null) {
                            durationSeconds = parseInt(String(p.jobElapseTime), 10) || null;
                        }
                    } catch {
                        /* ignore */
                    }
                }

                const resolved = await resolveJobIdsFromPressLine(name);
                for (const jobId of resolved) {
                    candidates.push({
                        job_id: jobId,
                        last_completed_at: completedIso,
                        duration_seconds: durationSeconds,
                    });
                }
            }

            if (osRows.rows.length > 0 && candidates.length === 0) {
                console.warn(
                    '[enrichProductionStatus] Print OS returned',
                    osRows.rows.length,
                    'PRINTED row(s) but 0 job candidates — `name` not resolved (try IFM imposition match, hyphenated Labex multi-job, Labex_manual, scan-style Labex fallback).'
                );
            }

            const byJob = new Map<string, (typeof candidates)[0]>();
            for (const c of candidates) {
                const prev = byJob.get(c.job_id);
                const cMs = new Date(c.last_completed_at).getTime();
                const prevMs = prev ? new Date(prev.last_completed_at).getTime() : 0;
                if (!prev || cMs > prevMs) {
                    byJob.set(c.job_id, c);
                }
            }

            const merged = new Map<string, any>();
            for (const j of grouped[indigoId].completed) {
                merged.set(j.job_id, { ...j });
            }
            for (const c of byJob.values()) {
                const prev = merged.get(c.job_id);
                const totalV = prev?.total_versions ?? 1;
                const procV = prev?.processed_versions ?? 1;
                // Print OS `job_complete_time` is the system of record for op001 print completion
                // (corrected to true Sydney instant in the query). Prefer it over the JOD-derived base
                // even when the JOD value is "newer" — JOD op001 rows can carry a stale/mislabeled time.
                merged.set(c.job_id, {
                    job_id: c.job_id,
                    processed_versions: procV,
                    total_versions: totalV,
                    last_completed_at: c.last_completed_at,
                    operation_id: 'op001',
                    duration_seconds: mergeProductionJobDurationSeconds(
                        coerceProductionJobDurationSeconds(c.duration_seconds),
                        coerceProductionJobDurationSeconds(prev?.duration_seconds)
                    ),
                    progress: totalV > 0 ? Math.round((procV / totalV) * 100) : 100,
                });
            }

            grouped[indigoId].completed = Array.from(merged.values())
                .sort(
                    (a, b) =>
                        new Date(b.last_completed_at).getTime() - new Date(a.last_completed_at).getTime()
                )
                .slice(0, PRODUCTION_COMPLETED_JOBS_PER_MACHINE);

            if (!isPrintbeatRealtimeEnrichDisabled()) {
                const pbRow = await fetchIndigoPrintbeatRowWithRetry(poClient);
                if (pbRow) {
                    const pbIdNum = bigintToSafeMarkerNumber(pbRow.id);
                    const jobIdsPb = await resolveJobIdsFromPressLine(pbRow.current_job);
                    if (jobIdsPb.length > 0) {
                        const primaryJobId = jobIdsPb[0]!;
                        const pbMs = pbRow.updated_at.getTime();
                        const proc = grouped[indigoId].processing;
                        const existing = proc.length > 0 ? proc[0] : undefined;
                        const exMs = existing?.last_completed_at
                            ? new Date(existing.last_completed_at).getTime()
                            : 0;
                        const usePrintbeat = !existing || pbMs > exMs;
                        if (usePrintbeat) {
                            const totalV = existing?.total_versions ?? 1;
                            const procV = existing?.processed_versions ?? 1;
                            // SQL processing uses last_started_at here; Printbeat updated_at is heartbeat-only.
                            const sameJobAsSql =
                                existing != null && existing.job_id === primaryJobId;
                            const sqlStartMs =
                                sameJobAsSql && existing.last_completed_at
                                    ? new Date(existing.last_completed_at).getTime()
                                    : null;
                            let displayMs = pbMs;
                            const jodQuick = await logsPool.connect();
                            try {
                                const jodMs = await fetchIndigoJodIncompleteStartedInstantMs(
                                    jodQuick,
                                    primaryJobId,
                                    indigoId
                                );
                                if (jodMs != null) {
                                    displayMs = Math.min(jodMs, pbMs);
                                } else if (sqlStartMs != null) {
                                    displayMs = Math.min(sqlStartMs, pbMs);
                                }
                            } finally {
                                jodQuick.release();
                            }
                            const processingJob = {
                                job_id: primaryJobId,
                                processed_versions: procV,
                                total_versions: totalV,
                                last_completed_at:
                                    pgTimestampToIsoUtc(displayMs) ??
                                    new Date(displayMs).toISOString(),
                                operation_id: 'op001',
                                duration_seconds: null,
                                progress: totalV > 0 ? Math.round((procV / totalV) * 100) : 100,
                            };
                            grouped[indigoId].processing = [processingJob];
                            grouped[indigoId].completed = grouped[indigoId].completed.filter(
                                (j) => j.job_id !== primaryJobId
                            );
                        }
                    }
                    if (isPrintbeatIdMarkerSequentialEnabled() && pbIdNum != null) {
                        await updateLastProcessedMarker('printbeat_enrich', pbIdNum);
                    }
                }
            }
        } finally {
            poClient.release();
        }
    }

    const digitalCutterId = await getCachedDigitalCutterMachineId();
    if (digitalCutterId && !isBladerunnerCutterLiveDisabled()) {
        if (!grouped[digitalCutterId]) {
            grouped[digitalCutterId] = { machine_id: digitalCutterId, completed: [], processing: [] };
        }
        const poClient = await getPrintOsPool().connect();
        try {
            grouped[digitalCutterId].printbeat_live =
                (await fetchBladerunnerCutterLiveDisplayRowWithRetry(poClient)) ?? null;
        } finally {
            poClient.release();
        }
    }

    const logsClient = await logsPool.connect();
    try {
        let scanRows;
        try {
            scanRows = await withPgRetryThrowing('enrich_scanned_op004_op005_op006', () =>
                logsClient.query(`
                SELECT code_text, scanned_at, machine_id, operations
                FROM scanned_codes
                WHERE machine_id IS NOT NULL
                  AND scanned_at > NOW() - INTERVAL '30 days'
                  AND (
                    operations::text ILIKE '%op004%'
                    OR (operations->'operations')::text ILIKE '%op004%'
                    OR operations::text ILIKE '%op005%'
                    OR (operations->'operations')::text ILIKE '%op005%'
                    OR operations::text ILIKE '%op006%'
                    OR (operations->'operations')::text ILIKE '%op006%'
                  )
                ORDER BY scanned_at DESC
                LIMIT ${POST_PRINT_SCAN_ENRICH_ROW_LIMIT}
            `)
            );
        } catch (e) {
            if (isUndefinedTableError(e)) {
                scanRows = { rows: [] };
            } else {
                throw e;
            }
        }

        const perMachine = new Map<string, Map<string, any>>();

        for (const row of scanRows.rows) {
            const mid = String(row.machine_id);
            if (!mid) continue;
            const stored = String(row.code_text ?? '');
            const jobIds = await resolveJobDisplayIdsFromScanCode(logsClient, stored);
            if (jobIds.length === 0) continue;
            if (row.scanned_at == null) continue;
            const scannedIso = pgTimestampToIsoUtc(row.scanned_at);
            if (!scannedIso) continue;

            if (!perMachine.has(mid)) perMachine.set(mid, new Map());
            const m = perMachine.get(mid)!;
            for (const jobId of jobIds) {
                const prev = m.get(jobId);
                const ts = new Date(scannedIso).getTime();
                const opId = enrichPostPrintOperationIdFromScanRow(row.operations);
                if (!prev || ts > new Date(prev.last_completed_at).getTime()) {
                    m.set(jobId, {
                        job_id: jobId,
                        processed_versions: 1,
                        total_versions: 1,
                        last_completed_at: scannedIso,
                        operation_id: opId,
                        duration_seconds: null,
                        progress: 100,
                    });
                }
            }
        }

        for (const [mid, jobMap] of perMachine) {
            if (!grouped[mid]) {
                grouped[mid] = { machine_id: mid, completed: [], processing: [] };
            }
            const merged = new Map<string, any>();
            for (const j of grouped[mid].completed) {
                merged.set(j.job_id, { ...j });
            }
            for (const jobData of jobMap.values()) {
                const prev = merged.get(jobData.job_id);
                const prevTs = prev?.last_completed_at ? new Date(prev.last_completed_at).getTime() : 0;
                const ts = new Date(jobData.last_completed_at).getTime();
                if (!prev || ts > prevTs) {
                    merged.set(jobData.job_id, {
                        ...jobData,
                        total_versions: prev?.total_versions ?? jobData.total_versions,
                        processed_versions: prev?.processed_versions ?? jobData.processed_versions,
                        duration_seconds: mergeProductionJobDurationSeconds(
                            coerceProductionJobDurationSeconds(jobData.duration_seconds),
                            coerceProductionJobDurationSeconds(prev?.duration_seconds)
                        ),
                        progress:
                            (prev?.total_versions ?? jobData.total_versions) > 0
                                ? Math.round(
                                      ((prev?.processed_versions ?? jobData.processed_versions) /
                                          (prev?.total_versions ?? jobData.total_versions)) *
                                          100
                                  )
                                : 100,
                    });
                }
            }
            grouped[mid].completed = Array.from(merged.values())
                .sort(
                    (a, b) =>
                        new Date(b.last_completed_at).getTime() - new Date(a.last_completed_at).getTime()
                )
                .slice(0, PRODUCTION_COMPLETED_JOBS_PER_MACHINE);
        }

        if (indigoId && grouped[indigoId]) {
            let op001ScanRows: { rows: any[] };
            try {
                op001ScanRows = await withPgRetryThrowing('enrich_scanned_op001', () =>
                    logsClient.query(`
                        SELECT code_text, scanned_at, operations
                        FROM scanned_codes
                        WHERE scanned_at > NOW() - INTERVAL '30 days'
                          AND (
                            operations::text ILIKE '%op001%'
                            OR (operations->'operations')::text ILIKE '%op001%'
                          )
                        ORDER BY scanned_at DESC
                        LIMIT ${OP001_SCAN_ENRICH_ROW_LIMIT}
                    `)
                );
            } catch (e) {
                if (isUndefinedTableError(e)) {
                    op001ScanRows = { rows: [] };
                } else {
                    throw e;
                }
            }

            const strictGuards = isOp001EnrichStrictGuardsEnabled();
            const byJobOp001 = new Map<string, { job_id: string; last_completed_at: string }>();
            for (const row of op001ScanRows.rows) {
                if (strictGuards && !scanRowIsOnlyOp001(row.operations)) continue;
                const stored = String(row.code_text ?? '');
                const jobIds = await resolveJobDisplayIdsFromScanCode(logsClient, stored);
                if (jobIds.length === 0) continue;
                if (row.scanned_at == null) continue;
                const scannedIso = pgTimestampToIsoUtc(row.scanned_at);
                if (!scannedIso) continue;
                for (const jobId of jobIds) {
                    if (strictGuards && (await jobHasCompletedNonOp001(logsClient, jobId))) continue;
                    const prev = byJobOp001.get(jobId);
                    const ts = new Date(scannedIso).getTime();
                    if (!prev || ts > new Date(prev.last_completed_at).getTime()) {
                        byJobOp001.set(jobId, { job_id: jobId, last_completed_at: scannedIso });
                    }
                }
            }

            const mergedOp001 = new Map<string, any>();
            for (const j of grouped[indigoId].completed) {
                mergedOp001.set(j.job_id, { ...j });
            }
            for (const c of byJobOp001.values()) {
                const ts = new Date(c.last_completed_at).getTime();
                const prev = mergedOp001.get(c.job_id);
                const prevTs = prev?.last_completed_at ? new Date(prev.last_completed_at).getTime() : 0;
                if (!prev || ts > prevTs) {
                    const totalV = prev?.total_versions ?? 1;
                    const procV = prev?.processed_versions ?? 1;
                    mergedOp001.set(c.job_id, {
                        job_id: c.job_id,
                        processed_versions: procV,
                        total_versions: totalV,
                        last_completed_at: c.last_completed_at,
                        operation_id: 'op001',
                        duration_seconds: prev?.duration_seconds ?? null,
                        progress: totalV > 0 ? Math.round((procV / totalV) * 100) : 100,
                    });
                }
            }
            grouped[indigoId].completed = Array.from(mergedOp001.values())
                .sort(
                    (a, b) =>
                        new Date(b.last_completed_at).getTime() - new Date(a.last_completed_at).getTime()
                )
                .slice(0, PRODUCTION_COMPLETED_JOBS_PER_MACHINE);
        }
    } finally {
        logsClient.release();
    }
}

function coerceScanMetadata(metadata: unknown): Record<string, unknown> | null {
    if (metadata == null || metadata === '') return null;
    if (typeof metadata === 'object' && !Array.isArray(metadata)) return metadata as Record<string, unknown>;
    if (typeof metadata === 'string') {
        try {
            const p = JSON.parse(metadata) as unknown;
            if (typeof p === 'object' && p != null && !Array.isArray(p)) return p as Record<string, unknown>;
        } catch {
            /* ignore */
        }
    }
    return null;
}

function scanIndicatesDigitalCut(operations: unknown): boolean {
    for (const o of parsedOperationsArray(operations)) {
        if (o === 'op002' || o === 'op005') return true;
    }
    const t =
        typeof operations === 'string' ? operations : JSON.stringify(operations ?? {}).toLowerCase();
    const s = typeof t === 'string' ? t.toLowerCase() : String(t).toLowerCase();
    return s.includes('op002') || s.includes('op005');
}

/** Slitter lane: kiss-cut / slitting completions (aligned with job_status_view slitter semantics). */
function scanIndicatesSlitter(operations: unknown): boolean {
    for (const o of parsedOperationsArray(operations)) {
        if (o === 'op003' || o === 'op004' || o === 'op006') return true;
    }
    const t =
        typeof operations === 'string' ? operations : JSON.stringify(operations ?? {}).toLowerCase();
    const s = typeof t === 'string' ? t.toLowerCase() : String(t).toLowerCase();
    return s.includes('op003') || s.includes('op004') || s.includes('op006');
}

async function prismaRollLengthForCompositeLabexJob(externalIdCandidate: string): Promise<number | null> {
    try {
        const j = await prisma.job.findFirst({
            where: {
                externalId: externalIdCandidate,
                rollLengthMetres: { not: null, gt: 0 },
            },
            select: { rollLengthMetres: true },
            orderBy: { createdAt: 'desc' },
        });
        if (j?.rollLengthMetres != null) {
            const n = Number(j.rollLengthMetres);
            return Number.isFinite(n) && n > 0 ? n : null;
        }
    } catch (e) {
        console.warn('[runlist_linear_gauge] scheduler rollLength:', e instanceof Error ? e.message : e);
    }
    return null;
}

function coercePositiveLinearMetres(cell: unknown): number | null {
    if (cell == null || cell === '') return null;
    const n = typeof cell === 'number' ? cell : Number(String(cell).replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Prefer `imposition_file_mapping`-backed ids, then raw scan fragments (canonical imposition-only `code_text`). */
async function orderedDistinctImpositionIdsForLinearMetresLookup(
    logsOrPrimaryClient: PoolClient,
    storedScanCodeText: string,
    derivedRunlistId?: string | null
): Promise<string[]> {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const push = (v: unknown) => {
        const x = typeof v === 'string' ? v.trim() : '';
        if (!x || seen.has(x)) return;
        seen.add(x);
        ordered.push(x);
    };
    const keys = scanCodeDecodeCandidates(storedScanCodeText);

    const collectFromIfm = async (client: PoolClient) => {
        for (const key of keys) {
            try {
                const qa = await client.query(
                    `SELECT DISTINCT imposition_id FROM imposition_file_mapping WHERE imposition_id = $1 LIMIT 12`,
                    [key]
                );
                for (const r of qa.rows) push(r.imposition_id);
            } catch (e) {
                if (!isUndefinedTableError(e)) throw e;
            }
            try {
                const qb = await client.query(
                    `SELECT DISTINCT imposition_id FROM imposition_file_mapping WHERE file_id = $1 LIMIT 12`,
                    [key]
                );
                for (const r of qb.rows) push(r.imposition_id);
            } catch (e) {
                if (!isUndefinedTableError(e)) throw e;
            }
        }
    };

    const collectFromRunlist = async (client: PoolClient) => {
        const runlistId = derivedRunlistId?.trim();
        if (!runlistId) return;
        try {
            const qr = await client.query(
                `
                SELECT DISTINCT ppp.imposition_id
                FROM production_planner_paths ppp
                WHERE ppp.runlist_id = $1
                ORDER BY ppp.imposition_id
                LIMIT 64
            `,
                [runlistId]
            );
            for (const r of qr.rows) push(r.imposition_id);
        } catch (e) {
            if (isUndefinedTableError(e)) return;
            console.warn(
                '[runlist_linear_gauge] production_planner_paths runlist->imposition:',
                e instanceof Error ? e.message : e
            );
        }
    };

    await collectFromRunlist(logsOrPrimaryClient);
    await collectFromIfm(logsOrPrimaryClient);
    if (isDedicatedLogsDatabase()) {
        const ac = await appPool.connect();
        try {
            await collectFromRunlist(ac);
            await collectFromIfm(ac);
        } finally {
            ac.release();
        }
    }

    for (const key of keys) push(key);

    return ordered;
}

/** Pick linear metres from a row of `imposition_duration_view` (column may be `lm`, `LM`, `linear_metres`, …). */
function linearMetresFromDurationViewRow(row: Record<string, unknown> | undefined): number | null {
    if (!row) return null;
    const keysPriority = ['lm', 'LM', 'linear_metres', 'linear_meters', 'linearmetres'];
    for (const k of keysPriority) {
        if (k in row) {
            const m = coercePositiveLinearMetres(row[k]);
            if (m != null) return m;
        }
    }
    for (const key of Object.keys(row)) {
        if (/imposition/i.test(key)) continue;
        if (!/lm|linear|metre|meter/i.test(key)) continue;
        const m = coercePositiveLinearMetres(row[key]);
        if (m != null) return m;
    }
    return null;
}

/**
 * Reads linear metres for `imposition_id` from {@link impositionDurationViewPlainIdentifier}.
 * Tries LOGS pool first, then APP when dual-DB (view often lives only on DATABASE_URL).
 */
async function linearMetresFromImpositionDurationView(
    logsOrIfmClient: PoolClient,
    storedScanCodeText: string,
    derivedRunlistId?: string | null
): Promise<number | null> {
    const ids = await orderedDistinctImpositionIdsForLinearMetresLookup(
        logsOrIfmClient,
        storedScanCodeText,
        derivedRunlistId
    );
    if (ids.length === 0) return null;

    const viewPlain = impositionDurationViewPlainIdentifier();

    const tryClient = async (client: PoolClient): Promise<number | null> => {
        for (const rawId of ids) {
            const id = String(rawId).trim();
            if (!id) continue;
            try {
                const r = await client.query(
                    `SELECT * FROM ${viewPlain} WHERE trim(imposition_id::text) = trim($1::text) LIMIT 1`,
                    [id]
                );
                const lm = linearMetresFromDurationViewRow(r.rows[0] as Record<string, unknown> | undefined);
                if (lm != null) return lm;
            } catch (e) {
                if (isUndefinedTableError(e)) return null;
                if (isUndefinedColumnError(e)) {
                    try {
                        const r2 = await client.query(
                            `SELECT lm AS lm_value FROM ${viewPlain} WHERE trim(imposition_id::text) = trim($1::text) LIMIT 1`,
                            [id]
                        );
                        const v = coercePositiveLinearMetres(r2.rows[0]?.lm_value);
                        if (v != null) return v;
                    } catch (e2) {
                        if (isUndefinedTableError(e2)) return null;
                        console.warn(
                            '[runlist_linear_gauge] lm fallback query:',
                            e2 instanceof Error ? e2.message : e2
                        );
                    }
                    continue;
                }
                console.warn(
                    '[runlist_linear_gauge] imposition duration view row:',
                    e instanceof Error ? e.message : e
                );
            }
        }
        return null;
    };

    let v = await tryClient(logsOrIfmClient);
    if (v != null) return v;
    if (isDedicatedLogsDatabase()) {
        const ac = await appPool.connect();
        try {
            v = await tryClient(ac);
        } finally {
            ac.release();
        }
    }
    return v;
}

function derivedDurationSecondsForMpmFromGroup(
    group: ProductionStatusGroup,
    compositeJobId: string | null
): number | null {
    if (!compositeJobId) return null;
    type J = (typeof group.completed)[number];

    let fromJod: number | null = null;
    for (const job of [...group.processing, ...group.completed]) {
        if (job.job_id !== compositeJobId || job.duration_seconds == null) continue;
        const d = normalizeDurationSecondsNumber(job.duration_seconds);
        if (d == null || d < 15) continue;
        fromJod = d;
        break;
    }
    if (fromJod != null) return fromJod;

    const proc = group.processing.find((j: J) => j.job_id === compositeJobId);
    if (proc?.last_completed_at) {
        const secs = Math.floor((Date.now() - new Date(proc.last_completed_at).getTime()) / 1000);
        return Math.min(Math.max(secs, 45), 7 * 24 * 3600);
    }

    const done = group.completed.find((j: J) => j.job_id === compositeJobId);
    if (done?.duration_seconds != null) {
        const d = normalizeDurationSecondsNumber(done.duration_seconds);
        return d != null && d > 0 ? Math.max(d, 15) : null;
    }
    return null;
}

/** Coerce PG / JSON job row duration (number | string | null). */
function normalizeDurationSecondsNumber(raw: unknown): number | null {
    if (raw == null || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(String(raw));
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Max duration stored for this job on this press (production-status card can list a different job than the runlist scan).
 */
async function maxOperationDurationSecondsFromJobOperationDurationTable(
    client: PoolClient,
    compositeJobId: string,
    machineId: string,
    machineName: string
): Promise<number | null> {
    try {
        const r = await client.query(
            `SELECT MAX(operation_duration_seconds)::int AS d
             FROM job_operation_duration
             WHERE job_id = $1
               AND (machine_id = $2 OR TRIM(machine_id) = TRIM($3))
               AND operation_duration_seconds IS NOT NULL
               AND operation_duration_seconds > 0`,
            [compositeJobId, machineId, machineName]
        );
        const cell = r.rows[0]?.d;
        const n = normalizeDurationSecondsNumber(cell);
        return n != null && n >= 10 ? n : null;
    } catch (e) {
        if (isUndefinedTableError(e)) return null;
        console.warn(
            '[runlist_linear_gauge] job_operation_duration duration:',
            e instanceof Error ? e.message : e
        );
        return null;
    }
}

/** When JOD has no duration yet, approximate run window from scan time → now (floored so we never divide by near-zero). */
function durationSecondsFallbackFromRunlistScanTime(scannedAtIso: string | null): number | null {
    if (!scannedAtIso?.trim()) return null;
    const t = new Date(scannedAtIso).getTime();
    if (!Number.isFinite(t)) return null;
    const secs = Math.floor((Date.now() - t) / 1000);
    if (secs < 1) return null;
    return Math.min(Math.max(secs, 45), 7 * 24 * 3600);
}

async function resolveDurationSecondsForRunlistLinearGauge(opts: {
    card: ProductionStatusGroup;
    compositeJobId: string | null;
    scannedAtIso: string | null;
    logsClient: PoolClient;
    machineId: string;
    machineName: string;
}): Promise<number | null> {
    const { card, compositeJobId, scannedAtIso, logsClient, machineId, machineName } = opts;

    let d = derivedDurationSecondsForMpmFromGroup(card, compositeJobId);
    if (d != null && d > 0) return d;

    if (compositeJobId) {
        d = await maxOperationDurationSecondsFromJobOperationDurationTable(
            logsClient,
            compositeJobId,
            machineId,
            machineName
        );
        if (d != null && d > 0) return d;
    }

    return durationSecondsFallbackFromRunlistScanTime(scannedAtIso);
}

function metersPerHourFromRollAndDuration(
    rollMetres: number | null,
    durationSeconds: number | null
): number | null {
    if (rollMetres == null || !Number.isFinite(rollMetres) || rollMetres <= 0) return null;
    if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
    const mph = rollMetres / (durationSeconds / 3600);
    return Number.isFinite(mph) ? mph : null;
}

type RunlistLinearGaugeAttachmentKey = 'digital_cut_gauge' | 'slitter_gauge';

async function attachRunlistLinearGaugeForPlannerMachine(
    grouped: Record<string, ProductionStatusGroup>,
    opts: {
        prismaMachineName: 'digital_cutter' | 'slitter_line';
        gaugeKey: RunlistLinearGaugeAttachmentKey;
        scanMatchesOperations: (operations: unknown) => boolean;
        pgRetryLabel: string;
    }
): Promise<void> {
    const machine = await getCachedSchedulerMachineByUniqueName(opts.prismaMachineName);
    if (!machine?.id) return;

    if (!grouped[machine.id]) {
        grouped[machine.id] = { machine_id: machine.id, completed: [], processing: [] };
    }
    const card = grouped[machine.id]!;

    const gaugeNull: ProductionStatusRunlistLinearGauge = {
        latest_runlist_id: null,
        scanned_at: null,
        composite_job_id: null,
        pipeline_status: null,
        roll_length_metres: null,
        meters_per_hour: null,
    };

    const assignGauge = (g: ProductionStatusRunlistLinearGauge) => {
        if (opts.gaugeKey === 'digital_cut_gauge') card.digital_cut_gauge = g;
        else card.slitter_gauge = g;
    };

    const logsClient = await logsPool.connect();
    try {
        const q = `
            SELECT scanned_at, created_at, code_text, metadata, operations, machine_id
            FROM scanned_codes
            WHERE scanned_at > NOW() - INTERVAL '30 days'
              AND machine_id IS NOT NULL
              AND (machine_id = $1 OR TRIM(machine_id) = TRIM($2))
              AND (metadata->>'derived_from_runlist') IS NOT NULL
              AND LENGTH(TRIM(COALESCE(metadata->>'derived_from_runlist', ''))) > 0
            ORDER BY scanned_at DESC NULLS LAST
            LIMIT 48
        `;
        let rows: Array<{
            scanned_at: unknown;
            created_at: unknown;
            code_text: unknown;
            metadata: unknown;
            operations: unknown;
            machine_id: unknown;
        }> = [];

        try {
            const qr = await withPgRetryThrowing(opts.pgRetryLabel, () =>
                logsClient.query(q, [machine.id, machine.name])
            );
            rows = qr.rows ?? [];
        } catch (e) {
            if (isUndefinedTableError(e)) {
                assignGauge(gaugeNull);
                return;
            }
            throw e;
        }

        let row: (typeof rows)[0] | undefined;
        for (const candidate of rows) {
            if (opts.scanMatchesOperations(candidate.operations)) {
                row = candidate;
                break;
            }
        }
        if (!row) {
            assignGauge(gaugeNull);
            return;
        }

        const meta = coerceScanMetadata(row.metadata);
        const runlistRaw =
            meta && typeof meta.derived_from_runlist === 'string' ? meta.derived_from_runlist.trim() : '';
        const latestRunlistId = runlistRaw || null;

        const storedCode = String(row.code_text ?? '');
        const ids = await resolveJobDisplayIdsFromScanCode(logsClient, storedCode);
        const idsSorted = [...new Set(ids.map((x) => canonicalCompositeJobIdForDisplay(x)))].sort();

        let compositeJobId: string | null = null;
        for (const jid of idsSorted) {
            if (
                card.processing.some((j) => j.job_id === jid) ||
                card.completed.some((j) => j.job_id === jid)
            ) {
                compositeJobId = jid;
                break;
            }
        }
        if (!compositeJobId && idsSorted.length > 0) compositeJobId = idsSorted[0]!;

        let pipelineStatus: string | null = null;
        if (compositeJobId) {
            const pipePool = poolForPipelineTables();
            const pc = await pipePool.connect();
            try {
                const r = await pc.query(`SELECT status FROM job_status_view WHERE job_id = $1 LIMIT 1`, [
                    compositeJobId,
                ]);
                if (r.rows[0]?.status != null && String(r.rows[0].status).trim()) {
                    pipelineStatus = String(r.rows[0].status).trim();
                }
            } catch (ve) {
                if (!isUndefinedTableError(ve)) {
                    console.warn(
                        '[runlist_linear_gauge] job_status_view:',
                        ve instanceof Error ? ve.message : ve
                    );
                }
            } finally {
                pc.release();
            }
        }

        const ts = row.scanned_at ?? row.created_at;
        const scannedAt = ts ? new Date(ts as string | Date) : null;
        const scannedAtIso = scannedAt && !isNaN(scannedAt.getTime()) ? scannedAt.toISOString() : null;

        const rollLenFromLmView = await linearMetresFromImpositionDurationView(
            logsClient,
            storedCode,
            latestRunlistId
        );
        const rollLenScheduler =
            compositeJobId != null ? await prismaRollLengthForCompositeLabexJob(compositeJobId) : null;
        const rollLen = rollLenFromLmView ?? rollLenScheduler ?? null;

        const durationSec = await resolveDurationSecondsForRunlistLinearGauge({
            card,
            compositeJobId,
            scannedAtIso,
            logsClient,
            machineId: machine.id,
            machineName: machine.name,
        });
        let metersPerHour = metersPerHourFromRollAndDuration(rollLen, durationSec);
        if (metersPerHour != null && (!Number.isFinite(metersPerHour) || metersPerHour <= 0)) {
            metersPerHour = null;
        }

        assignGauge({
            latest_runlist_id: latestRunlistId,
            scanned_at: scannedAtIso,
            composite_job_id: compositeJobId,
            pipeline_status: pipelineStatus,
            roll_length_metres: rollLen,
            meters_per_hour: metersPerHour,
        });
    } finally {
        logsClient.release();
    }
}

/** After merge: digital-cutter runlist gauge (same imposition-`lm` roll length path as slitter). */
export async function attachDigitalCutRunlistGaugeToProductionStatus(
    grouped: Record<string, ProductionStatusGroup>
): Promise<void> {
    await attachRunlistLinearGaugeForPlannerMachine(grouped, {
        prismaMachineName: 'digital_cutter',
        gaugeKey: 'digital_cut_gauge',
        scanMatchesOperations: scanIndicatesDigitalCut,
        pgRetryLabel: 'digital_cut_runlist_recent',
    });
}

/** After {@link mergeProductionStatusGroupsByCanonicalMachineId}: slitter snapshot from derived runlist scan. */
export async function attachSlitterRunlistGaugeToProductionStatus(
    grouped: Record<string, ProductionStatusGroup>
): Promise<void> {
    await attachRunlistLinearGaugeForPlannerMachine(grouped, {
        prismaMachineName: 'slitter_line',
        gaugeKey: 'slitter_gauge',
        scanMatchesOperations: scanIndicatesSlitter,
        pgRetryLabel: 'slitter_runlist_recent',
    });
}
