import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import {
    getProductionQueue,
    getImpositionDetails,
    getFileIds,
    findRunlistByScan,
    getProductionQueueByRunlist,
    getDistinctFileIdsForRunlist,
    findRunlistIdsMatchingScanFragment,
    findImpositionIdForScanInRunlist,
} from './db/queries.js';
import {
    getMachines,
    getAvailableOperations,
    getMachineModes,
    getSchedulerModesForMachine,
    getMachineIdForPlannerOperations,
    recordScannedCode,
    recordRunlistScans,
    getJobs,
} from './db/jobmanager-queries.js';
import {
    processPrintOSRecords,
    processScannedCodes,
    enrichProductionStatusWithSourceTables,
    mergeProductionStatusGroupsByCanonicalMachineId,
    backfillLegacyIndigoMachineIdsOnLogs,
} from './db/status-updates.js';
import { getPrintOsDatabaseUrl } from './db/database-config.js';
import logsPool from './db/connection.js';
import { appPool } from './db/app-connection.js';
import { plannerUrlsDiffer } from './db/planner-client.js';
import { PRODUCTION_COMPLETED_JOBS_PER_MACHINE } from './db/production-status-limits.js';
import { canonicalCompositeJobIdForDisplay } from './db/scan-job-version.js';
import { isUndefinedTableError } from './db/pg-errors.js';
import { schedulerRouter } from './scheduler-api.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

/**
 * Mounted folder for imposition PDFs (cannot use smb:// — mount the share in Finder, then use the /Volumes/... path).
 * Example Synology layout: .../RDevArchive/2026/<imposition_id>.pdf
 */
const PDF_ARCHIVE_PATH =
    process.env.PDF_ARCHIVE_PATH?.trim() ||
    '/Volumes/Daily Print Jobs/_NEXT HotFolder/RDevArchive';

/** Comma-separated year folder names to try under PDF_ARCHIVE_PATH (default: current year and two prior). */
function pdfYearSubfoldersToTry(): string[] {
    if (process.env.PDF_ARCHIVE_TRY_YEAR_SUBFOLDERS === 'false') {
        return [];
    }
    const custom = process.env.PDF_ARCHIVE_YEAR_FOLDERS?.trim();
    if (custom) {
        return custom.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const y = new Date().getFullYear();
    return [String(y), String(y - 1), String(y - 2)];
}

/** First path that exists: flat `<archive>/<id>.pdf`, then `<archive>/<year>/<id>.pdf`. */
function resolvePdfPathForImposition(impositionId: string): string | null {
    const name = `${impositionId}.pdf`;
    const direct = path.join(PDF_ARCHIVE_PATH, name);
    if (fs.existsSync(direct)) {
        return direct;
    }
    for (const y of pdfYearSubfoldersToTry()) {
        const nested = path.join(PDF_ARCHIVE_PATH, y, name);
        if (fs.existsSync(nested)) {
            return nested;
        }
    }
    return null;
}

console.log('Starting server...');
console.log(`Port: ${PORT}`);
console.log('Logs DB: configured via LOGS_DATABASE_URL or LOGS_DB_*');
console.log('App DB: configured via DATABASE_URL or APP_DB_*');
console.log(
    getPrintOsDatabaseUrl()
        ? `Print OS ("print OS" table): JOBMANAGER_DATABASE_URL → jobmanager (or dedicated URL)`
        : `Print OS: same as App DB (set JOBMANAGER_DATABASE_URL if "print OS" is on database jobmanager)`
);
console.log(`PDF archive: ${PDF_ARCHIVE_PATH} (flat + year subfolders: ${pdfYearSubfoldersToTry().join(', ') || 'off'})`);
if (!fs.existsSync(PDF_ARCHIVE_PATH)) {
    console.warn(
        `[pdf] Path does not exist or is not mounted. Mount the SMB share in Finder, set PDF_ARCHIVE_PATH to the RDevArchive folder (not smb://).`
    );
}

/** Logs a warning when no PDF exists under the archive (flat or year subfolder). */
function warnIfPdfMissing(impositionId: string): void {
    if (!resolvePdfPathForImposition(impositionId)) {
        console.warn(`[pdf] Not found under ${PDF_ARCHIVE_PATH}: ${impositionId}.pdf`);
    }
}

app.use(cors());
app.use(express.json());
app.use('/api/scheduler', schedulerRouter);

// Root route - server status
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        message: 'Production Suite API Server',
        version: '1.0.0',
        endpoints: {
            productionQueue: '/api/production-queue',
            impositionDetails: '/api/imposition/:impositionId',
            fileIds: '/api/imposition/:impositionId/file-ids',
            machines: '/api/machines',
            operations: '/api/operations?machineId=:machineId',
            machineModes: '/api/machine-modes?machineId=:machineId',
            schedulerModes: '/api/scheduler-modes?machineId=:machineId',
            scan: '/api/scan (POST)',
            scannedCodes: '/api/scanned-codes (POST)',
            jobs: '/api/jobs?status=print_ready&limit=100',
            schedulerJobs: '/api/scheduler/jobs',
            schedulerEstimate: '/api/scheduler/estimate (POST)',
            schedulerConfigMachines: '/api/scheduler/config/machines (GET, POST, PATCH)',
            schedulerConfigOperations: '/api/scheduler/config/machines/:id/operations (POST, PATCH, DELETE)',
            schedulerDiagnostics: '/api/scheduler/config/diagnostics',
            schedulerRoutingSettings: '/api/scheduler/settings/routing (GET, PUT)',
            schedulerTimeEstimatorSettings: '/api/scheduler/settings/time-estimator (GET)'
        },
        port: PORT,
        database: 'see LOGS_DATABASE_URL + DATABASE_URL'
    });
});

