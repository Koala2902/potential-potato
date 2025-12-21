import { jobmanagerPool } from './jobmanager-connection.js';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Connection to logs database
const logsPool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: 'logs',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
});

interface PrintOSRecord {
    id: number;
    name: string; // imposition_id
    status: string; // 'PRINTED' or 'ABORTED'
    marker: number;
    job_complete_time: Date;
    copies: number;
}

/**
 * Get last processed marker for a given marker type
 */
async function getLastProcessedMarker(markerType: 'print_os' | 'scanned_codes'): Promise<number> {
    const client = await jobmanagerPool.connect();
    try {
        const result = await client.query(
            'SELECT last_processed_id FROM processing_markers WHERE marker_type = $1',
            [markerType]
        );
        
        if (result.rows.length === 0) {
            return 0;
        }
        
        return parseInt(result.rows[0].last_processed_id) || 0;
    } finally {
        client.release();
    }
}

/**
 * Update last processed marker
 */
async function updateLastProcessedMarker(markerType: 'print_os' | 'scanned_codes', markerId: number): Promise<void> {
    const client = await jobmanagerPool.connect();
    try {
        await client.query(
            `UPDATE processing_markers 
             SET last_processed_id = $1, 
                 last_processed_at = NOW(), 
                 updated_at = NOW() 
             WHERE marker_type = $2`,
            [markerId, markerType]
        );
    } finally {
        client.release();
    }
}

/**
 * Get file_ids for an imposition_id
 */
async function getFileIdsForImposition(impositionId: string): Promise<string[]> {
    const client = await logsPool.connect();
    try {
        const result = await client.query(
            'SELECT file_id FROM imposition_file_mapping WHERE imposition_id = $1 ORDER BY sequence_order NULLS LAST, file_id',
            [impositionId]
        );
        return result.rows.map(row => row.file_id);
    } finally {
        client.release();
    }
}

/**
 * Parse file_id to extract job_id and version_tag
 * Pattern: FILE_<version>_Labex_<job_id>_*
 * Example: FILE_1_Labex_4604_5889_80 -> job_id: "4604_5889", version: "1"
 */
