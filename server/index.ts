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
    try {
        const printOSResult = await processPrintOSRecords();
        console.log(`[PROCESSING] Print OS: processed ${printOSResult.processed}, updated ${printOSResult.jobsUpdated} jobs`);
        
        const scannerResult = await processScannedCodes();
        console.log(`[PROCESSING] Scanner: processed ${scannerResult.processed}, updated ${scannerResult.jobsUpdated} jobs`);
        
        console.log('[PROCESSING] Processing completed\n');
    } catch (error) {
        console.error('[PROCESSING] Error during processing:', error);
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