// Get production queue grouped by runlist_id
app.get('/api/production-queue', async (req, res) => {
    try {
        const queue = await getProductionQueue();
        res.json(queue);
    } catch (error) {
        console.error('Error fetching production queue:', error);
        res.status(500).json({ error: 'Failed to fetch production queue' });
    }
});

// Get imposition details
app.get('/api/imposition/:impositionId', async (req, res) => {
    try {
        const { impositionId } = req.params;
        const details = await getImpositionDetails(impositionId);
        res.json(details);
    } catch (error) {
        console.error('Error fetching imposition details:', error);
        res.status(500).json({ error: 'Failed to fetch imposition details' });
    }
});

// Get all file_ids for an imposition_id
app.get('/api/imposition/:impositionId/file-ids', async (req, res) => {
    try {
        const { impositionId } = req.params;
        const fileIds = await getFileIds(impositionId);
        res.json({ fileIds });
    } catch (error) {
        console.error('Error fetching file_ids:', error);
        res.status(500).json({ error: 'Failed to fetch file_ids' });
    }
});

// Check if PDF exists (HEAD request)
app.head('/api/pdf/:impositionId', async (req, res) => {
    try {
        const { impositionId } = req.params;
        const pdfPath = resolvePdfPathForImposition(impositionId);

        if (pdfPath && fs.existsSync(pdfPath)) {
            const stats = fs.statSync(pdfPath);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Length', stats.size.toString());
            res.status(200).end();
        } else {
            res.status(404).end();
        }
    } catch (error) {
        console.error('Error checking PDF:', error);
        res.status(500).end();
    }
});

// Serve PDF from archive folder
app.get('/api/pdf/:impositionId', async (req, res) => {
    try {
        const { impositionId } = req.params;
        const pdfPath = resolvePdfPathForImposition(impositionId);

        if (!pdfPath) {
            console.warn('[pdf] Not found:', path.join(PDF_ARCHIVE_PATH, `${impositionId}.pdf`), '(and year subfolders)');
            return res.status(404).json({ error: 'PDF not found' });
        }
        
        // Set headers for PDF
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${impositionId}.pdf"`);
        
        // Stream the PDF file
        const fileStream = fs.createReadStream(pdfPath);
        fileStream.pipe(res);
        
        fileStream.on('error', (error) => {
            console.error('Error streaming PDF:', error);
            res.status(500).json({ error: 'Failed to stream PDF' });
        });
    } catch (error) {
        console.error('Error serving PDF:', error);
        res.status(500).json({ error: 'Failed to serve PDF' });
    }
});

// Get machines from app database
app.get('/api/machines', async (req, res) => {
    try {
        const machines = await getMachines();
        res.json(machines);
    } catch (error) {
        console.error('Error fetching machines:', error);
        res.status(500).json({ error: 'Failed to fetch machines' });
    }
});

// Get available operations (filtered by machine_id)
app.get('/api/operations', async (req, res) => {
    try {
        const { machineId } = req.query;
        console.log('Fetching operations for machine_id:', machineId);
        const operations = await getAvailableOperations(machineId as string | undefined);
        console.log('Returning operations:', operations.length);
        res.json(operations);
    } catch (error) {
        console.error('Error fetching operations:', error);
        res.status(500).json({ error: 'Failed to fetch operations' });
    }
});

// Preset operation bundles per machine (optional; legacy `machine_modes` table)
app.get('/api/machine-modes', async (req, res) => {
    try {
        const { machineId } = req.query;
        const modes = await getMachineModes(machineId as string | undefined);
        res.json(modes);
    } catch (error) {
        console.error('Error fetching machine modes:', error);
        res.status(500).json({ error: 'Failed to fetch machine modes' });
    }
});

// Scheduler config modes (`Machine.constants.schedulerModes`) — Ticket scan UI
app.get('/api/scheduler-modes', async (req, res) => {
    try {
        const { machineId } = req.query;
        const modes = await getSchedulerModesForMachine(machineId as string | undefined);
        res.json(modes);
    } catch (error) {
        console.error('Error fetching scheduler modes:', error);
        res.status(500).json({ error: 'Failed to fetch scheduler modes' });
    }
});

// Record a scanned code
app.post('/api/scanned-codes', async (req, res) => {
    try {
        const { codeText, machineId, userId, operations, metadata, impositionId } = req.body;

        if (!codeText || typeof codeText !== 'string') {
            return res.status(400).json({ error: 'codeText is required' });
        }

        const imp =
            impositionId != null && typeof impositionId === 'string' && impositionId.trim()
                ? impositionId.trim()
                : null;

        const scannedCode = await recordScannedCode(
            codeText,
            machineId || null,
            userId || null,
            operations || null,
            metadata || null,
            imp
        );
        
        // Process the scan immediately (async, don't wait)
        processScannedCodes().catch(err => {
            console.error('Error processing scanned codes after new scan:', err);
        });
        
        res.json(scannedCode);
    } catch (error) {
        console.error('Error recording scanned code:', error);
        res.status(500).json({ error: 'Failed to record scanned code' });
    }
});

