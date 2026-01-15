import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { getProductionQueue, getImpositionDetails, getFileIds, findRunlistByScan, getProductionQueueByRunlist } from './db/queries.js';
import { getMachines, getAvailableOperations, recordScannedCode, recordRunlistScans, getJobs } from './db/jobmanager-queries.js';
import { processPrintOSRecords, processScannedCodes } from './db/status-updates.js';
import pool from './db/connection.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

console.log('Starting server...');
console.log(`Port: ${PORT}`);
console.log(`Database: ${process.env.DB_NAME || 'logs'}`);
console.log(`Host: ${process.env.DB_HOST || 'localhost'}`);

app.use(cors());
app.use(express.json());

// PDF archive folder path
const PDF_ARCHIVE_PATH = '/Volumes/Daily Print Jobs/_NEXT HotFolder/RDevArchive';

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
            scan: '/api/scan (POST)',
            scannedCodes: '/api/scanned-codes (POST)',
            jobs: '/api/jobs?status=print_ready&limit=100'
        },
        port: PORT,
        database: process.env.DB_NAME || 'logs'
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

// Serve PDF from archive folder
app.get('/api/pdf/:impositionId', async (req, res) => {
    try {
        const { impositionId } = req.params;
        const pdfPath = path.join(PDF_ARCHIVE_PATH, `${impositionId}.pdf`);
        
        // Check if file exists
        if (!fs.existsSync(pdfPath)) {
            console.log('PDF not found:', pdfPath);
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

// Get machines from jobmanager database
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

// Record a scanned code
app.post('/api/scanned-codes', async (req, res) => {
    try {
        const { codeText, machineId, userId, operations, metadata } = req.body;
        
        if (!codeText || typeof codeText !== 'string') {
            return res.status(400).json({ error: 'codeText is required' });
        }

        const scannedCode = await recordScannedCode(
            codeText,
            machineId || null,
            userId || null,
            operations || null,
            metadata || null
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
app.get('/api/production-status', async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            // Get completed operations (last 5 per machine) and processing operations (1 per machine)
            // Count version_tags from file_ids in imposition_file_mapping
            const result = await client.query(`
                WITH job_version_counts AS (
                    SELECT 
                        jod.job_id,
                        jod.machine_id,
                        COUNT(DISTINCT jod.version_tag) as processed_versions,
                        -- operation_completed_at is stored as TIMESTAMP (no timezone) representing Australian local time
                        -- We need to convert it properly: treat the stored value as Australian time, then convert to UTC
                        -- The stored value like '2026-01-15 15:13:13' should be interpreted as Australian time
                        -- AT TIME ZONE converts: Australian time -> UTC (subtracts 11 hours for AEDT)
                        MAX(
                            CASE 
                                WHEN jod.operation_completed_at IS NOT NULL 
                                -- First convert timestamp to text, then to timestamptz treating it as Australia/Sydney
                                THEN timezone('UTC', jod.operation_completed_at AT TIME ZONE 'Australia/Sydney')
                                ELSE NULL
                            END
                        ) as last_completed_at,
                        MAX(
                            CASE 
                                WHEN jod.operation_started_at IS NOT NULL 
                                THEN timezone('UTC', jod.operation_started_at AT TIME ZONE 'Australia/Sydney')
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
                        (
                            SELECT COUNT(DISTINCT 
                                SPLIT_PART(SPLIT_PART(ifm.file_id, '_', 2), '_', 1)
                            )
                            FROM imposition_file_mapping ifm
                            WHERE ifm.file_id LIKE 'FILE\\_%\\_Labex\\_' || jvc.job_id || '\\_%' ESCAPE '\\'
                        ) as total_versions
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
                WHERE rn <= 5
                
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
            
            // Group by machine_id
            const grouped: Record<string, {
                machine_id: string;
                completed: any[];
                processing: any[];
            }> = {};
            
            result.rows.forEach((row: any) => {
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
                
                // Convert timestamptz to ISO string for proper timezone handling in frontend
                // The timestamp from the query is already converted to UTC (timestamptz)
                // So we just need to convert it to ISO string
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
            
            res.json(Object.values(grouped));
        } finally {
            client.release();
        }
    } catch (error: any) {
        console.error('Error fetching production status:', error);
        res.status(500).json({ error: 'Failed to fetch production status', message: error.message });
    }
});

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

        const client = await pool.connect();
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
                'slitter': ['op003'],
                'production_finished': ['op004'],
            };

            const requiredOperations = statusToOperations[status];
            const scannedCodes = [];

            for (const jobId of jobIds) {
                const versionTags = jobVersionMap.get(jobId) || [];
                
                for (const versionTag of versionTags) {
                    const codeText = `${jobId}_${versionTag}`;
                    const operationsObj = { operations: requiredOperations };

                    try {
                        const scannedCode = await recordScannedCode(
                            codeText,
                            null,
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

            // Process scanned codes in background
            const { processScannedCodes } = await import('./db/status-updates.js');
            processScannedCodes().catch(err => 
                console.warn('Error processing scanned codes after runlist update:', err)
            );

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

        // Map status to operation IDs
        // Status is determined by operations: op001=printed, op002=digital_cut, op003=slitter, op004=production_finished
        const statusToOperations: Record<string, string[]> = {
            'print_ready': [], // No operations
            'printed': ['op001'],
            'digital_cut': ['op002'],
            'slitter': ['op003'], // Note: slitter can also be op002+op003, but we'll use op003
            'production_finished': ['op004'],
        };

        const requiredOperations = statusToOperations[status];
        
        // If print_ready, we don't need to create any scans (just return success)
        if (status === 'print_ready') {
            return res.json({ success: true, jobId, status, note: 'No operations needed for print_ready' });
        }

        const client = await pool.connect();
        try {
            // Get all version_tags for this job from job_operations table (most reliable source)
            // Also try to get from file_ids as fallback
            let versionTags: string[] = [];
            
            // Method 1: Get from job_operations (most reliable)
            const jobOpsResult = await client.query(`
                SELECT DISTINCT version_tag
                FROM job_operations
                WHERE job_id = $1
                ORDER BY version_tag
            `, [jobId]);
            
            versionTags = jobOpsResult.rows.map(row => row.version_tag).filter(Boolean);
            
            // Method 2: If no version_tags found in job_operations, try to get from file_ids
            if (versionTags.length === 0) {
                console.log(`No version_tags in job_operations for job ${jobId}, trying file_ids...`);
                const fileIdsResult = await client.query(`
                    SELECT DISTINCT 
                        SPLIT_PART(SPLIT_PART(file_id, '_', 2), '_', 1) as version_tag
                    FROM imposition_file_mapping
                    WHERE file_id LIKE $1
                `, [`FILE_%_Labex_${jobId}_%`]);
                
                versionTags = fileIdsResult.rows.map(row => row.version_tag).filter(Boolean);
            }
            
            // Method 3: If still no version_tags, try parsing from scanned_codes
            if (versionTags.length === 0) {
                console.log(`No version_tags in file_ids for job ${jobId}, trying scanned_codes...`);
                const scannedCodesResult = await client.query(`
                    SELECT DISTINCT 
                        SPLIT_PART(code_text, '_', 3) as version_tag
                    FROM scanned_codes
                    WHERE code_text LIKE $1
                    AND code_text ~ '^\\d+_\\d+_\\d+$'
                `, [`${jobId}_%`]);
                
                versionTags = scannedCodesResult.rows.map(row => row.version_tag).filter(Boolean);
            }

            if (versionTags.length === 0) {
                // If still no version_tags, use a default version_tag of "1"
                console.warn(`No version_tags found for job ${jobId}, using default version_tag "1"`);
                versionTags = ['1'];
            }
            
            console.log(`Found ${versionTags.length} version_tags for job ${jobId}:`, versionTags);

            // Create scanned codes for each version_tag and each required operation
            const { recordScannedCode } = await import('./db/jobmanager-queries.js');
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
                        null, // machineId - not required for status update
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
                processResult: processResult
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error updating job status:', error);
        res.status(500).json({ error: 'Failed to update job status' });
    }
});

// Get jobs from jobmanager database with optional filters
app.get('/api/jobs', async (req, res) => {
    try {
        const {
            status,
            material,
            finishing,
            hasPrint,
            hasCoating,
            hasKissCut,
            hasBackscore,
            hasSlitter,
            dateFrom,
            dateTo,
            limit
        } = req.query;

        const filters: any = {};
        
        if (status) filters.status = status as string;
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

        const jobs = await getJobs(filters);
        res.json(jobs);
    } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).json({ error: 'Failed to fetch jobs' });
    }
});

// Find runlist by scan (format: job_id_version_tag, e.g., "4604_5889_1")
// Also records the scan to scanned_codes if machineId and operations are provided
app.post('/api/scan', async (req, res) => {
    try {
        const { scan, machineId, operations, userId } = req.body;
        
        if (!scan || typeof scan !== 'string') {
            return res.status(400).json({ error: 'Scan input is required' });
        }

        console.log(`[POST /api/scan] Processing scan: "${scan}"`);
        console.log(`[POST /api/scan] Request body - machineId: ${machineId}, operations: ${JSON.stringify(operations)}, userId: ${userId}`);
        const runlistId = await findRunlistByScan(scan);
        
        // Get individual file IDs for this runlist (for display purposes)
        let individualFileIds: any[] = [];
        if (runlistId) {
            try {
                const client = await pool.connect();
                try {
                    const fileIdsResult = await client.query(`
                        SELECT DISTINCT ifm.file_id
                        FROM imposition_file_mapping ifm
                        INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
                        WHERE ppp.runlist_id = $1
                        ORDER BY ifm.file_id
                    `, [runlistId]);
                    
                    // Parse file_ids to get simplified job_id_version_tag format
                    for (const row of fileIdsResult.rows) {
                        const fileId = row.file_id;
                        // Simple parsing - extract job_id and version_tag
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
                    console.log(`[POST /api/scan] Found ${individualFileIds.length} individual file_ids in runlist`);
                } finally {
                    client.release();
                }
            } catch (err) {
                console.error('Error getting individual file IDs:', err);
            }
        }
        
        // Determine if this is a runlist scan or a file_id scan
        const isRunlistDirectScan = runlistId && scan === runlistId;
        
        // Record scan to scanned_codes if machineId and operations are provided
        let recordedScans: any[] = [];
        if (machineId && operations && Array.isArray(operations) && operations.length > 0) {
            console.log(`[POST /api/scan] machineId and operations provided, will record scans`);
            try {
                if (isRunlistDirectScan) {
                    // If user scanned the actual runlist barcode, record scans for all files
                    console.log(`[POST /api/scan] Direct runlist scan detected for ${runlistId}, recording scans for all file_ids`);
                    const scans = await recordRunlistScans(
                        runlistId,
                        machineId,
                        userId || null,
                        { operations },
                        { timestamp: new Date().toISOString() }
                    );
                    recordedScans = scans.map(s => ({
                        scan_id: s.scan_id,
                        code_text: s.code_text,
                        scanned_at: s.scanned_at
                    }));
                    console.log(`[POST /api/scan] Recorded ${recordedScans.length} individual file_id scans`);
                } else {
                    // Regular scan (single file_id or job_id_version_tag), record only the scanned item
                    console.log(`[POST /api/scan] Individual file scan, recording only: ${scan}`);
                    const scannedCode = await recordScannedCode(
                        scan,
                        machineId,
                        userId || null,
                        { operations },
                        { timestamp: new Date().toISOString() }
                    );
                    recordedScans = [{
                        scan_id: scannedCode.scan_id,
                        code_text: scannedCode.code_text,
                        scanned_at: scannedCode.scanned_at
                    }];
                }
                
                // Process the scan immediately (async, don't wait)
                processScannedCodes().catch(err => {
                    console.error('Error processing scanned codes after new scan:', err);
                });
            } catch (recordError) {
                console.error('Error recording scan (continuing anyway):', recordError);
                // Continue even if recording fails
            }
        } else {
            console.log(`[POST /api/scan] Skipping scan recording - machineId: ${machineId}, operations: ${JSON.stringify(operations)}`);
        }
        if (!runlistId) {
            // Check if multiple runlists matched (partial match returned null)
            const client = await pool.connect();
            try {
                const multipleMatch = await client.query(
                    `SELECT DISTINCT runlist_id 
                     FROM production_planner_paths 
                     WHERE (runlist_id LIKE $1 OR runlist_id LIKE $2)
                     AND runlist_id IS NOT NULL`,
                    [`${scan}%`, `%${scan}%`]
                );
                
                console.log(`[POST /api/scan] Multiple match check: ${multipleMatch.rows.length} results`);
                
                if (multipleMatch.rows.length > 1) {
                    console.log(`[POST /api/scan] Multiple matches found:`, multipleMatch.rows.map(r => r.runlist_id));
                    return res.status(400).json({ 
                        error: `Multiple runlists found matching "${scan}". Please scan the full runlist ID.`,
                        matches: multipleMatch.rows.map(r => r.runlist_id)
                    });
                } else if (multipleMatch.rows.length === 1) {
                    // This shouldn't happen, but handle it just in case
                    console.log(`[POST /api/scan] Found single match in error check: ${multipleMatch.rows[0].runlist_id}`);
                    const queue = await getProductionQueueByRunlist(multipleMatch.rows[0].runlist_id);
                    return res.json({ 
                        runlistId: multipleMatch.rows[0].runlist_id, 
                        queue,
                        recordedScans: recordedScans.length > 0 ? recordedScans : undefined
                    });
                }
            } finally {
                client.release();
            }
            
            console.log(`[POST /api/scan] No runlist found for scan: "${scan}"`);
            return res.status(404).json({ error: `No runlist found for scan: "${scan}"` });
        }
        
        console.log(`[POST /api/scan] Found runlist: ${runlistId}`);

        // Get production queue for this runlist (show all impositions)
        const queue = await getProductionQueueByRunlist(runlistId);
        
        // Find which specific imposition contains the scanned file (for auto-selection)
        let scannedImpositionId: string | null = null;
        if (!isRunlistDirectScan && queue.length > 0) {
            const client = await pool.connect();
            try {
                // Parse scan to find the file_id pattern
                const parts = scan.split('_');
                if (parts.length >= 3) {
                    const version = parts[parts.length - 1];
                    const jobIdParts = parts.slice(0, -1);
                    const jobId = jobIdParts.join('_');
                    const filePattern = `FILE_${version}_Labex_${jobId}_%`;
                    
                    const impositionResult = await client.query(`
                        SELECT DISTINCT imposition_id
                        FROM imposition_file_mapping
                        WHERE file_id LIKE $1
                        LIMIT 1
                    `, [filePattern]);
                    
                    if (impositionResult.rows.length > 0) {
                        scannedImpositionId = impositionResult.rows[0].imposition_id;
                        console.log(`[POST /api/scan] Scanned file belongs to imposition: ${scannedImpositionId}`);
                    }
                }
            } finally {
                client.release();
            }
        }
        
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
        const client = await pool.connect();
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

        const client = await pool.connect();
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

// Start scheduled processing (every 15 minutes)
let processingInterval: NodeJS.Timeout | null = null;

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
    // Run immediately on startup
    runProcessing();
    
    // Clear any existing interval
    if (processingInterval) {
        clearInterval(processingInterval);
    }

    // Process every 15 minutes (900000 ms)
    processingInterval = setInterval(runProcessing, 15 * 60 * 1000); // 15 minutes

    console.log('✅ Scheduled processing started (runs immediately, then every 15 minutes)');
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    startScheduledProcessing();
});