function parseFileId(fileId: string): { jobId: string; versionTag: string } | null {
    // Skip file_ids without "labex" (case insensitive)
    if (!fileId.toLowerCase().includes('labex')) {
        return null;
    }
    
    // Pattern: FILE_<version>_Labex_<job_id>_*
    // Job_id can have multiple underscores (e.g., 4677_5995)
    // Example: FILE_1_Labex_4677_5995_80 -> version: 1, jobId: 4677_5995
    // Example: FILE_1_Labex_4677_5995_50 x 50 mm_Circle... -> version: 1, jobId: 4677_5995
    
    // Match the pattern: FILE_<version>_Labex_<everything_after>
    const match = fileId.match(/^FILE_(\d+)_Labex_(.+)$/);
    if (!match) {
        return null;
    }
    
    const versionTag = match[1];
    const afterLabex = match[2];
    
    // Split by underscore - extract only numeric parts at the beginning as job_id
    // Stop when we encounter non-numeric or descriptive text
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

/**
 * Check if Print OS name is a manual prepress file (Labex_<job_id> format)
 * Example: "Labex_4604_5889" -> job_id: "4604_5889"
 * Example: "Labex_4670_5988_MixedLabels_140 x 150 mm_Paper_Matt Laminate_1" -> job_id: "4670_5988"
 * Note: Extracts job_id from beginning, allows additional text after job_id
 */
function parseManualPrepressFile(name: string): { jobId: string } | null {
    // Pattern: Labex_<job_id> where job_id is numbers separated by underscores
    // Allows additional text after job_id (e.g., "Labex_4670_5988_MixedLabels_...")
    // This distinguishes from full imposition_id format like "Labex_4aa0cb5cd7_100x210_..."
    // The job_id pattern is: \d+(_\d+)+ (at least two numbers separated by underscore)
    const match = name.match(/^Labex_(\d+(_\d+)+)(?:_|$)/);
    if (!match) {
        return null;
    }
    
    const jobId = match[1];
    return { jobId };
}

/**
 * Get all version_tags for a job_id from job_operations table
 */
async function getAllVersionTagsForJob(jobId: string): Promise<string[]> {
    const client = await logsPool.connect();
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
 * Get operation_id for print operation from operations table
 */
async function getPrintOperationId(): Promise<string> {
    const client = await logsPool.connect();
    try {
        // Try to find print operation (operations table is in logs database)
        const result = await client.query(
            `SELECT operation_id FROM operations 
             WHERE LOWER(operation_name) LIKE '%print%' 
             LIMIT 1`
        );
        
        if (result.rows.length > 0) {
            const opId = result.rows[0].operation_id;
            // Return lowercase to match job_operations table format
            return opId.toLowerCase();
        }
        
        // Fallback: use common operation IDs (lowercase)
        return 'op001';
    } finally {
        client.release();
    }
}

/**
 * Get all job_ids and version_tags from file_ids
 */
function extractJobIdsFromFileIds(fileIds: string[]): Map<string, Set<string>> {
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
    const client = await logsPool.connect();
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
    const client = await logsPool.connect();
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
        
        // If no rows updated, log a warning but don't fail (operation might not be planned for this job)
        if (updateResult.rowCount === 0) {
            console.warn(`No job_operations row found for job_id=${jobId}, version_tag=${versionTag}, operation_id=${operationId} - skipping update`);
        }
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
                    console.warn(`No job_operations row found for job_id=${jobId}, version_tag=${versionTag}, operation_id=${operationId} - skipping update`);
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
    const client = await jobmanagerPool.connect();
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
    } finally {
        client.release();
    }
}

/**
 * Get all file_ids for a job_id across all impositions
 */
async function getAllFileIdsForJob(jobId: string, versionTag: string): Promise<string[]> {
    const client = await logsPool.connect();
    try {
        // Find all file_ids that match this job_id and version_tag
        const pattern = `FILE_${versionTag}_Labex_${jobId}_%`;
        
        const result = await client.query(
            `SELECT DISTINCT file_id 
             FROM imposition_file_mapping 
             WHERE file_id LIKE $1`,
            [pattern]
        );
        
        return result.rows.map(row => row.file_id);
    } finally {
        client.release();
    }
}

/**
 * Check if all files for a job are printed and update job status accordingly
 */
async function checkAndUpdateJobPrintStatus(jobId: string, versionTag: string): Promise<void> {
    const client = await logsPool.connect();
    const jobmanagerClient = await jobmanagerPool.connect();
    
    try {
        // Get all file_ids for this job/version
        const fileIds = await getAllFileIdsForJob(jobId, versionTag);
        
        if (fileIds.length === 0) {
            return; // No files to check
        }

        // Get print operation_id
        const printOperationId = await getPrintOperationId();
        
        // Get all impositions that contain these file_ids
        const impositionResult = await client.query(
            `SELECT DISTINCT imposition_id 
             FROM imposition_file_mapping 
             WHERE file_id = ANY($1)`,
            [fileIds]
        );
        
        const impositionIds = impositionResult.rows.map(row => row.imposition_id);
        
        if (impositionIds.length === 0) {
            return;
        }

        // Count how many impositions have been printed (completed status)
        const result = await client.query(
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
            await jobmanagerClient.query(
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
            console.log(`  ✓ Job ${jobId} (v${versionTag}): All ${totalImpositions} impositions printed`);
        } else if (abortedImpositions === totalImpositions && totalImpositions > 0) {
            // All impositions aborted
            await jobmanagerClient.query(
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
            console.log(`  ✗ Job ${jobId} (v${versionTag}): All ${totalImpositions} impositions aborted`);
        } else if (printedImpositions > 0) {
            // Partial completion - update status to started
            await jobmanagerClient.query(
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
            console.log(`  ⚠ Job ${jobId} (v${versionTag}): Partial completion (${printedImpositions}/${totalImpositions} impositions printed)`);
        }
    } finally {
        client.release();
        jobmanagerClient.release();
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
    let lastMarker = 0;

    // Get last processed marker
    const lastProcessedMarker = await getLastProcessedMarker('print_os');
    console.log(`Processing Print OS records with marker > ${lastProcessedMarker}`);

    // Get unprocessed Print OS records
    const printOSClient = await jobmanagerPool.connect();

    try {
        // Query "print OS" table (note: table name has space, must be quoted)
        // Get all records, then deduplicate by name (imposition_id) keeping only the latest (highest marker)
        const printOSResult = await printOSClient.query(
            `SELECT id, name, status, marker, job_complete_time, copies 
             FROM "print OS" 
             WHERE marker > $1 
             ORDER BY marker ASC`,
            [lastProcessedMarker]
        );

        // Deduplicate: Group by name (imposition_id) and keep only the latest record (highest marker)
        const recordsMap = new Map<string, PrintOSRecord>();
        for (const row of printOSResult.rows) {
            const name = row.name;
            const marker = parseInt(row.marker);
            
            // If we haven't seen this imposition_id, or this marker is higher, use this record
            if (!recordsMap.has(name) || recordsMap.get(name)!.marker < marker) {
                recordsMap.set(name, {
                    id: parseInt(row.id),
                    name: name,
                    status: row.status, // 'PRINTED' or 'ABORTED'
                    marker: marker,
                    job_complete_time: row.job_complete_time,
                    copies: parseInt(row.copies) || 0,
                });
            }
        }

        const records = Array.from(recordsMap.values());
        const duplicateCount = printOSResult.rows.length - records.length;
        
        console.log(`Found ${printOSResult.rows.length} new Print OS records`);
        if (duplicateCount > 0) {
            console.log(`  Deduplicated: ${duplicateCount} duplicate records removed (using latest marker)`);
        }
        console.log(`  Processing ${records.length} unique records`);

        if (records.length === 0) {
            return { processed: 0, jobsUpdated: 0, lastMarker: lastProcessedMarker, errors: [] };
        }

        // Get operation_id for print operation
        const printOperationId = await getPrintOperationId();
        console.log(`Using operation_id: ${printOperationId} for print operations`);

        // Process each record
        for (const record of records) {
            try {
                const name = record.name;
                const status = record.status === 'PRINTED' ? 'completed' : 'aborted';
                const completedAt = record.job_complete_time || new Date();

                // Check if this is a manual prepress file (Labex_<job_id> format)
                const manualFile = parseManualPrepressFile(name);
                
                if (manualFile) {
                    // Manual prepress file - update ALL version_tags for this job_id
                    console.log(`Detected manual prepress file: ${name} -> job_id: ${manualFile.jobId}`);
                    
                    const versionTags = await getAllVersionTagsForJob(manualFile.jobId);
                    
                    if (versionTags.length === 0) {
                        console.warn(`No version_tags found for job_id: ${manualFile.jobId}`);
                        errors.push(`No version_tags found for job_id: ${manualFile.jobId}`);
                        // Still update marker even if skipped
                        lastMarker = Math.max(lastMarker, record.marker);
                        continue;
                    }

                    // Update job_operations for ALL version_tags
                    const uniqueJobs = new Set<string>();
                    for (const versionTag of Array.from(versionTags)) {
                        await updateJobOperation(
                            manualFile.jobId,
                            versionTag,
                            printOperationId,
                            status,
                            record.id,
                            completedAt,
                            'print_os'
                        );
                        
                        uniqueJobs.add(`${manualFile.jobId}_${versionTag}`);
                    }

                    jobsUpdated += uniqueJobs.size;
                    processed++;
                    lastMarker = Math.max(lastMarker, record.marker);

                    console.log(`✓ Processed manual prepress file ${record.id}: ${name}, updated ${uniqueJobs.size} jobs (all versions)`);
                    
                    // After updating operations, check and update job print status for each unique job
                    for (const jobKey of uniqueJobs) {
                        // jobKey format: "jobId_versionTag" where jobId may contain underscores
                        // Extract versionTag (last part) and jobId (everything before last underscore)
                        const lastUnderscore = jobKey.lastIndexOf('_');
                        if (lastUnderscore > 0) {
                            const jobId = jobKey.substring(0, lastUnderscore);
                            const versionTag = jobKey.substring(lastUnderscore + 1);
                            await checkAndUpdateJobPrintStatus(jobId, versionTag);
                        }
                    }
                    
                    continue;
                }

                // Regular imposition_id lookup
                const impositionId = name;
                const fileIds = await getFileIdsForImposition(impositionId);

                if (fileIds.length === 0) {
                    // Check if name contains "labex" but couldn't match
                    if (name.toLowerCase().includes('labex')) {
                        console.warn(`Labex file found but imposition_id not recognised: ${impositionId}`);
                        errors.push(`Labex file but imposition_id not recognised: ${impositionId}`);
                    } else {
                        console.warn(`Imposition ID not recognised (non-labex): ${impositionId}`);
                        // Don't add to errors for non-labex files - just skip
                    }
                    // Still update marker even if skipped, so we don't reprocess
                    lastMarker = Math.max(lastMarker, record.marker);
                    continue;
                }

                // Extract job_ids and version_tags from file_ids (only labex files)
                const jobMap = extractJobIdsFromFileIds(fileIds);

                if (jobMap.size === 0) {
                    console.warn(`No labex file_ids found for imposition_id: ${impositionId}`);
                    errors.push(`No labex file_ids found for imposition_id: ${impositionId}`);
                    // Still update marker even if skipped
                    lastMarker = Math.max(lastMarker, record.marker);
                    continue;
                }

                // Update imposition_operations
                await updateImpositionOperation(
                    impositionId,
                    printOperationId,
                    status,
                    record.id,
                    completedAt,
                    'print_os'
                );

                // Update job_operations for each job_id/version_tag combination
                const uniqueJobs = new Set<string>();
                for (const [jobId, versionTags] of Array.from(jobMap.entries())) {
                    for (const versionTag of Array.from(versionTags)) {
                        await updateJobOperation(
                            jobId,
                            versionTag,
                            printOperationId,
                            status,
                            record.id,
                            completedAt,
                            'print_os'
                        );
                        
                        uniqueJobs.add(`${jobId}_${versionTag}`);
                    }
                }

                jobsUpdated += uniqueJobs.size;
                processed++;
                lastMarker = Math.max(lastMarker, record.marker);

                console.log(`✓ Processed Print OS record ${record.id}: ${impositionId}, status: ${status}, updated ${uniqueJobs.size} jobs`);
                
                // After updating operations, check and update job print status for each unique job
                for (const jobKey of uniqueJobs) {
                    // jobKey format: "jobId_versionTag" where jobId may contain underscores
                    // Extract versionTag (last part) and jobId (everything before last underscore)
                    const lastUnderscore = jobKey.lastIndexOf('_');
                    if (lastUnderscore > 0) {
                        const jobId = jobKey.substring(0, lastUnderscore);
                        const versionTag = jobKey.substring(lastUnderscore + 1);
                        await checkAndUpdateJobPrintStatus(jobId, versionTag);
                    }
                }

            } catch (error: any) {
                console.error(`✗ Error processing Print OS record ${record.id}:`, error.message);
                errors.push(`Record ${record.id}: ${error.message}`);
            }
        }

        // Update last processed marker to highest marker we saw (even if some were skipped)
        if (records.length > 0) {
            const highestMarker = Math.max(...records.map(r => r.marker));
            if (highestMarker > lastProcessedMarker) {
                await updateLastProcessedMarker('print_os', highestMarker);
                console.log(`Updated last processed marker to ${highestMarker} (processed ${processed}, skipped ${records.length - processed})`);
            }
        }

    } finally {
        printOSClient.release();
    }

    return {
        processed,
        jobsUpdated,
        lastMarker,
        errors,
    };
}

/**
 * Verify that an operation_id exists in the database
 */
async function verifyOperationIdExists(operationId: string): Promise<boolean> {
    const client = await jobmanagerPool.connect();
    try {
        const result = await client.query(
            `SELECT EXISTS(SELECT 1 FROM operations WHERE operation_id = $1 LIMIT 1)`,
            [operationId]
        );
        return result.rows[0].exists;
    } finally {
        client.release();
    }
}

/**
 * Get operation name by operation_id
 * Note: operations table is in logs database, uses lowercase (op001, op002, etc.)
 */
async function getOperationNameById(operationId: string): Promise<string | null> {
    const client = await logsPool.connect();
    try {
        // Normalize to lowercase for querying (logs operations table uses lowercase)
        const normalizedId = operationId.toLowerCase();
        const result = await client.query(
            `SELECT operation_name FROM operations WHERE LOWER(operation_id) = $1 LIMIT 1`,
            [normalizedId]
        );
        return result.rows.length > 0 ? result.rows[0].operation_name : null;
    } finally {
        client.release();
    }
}

/**
 * Map operation name to operation_id
 * This maps frontend operation names to database operation_ids
 */
async function getOperationIdByName(operationName: string): Promise<string | null> {
    const client = await logsPool.connect();
    try {
        // Try to find operation by name (case insensitive, partial match)
        const normalized = operationName.toLowerCase().trim();
        
        // Map common operation names to operation_ids
        const operationMap: Record<string, string> = {
            'print': 'op001',
            'printing': 'op001',
            'coat': 'op002',
            'coating': 'op002',
            'kiss-cut': 'op003',
            'kiss cut': 'op003',
            'kisscut': 'op003',
            'slit': 'op004',
            'slitter': 'op004',
            'slitting': 'op004',
            'laminate': 'op005',
            'laminating': 'op005',
        };
        
        // Check if we have a direct mapping
        if (operationMap[normalized]) {
            return operationMap[normalized];
        }
        
        // Try to query operations table in logs database
        const result = await client.query(
            `SELECT operation_id FROM operations 
             WHERE LOWER(operation_name) LIKE $1 
             ORDER BY operation_id 
             LIMIT 1`,
            [`%${normalized}%`]
        );
        
        if (result.rows.length > 0) {
            return result.rows[0].operation_id.toLowerCase(); // Ensure lowercase
        }
        
        return null;
    } finally {
        client.release();
    }
}

/**
 * Check if code_text is a runlist_id
 */
async function isRunlistId(codeText: string): Promise<boolean> {
    const client = await logsPool.connect();
    try {
        const result = await client.query(
            'SELECT EXISTS(SELECT 1 FROM production_planner_paths WHERE runlist_id = $1 LIMIT 1)',
            [codeText]
        );
        return result.rows[0].exists;
    } finally {
        client.release();
    }
}

/**
 * Get all job_ids from a runlist_id
 */
async function getJobIdsFromRunlist(runlistId: string): Promise<Map<string, Set<string>>> {
    const client = await logsPool.connect();
    try {
        console.log(`[getJobIdsFromRunlist] Getting jobs for runlist: ${runlistId}`);
        // Get all impositions in this runlist
        const impositionsResult = await client.query(
            'SELECT DISTINCT imposition_id FROM production_planner_paths WHERE runlist_id = $1',
            [runlistId]
        );
        
        console.log(`[getJobIdsFromRunlist] Found ${impositionsResult.rows.length} impositions in runlist`);
        const jobMap = new Map<string, Set<string>>();
        
        // For each imposition, get file_ids and extract job_ids
        for (const row of impositionsResult.rows) {
            const impositionId = row.imposition_id;
            const fileIds = await getFileIdsForImposition(impositionId);
            console.log(`[getJobIdsFromRunlist] Imposition ${impositionId} has ${fileIds.length} file_ids`);
            
            // Extract job_ids from file_ids
            for (const fileId of fileIds) {
                const parsed = parseFileId(fileId);
                if (parsed) {
                    console.log(`[getJobIdsFromRunlist] Parsed file_id "${fileId}" -> jobId: "${parsed.jobId}", version: "${parsed.versionTag}"`);
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
    } finally {
        client.release();
    }
}

/**
 * Find runlist_id from job_id_version_tag scan
 */
async function findRunlistByJobScan(codeText: string): Promise<string | null> {
    const client = await logsPool.connect();
    try {
        // Parse job_id_version_tag format
        const parts = codeText.split('_');
        if (parts.length < 3) {
            return null;
        }
        
        const version = parts[parts.length - 1];
        const jobIdParts = parts.slice(0, -1);
        const jobId = jobIdParts.join('_');
        
        // Match file_id pattern: FILE_<version>_Labex_<job_id>_*
        const pattern = `FILE_${version}_Labex_${jobId}_%`;
        
        const result = await client.query(
            `SELECT DISTINCT ppp.runlist_id
             FROM imposition_file_mapping ifm
             INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
             WHERE ifm.file_id LIKE $1
             AND ppp.runlist_id IS NOT NULL
             LIMIT 1`,
            [pattern]
        );
        
        if (result.rows.length === 0) {
            return null;
        }
        
        return result.rows[0].runlist_id;
    } finally {
        client.release();
    }
}

/**
 * Get impositions for a job_id
 */
async function getImpositionsForJob(jobId: string, versionTag: string): Promise<string[]> {
    const client = await logsPool.connect();
    try {
        // Find file_ids that match this job_id and version_tag
        const pattern = `FILE_${versionTag}_Labex_${jobId}_%`;
        
        const result = await client.query(
            `SELECT DISTINCT imposition_id 
             FROM imposition_file_mapping 
             WHERE file_id LIKE $1`,
            [pattern]
        );
        
        return result.rows.map(row => row.imposition_id);
    } finally {
        client.release();
    }
}

/**
 * Process scanned codes and update job statuses
 */
export async function processScannedCodes(): Promise<{
    processed: number;
    jobsUpdated: number;
    lastScanId: number;
    errors: string[];
}> {
    const errors: string[] = [];
    let processed = 0;
    let jobsUpdated = 0;
    let lastScanId = 0;

    // Get last processed scan_id
    const lastProcessedScanId = await getLastProcessedMarker('scanned_codes');
    console.log(`Processing scanned codes with scan_id > ${lastProcessedScanId}`);

    const scannedClient = await logsPool.connect(); // Use logs database pool

    try {
        // Get new scanned codes from logs database
        const scannedResult = await scannedClient.query(
            `SELECT scan_id, code_text, scanned_at, machine_id, operations, metadata
             FROM scanned_codes
             WHERE scan_id > $1
             ORDER BY scan_id ASC`,
            [lastProcessedScanId]
        );

        const scans = scannedResult.rows;
        console.log(`Found ${scans.length} new scanned codes to process`);

        if (scans.length === 0) {
            return { processed: 0, jobsUpdated: 0, lastScanId: lastProcessedScanId, errors: [] };
        }

        // Process each scan
        for (const scan of scans) {
            try {
                const codeText = scan.code_text;
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
                    console.warn(`No operations found for scan ${scanId}`);
                    lastScanId = Math.max(lastScanId, scanId);
                    continue;
                }

                // Validate operation_ids exist in the database
                // Note: operations table uses uppercase (OP006), but job_operations uses lowercase (op006)
                const validOperationIds: string[] = [];
                for (const op of operationsArray) {
                    const opId = typeof op === 'string' ? op : String(op);
                    // Normalize to uppercase for checking against operations table
                    const normalizedOpId = opId.toUpperCase();
                    
                    // Check if it's already an operation_id (format: op###) or needs conversion
                    if (normalizedOpId.match(/^OP\d+$/)) {
                        // It's already an operation_id, verify it exists (check uppercase)
                        const exists = await verifyOperationIdExists(normalizedOpId);
                        if (exists) {
                            // Store as lowercase to match job_operations format
                            validOperationIds.push(normalizedOpId.toLowerCase());
                        } else {
                            console.warn(`Scan ${scanId}: Operation ID ${normalizedOpId} not found in database`);
                            errors.push(`Scan ${scanId}: Invalid operation_id: ${normalizedOpId}`);
                        }
                    } else {
                        // Try to convert operation name to operation_id
                        const convertedId = await getOperationIdByName(opId);
                        if (convertedId) {
                            // Convert to lowercase to match job_operations format
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
                            console.log(`Scan ${scanId}: Detected as file_id pattern: ${codeText}, found ${impositions.length} impositions`);
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
                                console.log(`Scan ${scanId}: Single job scan (no impositions found): ${jobId}, version: ${versionTag}`);
                            }
                        }
                    } else {
                        console.warn(`Scan ${scanId}: Could not parse code_text: ${codeText}`);
                        errors.push(`Scan ${scanId}: Could not parse code_text`);
                        lastScanId = Math.max(lastScanId, scanId);
                        continue;
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
                    // Use the stored runlist_id if available (for derived scans), otherwise use codeText (for direct runlist scans)
                    const runlistIdToQuery = runlistIdForProcessing || codeText;
                    const allImpositionsResult = await scannedClient.query(
                        'SELECT DISTINCT imposition_id FROM production_planner_paths WHERE runlist_id = $1',
                        [runlistIdToQuery]
                    );
                    allRunlistImpositions = allImpositionsResult.rows.map(row => row.imposition_id);
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
                        }
                    } else if (isFileIdScan) {
                        // For file_id scans, update all impositions that contain this file_id
                        for (const impositionId of fileIdImpositions) {
                            await updateImpositionOperation(
                                impositionId,
                                operationId,
                                'completed',
                                scanId,
                                scannedAt,
                                'scanner'
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

                console.log(`✓ Processed scan ${scanId}: ${codeText}, updated ${uniqueJobs.size} jobs, operations: ${validOperationIds.join(', ')}`);

            } catch (error: any) {
                const errorMsg = error.message || String(error);
                // Don't log "status column does not exist" errors as they're already handled in update functions
                if (!errorMsg.includes('column') || !errorMsg.includes('status')) {
                    console.error(`✗ Error processing scan ${scan.scan_id}:`, errorMsg);
                    errors.push(`Scan ${scan.scan_id}: ${errorMsg}`);
                }
                lastScanId = Math.max(lastScanId, parseInt(scan.scan_id));
            }
        }

        // Update last processed scan_id
        if (scans.length > 0) {
            const highestScanId = Math.max(...scans.map(s => parseInt(s.scan_id)));
            if (highestScanId > lastProcessedScanId) {
                await updateLastProcessedMarker('scanned_codes', highestScanId);
                console.log(`Updated last processed scan_id to ${highestScanId} (processed ${processed}, skipped ${scans.length - processed})`);
            }
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