// Get production status by machine (last 5 completed + 1 processing per machine)
// Logs DB: job_operation_duration; imposition_file_mapping for version counts (logs pool only; merged in JS).
app.get('/api/production-status', async (req, res) => {
    try {
        const logsClient = await logsPool.connect();
        try {
            let result;
            try {
                result = await logsClient.query(`
                WITH job_version_counts AS (
                    SELECT 
                        jod.job_id,
                        jod.machine_id,
                        COUNT(DISTINCT jod.version_tag) as processed_versions,
                        MAX(
                            CASE 
                                WHEN jod.operation_completed_at IS NOT NULL 
                                THEN (
                                    CASE WHEN jod.operation_id = 'op001' THEN
                                        jod.operation_completed_at AT TIME ZONE 'Australia/Sydney'
                                    ELSE
                                        jod.operation_completed_at AT TIME ZONE 'UTC'
                                    END
                                )
                                ELSE NULL
                            END
                        ) as last_completed_at,
                        MAX(
                            CASE 
                                WHEN jod.operation_started_at IS NOT NULL 
                                THEN (
                                    CASE WHEN jod.operation_id = 'op001' THEN
                                        jod.operation_started_at AT TIME ZONE 'Australia/Sydney'
                                    ELSE
                                        jod.operation_started_at AT TIME ZONE 'UTC'
                                    END
                                )
                                ELSE NULL
                            END
                        ) as last_started_at,
                        BOOL_AND(jod.operation_completed_at IS NOT NULL) as all_completed,
                        MAX(jod.operation_id) as operation_id,
                        MAX(jod.operation_duration_seconds) as duration_seconds
                    FROM job_operation_duration jod
                    WHERE jod.machine_id IS NOT NULL
                    GROUP BY jod.job_id, jod.machine_id
                ),
                total_version_counts AS (
                    SELECT 
                        jvc.*,
                        jvc.processed_versions::bigint as total_versions
                    FROM job_version_counts jvc
                ),
                completed_jobs AS (
                    SELECT 
                        machine_id,
                        job_id,
                        processed_versions,
                        COALESCE(total_versions, processed_versions) as total_versions,
                        last_completed_at,
                        operation_id,
                        duration_seconds,
                        ROW_NUMBER() OVER (PARTITION BY machine_id ORDER BY last_completed_at DESC) as rn
                    FROM total_version_counts
                    WHERE all_completed = true
                ),
                processing_jobs AS (
                    SELECT 
                        machine_id,
                        job_id,
                        processed_versions,
                        COALESCE(total_versions, processed_versions) as total_versions,
                        last_started_at as last_completed_at,
                        operation_id,
                        duration_seconds,
                        ROW_NUMBER() OVER (PARTITION BY machine_id ORDER BY last_started_at DESC) as rn
                    FROM total_version_counts
                    WHERE all_completed = false
                )
                SELECT 
                    'completed' as status_type,
                    machine_id,
                    job_id,
                    processed_versions,
                    total_versions,
                    last_completed_at,
                    operation_id,
                    duration_seconds
                FROM completed_jobs
                WHERE rn <= ${PRODUCTION_COMPLETED_JOBS_PER_MACHINE}
                
                UNION ALL
                
                SELECT 
                    'processing' as status_type,
                    machine_id,
                    job_id,
                    processed_versions,
                    total_versions,
                    last_completed_at,
                    operation_id,
                    duration_seconds
                FROM processing_jobs
                WHERE rn = 1
                
                ORDER BY machine_id, status_type DESC, last_completed_at DESC;
            `);
            } catch (e) {
                if (isUndefinedTableError(e)) {
                    console.warn(
                        '[production-status] job_operation_duration missing on logs DB — run migrations (015 on logs). Returning [].'
                    );
                    return res.json([]);
                }
                throw e;
            }

            let rows = result.rows as any[];
            /** Merge duplicate SQL groups after normalizing legacy `5516_7121_1` → `5516_7121`. */
            const byKey = new Map<string, (typeof rows)[0]>();
            for (const row of rows) {
                const jid = canonicalCompositeJobIdForDisplay(row.job_id);
                const key = `${row.status_type}|${row.machine_id}|${jid}`;
                const prev = byKey.get(key);
                if (!prev) {
                    byKey.set(key, { ...row, job_id: jid });
                } else {
                    const tPrev = new Date(prev.last_completed_at).getTime();
                    const tNew = new Date(row.last_completed_at).getTime();
                    const best = tNew >= tPrev ? row : prev;
                    byKey.set(key, { ...best, job_id: jid });
                }
            }
            rows = Array.from(byKey.values());
            const jobIds = [...new Set(rows.map((r) => r.job_id))];
            if (jobIds.length > 0) {
                const ifmClient = await logsPool.connect();
                try {
                    try {
                        const tvResult = await ifmClient.query(
                            `SELECT j.job_id, (
                            SELECT COUNT(DISTINCT 
                                SPLIT_PART(SPLIT_PART(ifm.file_id, '_', 2), '_', 1)
                            )
                            FROM imposition_file_mapping ifm
                            WHERE ifm.file_id LIKE 'FILE\\_%\\_Labex\\_' || j.job_id || '\\_%' ESCAPE '\\'
                        )::bigint AS total_versions
                        FROM unnest($1::text[]) AS j(job_id)`,
                            [jobIds]
                        );
                        const byJob = new Map<string, number>();
                        for (const r of tvResult.rows) {
                            byJob.set(r.job_id, parseInt(r.total_versions, 10) || 0);
                        }
                        for (const row of rows) {
                            const n = byJob.get(row.job_id);
                            if (n !== undefined && n > 0) {
                                row.total_versions = n;
                            }
                        }
                    } catch (e) {
                        if (isUndefinedTableError(e)) {
                            console.warn(
                                '[production-status] imposition_file_mapping missing on logs DB — Using processed_versions as total_versions.'
                            );
                        } else {
                            throw e;
                        }
                    }
                } finally {
                    ifmClient.release();
                }
            }
            
            // Group by machine_id
            const grouped: Record<string, {
                machine_id: string;
                completed: any[];
                processing: any[];
            }> = {};
            
            rows.forEach((row: any) => {
                if (!grouped[row.machine_id]) {
                    grouped[row.machine_id] = {
                        machine_id: row.machine_id,
                        completed: [],
                        processing: [],
                    };
                }
                
                const progress = row.total_versions > 0 
                    ? Math.round((row.processed_versions / row.total_versions) * 100)
                    : 100;
                
                // Query returns timestamptz (absolute instant). op001 naive = Sydney wall time;
                // scanner ops (op002+) naive = UTC wall time — see job_operation_duration writers.
                const lastCompletedAt = row.last_completed_at 
                    ? new Date(row.last_completed_at).toISOString()
                    : null;
                
                const jobData = {
                    job_id: row.job_id,
                    processed_versions: parseInt(row.processed_versions) || 0,
                    total_versions: parseInt(row.total_versions) || 0,
                    last_completed_at: lastCompletedAt,
                    operation_id: row.operation_id,
                    duration_seconds: row.duration_seconds,
                    progress,
                };
                
                if (row.status_type === 'completed') {
                    grouped[row.machine_id].completed.push(jobData);
                } else {
                    grouped[row.machine_id].processing.push(jobData);
                }
            });

            await enrichProductionStatusWithSourceTables(grouped);
            await mergeProductionStatusGroupsByCanonicalMachineId(grouped);

            const allJobIds = new Set<string>();
            for (const g of Object.values(grouped)) {
                for (const j of [...g.completed, ...g.processing]) {
                    if (j.job_id) allJobIds.add(j.job_id);
                }
            }
            if (allJobIds.size > 0) {
                const ifmClient2 = await logsPool.connect();
                try {
                    try {
                        const tvResult2 = await ifmClient2.query(
                            `SELECT j.job_id, (
                            SELECT COUNT(DISTINCT 
                                SPLIT_PART(SPLIT_PART(ifm.file_id, '_', 2), '_', 1)
                            )
                            FROM imposition_file_mapping ifm
                            WHERE ifm.file_id LIKE 'FILE\\_%\\_Labex\\_' || j.job_id || '\\_%' ESCAPE '\\'
                        )::bigint AS total_versions
                        FROM unnest($1::text[]) AS j(job_id)`,
                            [Array.from(allJobIds)]
                        );
                        const byJob2 = new Map<string, number>();
                        for (const r of tvResult2.rows) {
                            byJob2.set(r.job_id, parseInt(r.total_versions, 10) || 0);
                        }
                        for (const g of Object.values(grouped)) {
                            for (const j of [...g.completed, ...g.processing]) {
                                const n = byJob2.get(j.job_id);
                                if (n !== undefined && n > 0) {
                                    j.total_versions = n;
                                    j.progress =
                                        n > 0 ? Math.round((j.processed_versions / n) * 100) : 100;
                                }
                            }
                        }
                    } catch (e) {
                        if (isUndefinedTableError(e)) {
                            console.warn(
                                '[production-status] imposition_file_mapping missing on logs DB — skip total_versions merge after enrich.'
                            );
                        } else {
                            throw e;
                        }
                    }
                } finally {
                    ifmClient2.release();
                }
            }

            res.json(Object.values(grouped));
        } finally {
            logsClient.release();
        }
    } catch (error: any) {
        console.error('Error fetching production status:', error);
        res.status(500).json({ error: 'Failed to fetch production status', message: error.message });
    }
});

