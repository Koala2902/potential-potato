import { jobmanagerPool } from './jobmanager-connection.js';
import pool from './connection.js'; // logs database pool

// Import parseFileId function to extract job_id and version_tag from file_id
// We'll need to duplicate the function here or import it
function parseFileId(fileId: string): { jobId: string; versionTag: string } | null {
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

// Get all machines
export async function getMachines(): Promise<Machine[]> {
    const client = await jobmanagerPool.connect();
    try {
        const result = await client.query(`
            SELECT 
                machine_id,
                machine_name,
                machine_type,
                capabilities,
                hourly_rate_aud,
                max_web_width_mm,
                availability_status,
                maintenance_schedule,
                shift_hours
            FROM machines
            WHERE availability_status != 'inactive' OR availability_status IS NULL
            ORDER BY machine_name
        `);
        return result.rows;
    } finally {
        client.release();
    }
}

export interface Operation {
    operation_id: string;
    operation_name: string;
    description?: string;
    created_at?: string;
}

// Get all available operations from logs database (no machine filtering)
export async function getAvailableOperations(machineId?: string | null): Promise<Operation[]> {
    // Import logs pool (default export)
    const logsPool = (await import('./connection.js')).default;
    
    const client = await logsPool.connect();
    try {
        const result = await client.query(`
            SELECT 
                operation_id,
                operation_name,
                description,
                created_at
            FROM operations
            ORDER BY operation_id
        `);
        
        return result.rows;
    } finally {
        client.release();
    }
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

// Record a scanned code (now in logs database)
export async function recordScannedCode(
    codeText: string,
    machineId: string | null,
    userId: string | null,
    operations: Record<string, any> | null = null,
    metadata: Record<string, any> | null = null
): Promise<ScannedCode> {
    const client = await pool.connect(); // Use logs database pool
    try {
        const result = await client.query(`
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
        `, [codeText, machineId, userId, operations ? JSON.stringify(operations) : null, metadata ? JSON.stringify(metadata) : null]);

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
    const client = await pool.connect();
    try {
        // Get all file_ids in this runlist
        const fileIdsResult = await client.query(`
            SELECT DISTINCT ifm.file_id
            FROM imposition_file_mapping ifm
            INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
            WHERE ppp.runlist_id = $1
            ORDER BY ifm.file_id
        `, [runlistId]);
        
        const fileIds = fileIdsResult.rows.map(row => row.file_id);
        console.log(`[recordRunlistScans] Found ${fileIds.length} file_ids in runlist ${runlistId}`);
        
        if (fileIds.length === 0) {
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
        for (const fileId of fileIds) {
            // Parse file_id to extract job_id and version_tag (do this outside try block for error handling)
            const parsed = parseFileId(fileId);
            if (!parsed) {
                console.warn(`[recordRunlistScans] Could not parse file_id: ${fileId}, skipping`);
                continue;
            }
            
            // Format as job_id_version_tag (e.g., "4677_5995_1")
            const codeText = `${parsed.jobId}_${parsed.versionTag}`;
            
            try {
                const result = await client.query(`
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
                `, [
                    codeText, // Use job_id_version_tag format (e.g., "4677_5995_1")
                    machineId,
                    userId,
                    operations ? JSON.stringify(operations) : null,
                    JSON.stringify(metadata)
                ]);
                
                recordedScans.push(result.rows[0]);
                console.log(`[recordRunlistScans] Successfully inserted scan for file_id ${fileId} -> code_text: ${codeText} (scan_id: ${result.rows[0].scan_id})`);
            } catch (err: any) {
                // Handle duplicate key errors on scan_id (shouldn't happen with SERIAL, but handle it)
                // Also handle any other errors gracefully - continue with next file_id
                if (err.message.includes('duplicate key') || err.message.includes('unique constraint')) {
                    // If scan_id conflict, fix the sequence and retry
                    try {
                        // Get current max scan_id
                        const maxIdResult = await client.query('SELECT MAX(scan_id) as max_id FROM scanned_codes');
                        const maxId = maxIdResult.rows[0].max_id || 0;
                        const nextId = maxId + 1;
                        
                        // Reset sequence to next available ID (use true to set is_called)
                        await client.query(`SELECT setval('scanned_codes_scan_id_seq', $1, true)`, [nextId]);
                        console.log(`[recordRunlistScans] Fixed sequence to ${nextId} for file_id ${fileId}`);
                        
                        // Retry insert with the same codeText
                        const retryResult = await client.query(`
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
                        `, [
                            codeText, // Use job_id_version_tag format
                            machineId,
                            userId,
                            operations ? JSON.stringify(operations) : null,
                            JSON.stringify(metadata)
                        ]);
                        
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
        client.release();
    }
}

// Get job by job_id or job_number
export async function getJobByIdentifier(identifier: string): Promise<any | null> {
    const client = await jobmanagerPool.connect();
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
    material?: string;
    finishing?: string;
    hasPrint?: boolean;
    hasCoating?: boolean;
    hasKissCut?: boolean;
    hasBackscore?: boolean;
    hasSlitter?: boolean;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
}

// Removed getScannedOperationsFromScannedCodes() - no longer needed
// The SQL function has_scanned_operation() in the view now handles scanned_codes directly

// Get all jobs grouped by job_id from job_status_view (logs database)
// Uses a pre-computed view for better performance
// Also checks scanned_codes table to include unprocessed scans
export async function getJobs(filters?: JobFilterOptions): Promise<any[]> {
    const client = await pool.connect();
    try {
        // Query from pre-computed view (faster than aggregating on-the-fly)
        let query = `SELECT * FROM job_status_view WHERE 1=1`;
        const params: any[] = [];
        let paramIndex = 1;

        // Status filter
        if (filters?.status) {
            query += ` AND status = $${paramIndex}`;
            params.push(filters.status);
            paramIndex++;
        }

        // Date range filters (using earliest_completed_at as proxy for created_at)
        if (filters?.dateFrom) {
            query += ` AND earliest_completed_at >= $${paramIndex}`;
            params.push(filters.dateFrom);
            paramIndex++;
        }

        if (filters?.dateTo) {
            query += ` AND earliest_completed_at <= $${paramIndex}`;
            params.push(filters.dateTo);
            paramIndex++;
        }

        // Try to order by updated_at first (most recent first), fallback to created_at
        let result;
        const limitValue = filters?.limit && filters.limit > 0 ? filters.limit : null;
        
        try {
            // Order by latest_completed_at DESC (most recent first), then by job_id for NULLs
            // This shows most recently updated jobs first, regardless of status
            query += ` ORDER BY latest_completed_at DESC NULLS LAST, job_id DESC`;
            
            // Don't apply limit here - let frontend filter by status and handle display
            // The frontend will show all jobs across different status cards
            result = await client.query(query, params);
        } catch (error: any) {
            // If latest_completed_at column doesn't exist, fallback to job_id
            if (error.message.includes('column') && error.message.includes('does not exist')) {
                query = query.replace(/ORDER BY.*/, 'ORDER BY job_id DESC');
                if (limitValue) {
                    const baseQuery = query.split('ORDER BY')[0];
                    query = baseQuery + ` ORDER BY job_id DESC LIMIT $${paramIndex}`;
                    params.push(limitValue);
                }
                result = await client.query(query, params);
            } else {
                throw error;
            }
        }

        // Map results (status is already calculated in the view, including scanned_codes via SQL function)
        // Also get runlist_id for each job by joining with production_planner_paths
        const jobsWithRunlist = await Promise.all(result.rows.map(async (row) => {
            // Get runlist_id for this job by finding it through file_ids
            // We need to find any file_id that matches this job_id and get its runlist
            let runlistId: string | null = null;
            
            try {
                // Try to get runlist_id from any version_tag of this job
                const versionTags = row.version_tags || [];
                if (versionTags.length > 0) {
                    // Use first version_tag to find runlist
                    const versionTag = versionTags[0];
                    const pattern = `FILE_${versionTag}_Labex_${row.job_id}_%`;
                    
                    const runlistResult = await client.query(
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
                // If query fails, just leave runlistId as null
                console.warn(`Could not get runlist_id for job ${row.job_id}:`, err);
            }
            
            // Status is already calculated in the view via get_status_from_operations() 
            // which checks both job_operations and scanned_codes via has_scanned_operation()
            return {
                job_id: row.job_id,
                total_versions: parseInt(row.total_versions) || 0,
                completed_versions: parseInt(row.completed_versions) || 0,
                version_tags: row.version_tags || [],
                status: row.status || 'print_ready', // Status already includes scanned_codes via SQL function
                latest_completed_operation_id: row.latest_completed_operation_id || null,
                created_at: row.earliest_completed_at || null,
                updated_at: row.latest_completed_at || null,
                runlist_id: runlistId,
            };
        }));
        
        return jobsWithRunlist;
    } catch (error: any) {
        // If view doesn't exist, fallback to direct query
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
    const client = await pool.connect();
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

        if (filters?.dateFrom) {
            query += ` AND jo.completed_at >= $${paramIndex}`;
            params.push(filters.dateFrom);
            paramIndex++;
        }

        if (filters?.dateTo) {
            query += ` AND jo.completed_at <= $${paramIndex}`;
            params.push(filters.dateTo);
            paramIndex++;
        }

        query += ` GROUP BY jo.job_id`;

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
                        BOOL_OR(LOWER(operation_id) = 'op004' AND completed_at IS NOT NULL) as has_op004
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
                    // 2. If both op002 and op003 are scanned, it's slitter
                    else if (ops.has_op002 && ops.has_op003) {
                        status = 'slitter';
                    }
                    // 3. If op003 is scanned alone, it's slitter
                    else if (ops.has_op003) {
                        status = 'slitter';
                    }
                    // 4. If only op002 is scanned (without op003), it's digital_cut
                    else if (ops.has_op002) {
                        status = 'digital_cut';
                    }
                    // 5. If op001 is scanned, it's printed
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
                    
                    const runlistResult = await client.query(
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
        
        return jobsWithRunlist;
    } finally {
        client.release();
    }
}