async function getVersionTagsForJob(jobId: string): Promise<string[]> {
    const jobOpsPoolForStatus = plannerUrlsDiffer() ? logsPool : appPool;
    let versionTags: string[] = [];

    const cJobOps = await jobOpsPoolForStatus.connect();
    try {
        const jobOpsResult = await cJobOps.query(
            `
            SELECT DISTINCT version_tag
            FROM job_operations
            WHERE job_id = $1
            ORDER BY version_tag
        `,
            [jobId]
        );
        versionTags = jobOpsResult.rows.map((row) => row.version_tag).filter(Boolean);
    } finally {
        cJobOps.release();
    }

    if (versionTags.length === 0) {
        const cIfm = await logsPool.connect();
        try {
            const fileIdsResult = await cIfm.query(
                `
                SELECT DISTINCT 
                    SPLIT_PART(SPLIT_PART(file_id, '_', 2), '_', 1) as version_tag
                FROM imposition_file_mapping
                WHERE file_id LIKE $1
            `,
                [`FILE_%_Labex_${jobId}_%`]
            );
            versionTags = fileIdsResult.rows.map((row) => row.version_tag).filter(Boolean);
        } finally {
            cIfm.release();
        }
    }

    if (versionTags.length === 0) {
        const cSc = await logsPool.connect();
        try {
            const scannedCodesResult = await cSc.query(
                `
                SELECT DISTINCT 
                    SPLIT_PART(code_text, '_', 3) as version_tag
                FROM scanned_codes
                WHERE code_text LIKE $1
                AND code_text ~ '^\\d+_\\d+_\\d+$'
            `,
                [`${jobId}_%`]
            );
            versionTags = scannedCodesResult.rows.map((row) => row.version_tag).filter(Boolean);
        } finally {
            cSc.release();
        }
    }

    return versionTags.length > 0 ? versionTags : ['1'];
}

// Update runlist status (updates all jobs in the runlist)
app.put('/api/runlists/:runlistId/status', async (req, res) => {
    try {
        const { runlistId } = req.params;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }

        const validStatuses = ['print_ready', 'printed', 'digital_cut', 'slitter', 'production_finished'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        }

        const client = await logsPool.connect();
        try {
            // Get all job_ids in this runlist
            const runlistJobsResult = await client.query(`
                SELECT DISTINCT 
                    SPLIT_PART(SPLIT_PART(ifm.file_id, '_', 2), '_', 1) as version_tag,
                    SUBSTRING(ifm.file_id FROM 'FILE_\\d+_Labex_(.+?)_') as job_id
                FROM imposition_file_mapping ifm
                INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
                WHERE ppp.runlist_id = $1
                AND ifm.file_id LIKE 'FILE_%_Labex_%'
            `, [runlistId]);

            // Group by job_id and collect version_tags
            const jobVersionMap = new Map<string, string[]>();
            runlistJobsResult.rows.forEach((row) => {
                const jobId = row.job_id;
                const versionTag = row.version_tag;
                if (jobId && versionTag) {
                    if (!jobVersionMap.has(jobId)) {
                        jobVersionMap.set(jobId, []);
                    }
                    if (!jobVersionMap.get(jobId)!.includes(versionTag)) {
                        jobVersionMap.get(jobId)!.push(versionTag);
                    }
                }
            });

            const jobIds = Array.from(jobVersionMap.keys());
            console.log(`[PUT /api/runlists/:runlistId/status] Found ${jobIds.length} jobs in runlist ${runlistId}`);

            if (jobIds.length === 0) {
                return res.status(404).json({ error: `No jobs found in runlist ${runlistId}` });
            }

            // Update each job
            const { recordScannedCode } = await import('./db/jobmanager-queries.js');
            const statusToOperations: Record<string, string[]> = {
                'print_ready': [],
                'printed': ['op001'],
                'digital_cut': ['op002'],
                'slitter': ['op004'],
                'production_finished': ['op004'],
            };

            const requiredOperations = statusToOperations[status];
            const defaultMachineId = await getMachineIdForPlannerOperations(requiredOperations);
            const scannedCodes = [];

            for (const jobId of jobIds) {
                const versionTags = jobVersionMap.get(jobId) || [];
                
                for (const versionTag of versionTags) {
                    const codeText = `${jobId}_${versionTag}`;
                    const operationsObj = { operations: requiredOperations };

                    try {
                        const scannedCode = await recordScannedCode(
                            codeText,
                            defaultMachineId,
                            null,
                            operationsObj,
                            { 
                                source: 'job_status_page',
                                status_update: status,
                                runlist_id: runlistId,
                                timestamp: new Date().toISOString()
                            }
                        );
                        scannedCodes.push(scannedCode);
                    } catch (err: any) {
                        console.warn(`Failed to create scanned code for ${codeText}:`, err.message);
                    }
                }
            }

            const { processScannedCodes } = await import('./db/status-updates.js');
            try {
                await processScannedCodes();
            } catch (err: any) {
                console.warn('Error processing scanned codes after runlist update:', err?.message || err);
            }

            res.json({ 
                success: true, 
                runlistId, 
                status,
                jobsUpdated: jobIds.length,
                scannedCodesCreated: scannedCodes.length
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error updating runlist status:', error);
        res.status(500).json({ error: 'Failed to update runlist status' });
    }
});

// Move job between operation lanes by creating scan-tagged operation completion.
app.post('/api/jobs/:jobId/move-operation', async (req, res) => {
    try {
        const { jobId } = req.params;
        const { operationId } = req.body;
        const normalizedOperationId =
            typeof operationId === 'string' ? operationId.trim().toLowerCase() : '';
        const allowedOperationIds = ['op001', 'op002', 'op003', 'op004'];

        if (!allowedOperationIds.includes(normalizedOperationId)) {
            return res.status(400).json({
                error: `operationId must be one of: ${allowedOperationIds.join(', ')}`,
            });
        }

        const requiredOperations = [normalizedOperationId];
        const versionTags = await getVersionTagsForJob(jobId);
        const defaultMachineId = await getMachineIdForPlannerOperations(requiredOperations);
        const scannedCodes = [];

        for (const versionTag of versionTags) {
            const codeText = `${jobId}_${versionTag}`;
            const scannedCode = await recordScannedCode(
                codeText,
                defaultMachineId,
                null,
                { operations: requiredOperations },
                {
                    source: 'job_page',
                    action: 'move_operation',
                    target_operation_id: normalizedOperationId,
                    timestamp: new Date().toISOString(),
                }
            );
            scannedCodes.push(scannedCode);
        }

        const processResult = await processScannedCodes();

        return res.json({
            success: true,
            jobId,
            operationId: normalizedOperationId,
            scannedCodesCreated: scannedCodes.length,
            versionTags,
            processResult,
        });
    } catch (error) {
        console.error('Error moving job operation:', error);
        return res.status(500).json({ error: 'Failed to move job operation' });
    }
});

// Update job status by creating scanned codes for appropriate operations
app.put('/api/jobs/:jobId/status', async (req, res) => {
    try {
        let { jobId } = req.params;
        const { status } = req.body;
        
        // Log the incoming jobId for debugging
        console.log(`[PUT /api/jobs/:jobId/status] Received jobId: "${jobId}", status: "${status}"`);

        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }

        const validStatuses = ['print_ready', 'printed', 'digital_cut', 'slitter', 'production_finished'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        }

        // Map status to planner operation ids (must match scheduler.Operation.plannerOperationId).
        // Slitting on slitter_line uses op004; kiss-cut uses op003 (see Config).
        const statusToOperations: Record<string, string[]> = {
            'print_ready': [], // No operations
            'printed': ['op001'],
            'digital_cut': ['op002'],
            'slitter': ['op004'],
            'production_finished': ['op004'],
        };

        const requiredOperations = statusToOperations[status];
        
        // If print_ready, we don't need to create any scans (just return success)
        if (status === 'print_ready') {
            return res.json({ success: true, jobId, status, note: 'No operations needed for print_ready' });
        }

            const versionTags = await getVersionTagsForJob(jobId);
            console.log(`Found ${versionTags.length} version_tags for job ${jobId}:`, versionTags);

            // Create scanned codes for each version_tag and each required operation
            const { recordScannedCode } = await import('./db/jobmanager-queries.js');
            const defaultMachineId = await getMachineIdForPlannerOperations(requiredOperations);
            const scannedCodes = [];

            for (const versionTag of versionTags) {
                // Format code_text as job_id_version_tag (e.g., "4677_5995_1")
                const codeText = `${jobId}_${versionTag}`;

                // Create operations object - format: { "operations": ["op001", "op002", ...] }
                // This matches what processScannedCodes expects
                const operationsObj = {
                    operations: requiredOperations
                };

                try {
                    // Create scanned code with all required operations at once
                    const scannedCode = await recordScannedCode(
                        codeText,
                        defaultMachineId,
                        null, // userId - not required
                        operationsObj, // operations object: { "operations": ["op001", ...] }
                        { 
                            source: 'job_status_page',
                            status_update: status,
                            timestamp: new Date().toISOString()
                        }
                    );
                    scannedCodes.push(scannedCode);
                } catch (err: any) {
                    console.warn(`Failed to create scanned code for ${codeText}:`, err.message);
                    // Continue with other version tags
                }
            }

            // Process scanned codes immediately to update job_operations
            const { processScannedCodes } = await import('./db/status-updates.js');
            let processResult = null;
            try {
                processResult = await processScannedCodes();
                console.log(`[PUT /api/jobs/:jobId/status] Processed scanned codes:`, processResult);
            } catch (processError: any) {
                console.warn('Error processing scanned codes after status update:', processError?.message || processError);
                // Don't fail the request - codes are recorded, they'll be processed later
            }

            res.json({
                success: true,
                jobId,
                status,
                scannedCodesCreated: scannedCodes.length,
                versionTagsProcessed: versionTags.length,
                versionTags: versionTags,
                processResult: processResult,
            });
    } catch (error) {
        console.error('Error updating job status:', error);
        res.status(500).json({ error: 'Failed to update job status' });
    }
});

// Get jobs from app database (job status views / job_operations) with optional filters
app.get('/api/jobs', async (req, res) => {
    try {
        const {
            status,
            excludeStatus,
            material,
            finishing,
            hasPrint,
            hasCoating,
            hasKissCut,
            hasBackscore,
            hasSlitter,
            dateFrom,
            dateTo,
            limit,
            offset,
            markerLatestCompletedAt,
            markerJobId,
            sort,
            includeRunlist,
        } = req.query;

        const filters: any = {};
        
        if (status) filters.status = status as string;
        if (excludeStatus) filters.excludeStatus = excludeStatus as string;
        if (material) filters.material = material as string;
        if (finishing) filters.finishing = finishing as string;
        if (hasPrint === 'true') filters.hasPrint = true;
        if (hasCoating === 'true') filters.hasCoating = true;
        if (hasKissCut === 'true') filters.hasKissCut = true;
        if (hasBackscore === 'true') filters.hasBackscore = true;
        if (hasSlitter === 'true') filters.hasSlitter = true;
        if (dateFrom) filters.dateFrom = dateFrom as string;
        if (dateTo) filters.dateTo = dateTo as string;
        if (limit) {
            const limitNum = parseInt(limit as string, 10);
            if (!isNaN(limitNum) && limitNum > 0) {
                filters.limit = limitNum;
            }
        }
        if (offset) {
            const offsetNum = parseInt(offset as string, 10);
            if (!isNaN(offsetNum) && offsetNum >= 0) {
                filters.offset = offsetNum;
            }
        }
        if (markerLatestCompletedAt) filters.markerLatestCompletedAt = markerLatestCompletedAt as string;
        if (markerJobId) filters.markerJobId = markerJobId as string;
        if (sort === 'none' || sort === 'latest') {
            filters.sort = sort as 'none' | 'latest';
        }
        if (includeRunlist === 'false') {
            filters.includeRunlist = false;
        } else if (includeRunlist === 'true') {
            filters.includeRunlist = true;
        }

        const jobs = await getJobs(filters);
        res.json(jobs);
    } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).json({ error: 'Failed to fetch jobs' });
    }
});

// Find runlist by scan (format: job_id_version_tag, e.g., "4604_5889_1")
// Also records the scan to scanned_codes when machineId is set (operations optional; omit for machine-only audit)
app.post('/api/scan', async (req, res) => {
    try {
        const { scan, machineId, operations, userId } = req.body;
        
        if (!scan || typeof scan !== 'string') {
            return res.status(400).json({ error: 'Scan input is required' });
        }

        console.log(
            `[POST /api/scan] scan="${scan}" machineId=${machineId ?? '—'} ops=${operations ? 'yes' : 'no'}`
        );
        const runlistId = await findRunlistByScan(scan);
        
        // Get individual file IDs for this runlist (for display purposes)
        let individualFileIds: any[] = [];
        if (runlistId) {
            try {
                const fileIdsResult = await getDistinctFileIdsForRunlist(runlistId);
                for (const row of fileIdsResult) {
                    const fileId = row.file_id;
                    const match = fileId.match(/^FILE_(\d+)_Labex_(.+)$/);
                    if (match) {
                        const versionTag = match[1];
                        const afterLabex = match[2];
                        const parts = afterLabex.split('_');
                        if (parts.length >= 2) {
                            const numericParts: string[] = [];
                            for (const part of parts) {
                                if (/^\d+$/.test(part)) {
                                    numericParts.push(part);
                                } else {
                                    break;
                                }
                            }
                            if (numericParts.length >= 2) {
                                const jobId = numericParts.join('_');
                                individualFileIds.push({
                                    file_id: fileId,
                                    code_text: `${jobId}_${versionTag}`,
                                    job_id: jobId,
                                    version_tag: versionTag
                                });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Error getting individual file IDs:', err);
            }
        }
        
        // Determine if this is a runlist scan or a file_id scan
        const isRunlistDirectScan = runlistId && scan === runlistId;

        /** Resolve imposition for this scan + runlist (embedded in code_text when recording; UI preview). */
        let scannedImpositionId: string | null = null;
        if (runlistId && !isRunlistDirectScan) {
            try {
                scannedImpositionId = await findImpositionIdForScanInRunlist(scan, runlistId);
                if (scannedImpositionId) {
                    warnIfPdfMissing(scannedImpositionId);
                }
            } catch (err) {
                console.error(`[POST /api/scan] Error finding imposition_id:`, err);
            }
        }

        // Record scan to scanned_codes when machineId is set (operations optional)
        let recordedScans: any[] = [];
        if (machineId && typeof machineId === 'string' && machineId.trim()) {
            const hasOpList =
                operations && Array.isArray(operations) && operations.length > 0;
            const opsPayload: Record<string, unknown> | null = hasOpList
                ? { operations }
                : null;
            try {
                if (isRunlistDirectScan) {
                    const scans = await recordRunlistScans(
                        runlistId,
                        machineId,
                        userId || null,
                        opsPayload,
                        { timestamp: new Date().toISOString() }
                    );
                    recordedScans = scans.map((s) => ({
                        scan_id: s.scan_id,
                        code_text: s.code_text,
                        scanned_at: s.scanned_at,
                    }));
                } else {
                    const scannedCode = await recordScannedCode(
                        scan,
                        machineId,
                        userId || null,
                        opsPayload,
                        { timestamp: new Date().toISOString() },
                        scannedImpositionId
                    );
                    recordedScans = [
                        {
                            scan_id: scannedCode.scan_id,
                            code_text: scannedCode.code_text,
                            scanned_at: scannedCode.scanned_at,
                        },
                    ];
                }

                // Process the scan immediately when operations were sent (job pipeline); otherwise audit-only
                if (hasOpList) {
                    processScannedCodes().catch(err => {
                        console.error('Error processing scanned codes after new scan:', err);
                    });
                }
            } catch (recordError) {
                console.error('Error recording scan (continuing anyway):', recordError);
                // Continue even if recording fails
            }
        }
        if (!runlistId) {
            const matchIds = await findRunlistIdsMatchingScanFragment(scan);

            if (matchIds.length > 1) {
                return res.status(400).json({
                    error: `Multiple runlists found matching "${scan}". Please scan the full runlist ID.`,
                    matches: matchIds
                });
            } else if (matchIds.length === 1) {
                const queue = await getProductionQueueByRunlist(matchIds[0]);
                return res.json({
                    runlistId: matchIds[0],
                    queue,
                    recordedScans: recordedScans.length > 0 ? recordedScans : undefined
                });
            }

            return res.status(404).json({ error: `No runlist found for scan: "${scan}"` });
        }

        // Get production queue for this runlist (show all impositions)
        const queue = await getProductionQueueByRunlist(runlistId);

        res.json({ 
            runlistId, 
            queue,
            scannedImpositionId, // Send this so frontend can auto-select it
            recordedScans: recordedScans.length > 0 ? recordedScans : undefined
        });
    } catch (error) {
        console.error('Error processing scan:', error);
        res.status(500).json({ error: 'Failed to process scan' });
    }
});

// Get machine assignments
app.get('/api/machine-assignments', async (req, res) => {
    try {
        const client = await appPool.connect();
        try {
            // Check if table exists, if not return empty array
            const tableCheck = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    AND table_name = 'imposition_machine_assignments'
                );
            `);

            if (!tableCheck.rows[0].exists) {
                return res.json([]);
            }

            const result = await client.query(`
                SELECT imposition_id, machine_id, assigned_at, updated_at
                FROM imposition_machine_assignments
                ORDER BY assigned_at DESC
            `);

            res.json(result.rows);
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching machine assignments:', error);
        res.status(500).json({ error: 'Failed to fetch machine assignments' });
    }
});

// Assign imposition or runlist to machine
app.post('/api/assign-to-machine', async (req, res) => {
    try {
        const { type, id, machineId } = req.body;

        if (!type || !id || !machineId) {
            return res.status(400).json({ error: 'type, id, and machineId are required' });
        }

        if (type !== 'imposition' && type !== 'runlist') {
            return res.status(400).json({ error: 'type must be "imposition" or "runlist"' });
        }

        const client = await appPool.connect();
        try {
            // Ensure table exists
            await client.query(`
                CREATE TABLE IF NOT EXISTS imposition_machine_assignments (
                    imposition_id TEXT PRIMARY KEY,
                    machine_id TEXT NOT NULL,
                    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_imposition_machine_assignments_machine_id 
                ON imposition_machine_assignments(machine_id);
            `);

            if (type === 'imposition') {
                // Update or insert machine assignment for imposition
                await client.query(
                    `
                    INSERT INTO imposition_machine_assignments (imposition_id, machine_id, assigned_at, updated_at)
                    VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    ON CONFLICT (imposition_id) 
                    DO UPDATE SET 
                        machine_id = $2,
                        updated_at = CURRENT_TIMESTAMP
                `,
                    [id, machineId]
                );
            } else if (type === 'runlist') {
                // Get all impositions in the runlist
                const runlistResult = await client.query(
                    `
                    SELECT imposition_id
                    FROM production_planner_paths
                    WHERE runlist_id = $1
                `,
                    [id]
                );

                // Assign all impositions to the machine
                for (const row of runlistResult.rows) {
                    await client.query(
                        `
                        INSERT INTO imposition_machine_assignments (imposition_id, machine_id, assigned_at, updated_at)
                        VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        ON CONFLICT (imposition_id) 
                        DO UPDATE SET 
                            machine_id = $2,
                            updated_at = CURRENT_TIMESTAMP
                    `,
                        [row.imposition_id, machineId]
                    );
                }
            }

            res.json({ success: true, message: `Assigned ${type} to machine` });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error assigning to machine:', error);
        res.status(500).json({ error: 'Failed to assign to machine' });
    }
});

// Manual trigger for processing status updates
app.post('/api/process-status-updates', async (req, res) => {
    try {
        const { source } = req.body; // 'both', 'print_os', or 'scanner'
        
        const results: any = {
            timestamp: new Date().toISOString(),
        };

        if (!source || source === 'both' || source === 'print_os') {
            console.log('Processing Print OS records...');
            const printOSResult = await processPrintOSRecords();
            results.print_os = printOSResult;
        }

        if (!source || source === 'both' || source === 'scanner') {
            console.log('Processing scanned codes...');
            const scannerResult = await processScannedCodes();
            results.scanner = scannerResult;
        }

        res.json({
            success: true,
            results,
        });
    } catch (error) {
        console.error('Error processing status updates:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to process status updates',
            message: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

// Start scheduled processing (full: Print OS + scanned codes every 15 minutes; Print OS-only every 2 minutes)
let processingInterval: NodeJS.Timeout | null = null;
let printOsOnlyInterval: NodeJS.Timeout | null = null;

async function runPrintOsOnly() {
    try {
        const printOSResult = await processPrintOSRecords();
        if (printOSResult.processed > 0 || printOSResult.errors.length > 0) {
            console.log(
                `[PRINT_OS_POLL] processed ${printOSResult.processed}, jobs ${printOSResult.jobsUpdated}, errors ${printOSResult.errors.length}`
            );
        }
    } catch (error: any) {
        console.error('[PRINT_OS_POLL]', error.message);
    }
}

async function runProcessing() {
    console.log('\n[PROCESSING] Starting status update processing...');
    const startTime = Date.now();
    try {
        const printOSResult = await processPrintOSRecords();
        console.log(`[PROCESSING] Print OS: processed ${printOSResult.processed}, updated ${printOSResult.jobsUpdated} jobs, errors: ${printOSResult.errors.length}`);
        if (printOSResult.errors.length > 0) {
            console.log(`[PROCESSING] Print OS errors:`, printOSResult.errors.slice(0, 5));
        }
        
        const scannerResult = await processScannedCodes();
        console.log(`[PROCESSING] Scanner: processed ${scannerResult.processed}, updated ${scannerResult.jobsUpdated} jobs, errors: ${scannerResult.errors.length}`);
        if (scannerResult.errors.length > 0) {
            console.log(`[PROCESSING] Scanner errors:`, scannerResult.errors.slice(0, 5));
        }
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[PROCESSING] Processing completed in ${duration}s\n`);
    } catch (error: any) {
        console.error('[PROCESSING] Error during processing:', error.message);
        console.error('[PROCESSING] Stack:', error.stack);
    }
}

function startScheduledProcessing() {
    backfillLegacyIndigoMachineIdsOnLogs().catch((err) =>
        console.warn('[server] Indigo machine_id backfill:', err?.message || err)
    );

    // Run immediately on startup
    runProcessing();
    runPrintOsOnly();

    if (processingInterval) {
        clearInterval(processingInterval);
    }
    processingInterval = setInterval(runProcessing, 15 * 60 * 1000);

    if (printOsOnlyInterval) {
        clearInterval(printOsOnlyInterval);
    }
    printOsOnlyInterval = setInterval(runPrintOsOnly, 2 * 60 * 1000);

    console.log(
        '✅ Scheduled processing: full sync every 15m; Print OS poll every 2m (plus on startup)'
    );
}

const httpServer = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    startScheduledProcessing();
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
        console.error(
            `[server] Port ${PORT} is already in use. Stop the other process (e.g. another npm run dev) or run with PORT=3002`
        );
        process.exit(1);
    }
    console.error('[server] HTTP server error:', err);
    process.exit(1);
});

