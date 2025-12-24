import { processScannedCodes, processPrintOSRecords } from './status-updates.js';
import { jobmanagerPool } from './jobmanager-connection.js';
import pool from './connection.js';
import pg from 'pg';
import dotenv from 'dotenv';

const { Pool } = pg;

// Create logs pool (same as in status-updates.ts)
const logsPool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: 'logs',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
});

dotenv.config();

/**
 * Backfill all operation durations by processing all historical scans and Print OS records
 */
async function backfillAllDurations() {
    console.log('=== Starting Backfill of All Operation Durations ===\n');
    
    // Step 1: Reset processing markers to start from the beginning
    console.log('Step 1: Resetting processing markers...');
    const jobmanagerClient = await jobmanagerPool.connect();
    try {
        // Reset scanned_codes marker
        await jobmanagerClient.query(`
            INSERT INTO processing_markers (marker_type, last_processed_id, last_processed_at, updated_at)
            VALUES ('scanned_codes', 0, NOW(), NOW())
            ON CONFLICT (marker_type) DO UPDATE SET
                last_processed_id = 0,
                last_processed_at = NOW(),
                updated_at = NOW();
        `);
        console.log('  ✓ Reset scanned_codes marker to 0');
        
        // Reset print_os marker
        await jobmanagerClient.query(`
            INSERT INTO processing_markers (marker_type, last_processed_id, last_processed_at, updated_at)
            VALUES ('print_os', 0, NOW(), NOW())
            ON CONFLICT (marker_type) DO UPDATE SET
                last_processed_id = 0,
                last_processed_at = NOW(),
                updated_at = NOW();
        `);
        console.log('  ✓ Reset print_os marker to 0\n');
    } finally {
        jobmanagerClient.release();
    }
    
    // Step 2: Process all Print OS records (for op001 durations)
    console.log('Step 2: Processing all Print OS records...');
    let printOSProcessed = 0;
    let printOSJobsUpdated = 0;
    let printOSLastMarker = 0;
    let printOSErrors: string[] = [];
    
    let hasMorePrintOS = true;
    while (hasMorePrintOS) {
        const result = await processPrintOSRecords();
        printOSProcessed += result.processed;
        printOSJobsUpdated += result.jobsUpdated;
        printOSLastMarker = Math.max(printOSLastMarker, result.lastMarker);
        printOSErrors.push(...result.errors);
        
        console.log(`  Processed batch: ${result.processed} records, ${result.jobsUpdated} jobs updated`);
        
        // If no records were processed, we're done
        if (result.processed === 0) {
            hasMorePrintOS = false;
        }
    }
    
    console.log(`\n  ✓ Print OS processing complete:`);
    console.log(`    - Total records processed: ${printOSProcessed}`);
    console.log(`    - Total jobs updated: ${printOSJobsUpdated}`);
    console.log(`    - Last marker: ${printOSLastMarker}`);
    console.log(`    - Errors: ${printOSErrors.length}\n`);
    
    // Step 3: Process all scanned codes (for op002, op003, op004, etc. durations)
    console.log('Step 3: Processing all scanned codes...');
    let scanProcessed = 0;
    let scanJobsUpdated = 0;
    let scanLastScanId = 0;
    let scanErrors: string[] = [];
    
    let hasMoreScans = true;
    while (hasMoreScans) {
        const result = await processScannedCodes();
        scanProcessed += result.processed;
        scanJobsUpdated += result.jobsUpdated;
        scanLastScanId = Math.max(scanLastScanId, result.lastScanId);
        scanErrors.push(...result.errors);
        
        console.log(`  Processed batch: ${result.processed} scans, ${result.jobsUpdated} jobs updated`);
        
        // If no scans were processed, we're done
        if (result.processed === 0) {
            hasMoreScans = false;
        }
    }
    
    console.log(`\n  ✓ Scanned codes processing complete:`);
    console.log(`    - Total scans processed: ${scanProcessed}`);
    console.log(`    - Total jobs updated: ${scanJobsUpdated}`);
    console.log(`    - Last scan_id: ${scanLastScanId}`);
    console.log(`    - Errors: ${scanErrors.length}\n`);
    
    // Step 4: Backfill durations for operations that might have been missed
    console.log('Step 4: Backfilling durations for completed operations...');
    const logsClient = await logsPool.connect();
    try {
        // Get all completed operations that don't have durations yet
        const operations = await logsClient.query(`
            SELECT DISTINCT
                jo.job_id,
                jo.version_tag,
                jo.operation_id,
                jo.completed_at,
                jo.completed_by
            FROM job_operations jo
            LEFT JOIN job_operation_duration jod 
                ON jo.job_id = jod.job_id 
                AND jo.version_tag = jod.version_tag 
                AND jo.operation_id = jod.operation_id
            WHERE jo.completed_at IS NOT NULL
            AND jo.status = 'completed'
            AND jod.job_operation_duration_id IS NULL
            ORDER BY jo.completed_at DESC;
        `);
        
        console.log(`  Found ${operations.rows.length} operations without durations\n`);
        
        let backfillSuccess = 0;
        let backfillSkipped = 0;
        let backfillErrors = 0;
        
        for (const op of operations.rows) {
            try {
                // Skip op001 - those should have been handled by Print OS processing
                if (op.operation_id === 'op001') {
                    // For op001, try to get duration from Print OS if completed_by is print_os
                    if (op.completed_by === 'print_os') {
                        // Check if we can find Print OS record
                        const printOSClient = await jobmanagerPool.connect();
                        try {
                            const printOSResult = await printOSClient.query(`
                                SELECT payload, job_complete_time
                                FROM "print OS"
                                WHERE id = (
                                    SELECT source_id::bigint
                                    FROM job_operations
                                    WHERE job_id = $1
                                    AND version_tag = $2
                                    AND operation_id = $3
                                    AND completed_by = 'print_os'
                                    LIMIT 1
                                )
                                LIMIT 1;
                            `, [op.job_id, op.version_tag, op.operation_id]);
                            
                            if (printOSResult.rows.length > 0 && printOSResult.rows[0].payload) {
                                const payload = typeof printOSResult.rows[0].payload === 'string' 
                                    ? JSON.parse(printOSResult.rows[0].payload) 
                                    : printOSResult.rows[0].payload;
                                
                                const durationSeconds = payload.jobElapseTime ? parseInt(payload.jobElapseTime) : null;
                                const completedAt = printOSResult.rows[0].job_complete_time || op.completed_at;
                                const startedAt = durationSeconds && completedAt 
                                    ? new Date(new Date(completedAt).getTime() - (durationSeconds * 1000))
                                    : null;
                                
                                if (durationSeconds !== null) {
                                    await logsClient.query(`
                                        INSERT INTO job_operation_duration (
                                            job_id, version_tag, operation_id, machine_id,
                                            operation_duration_seconds, operation_started_at, operation_completed_at, updated_at
                                        )
                                        VALUES ($1, $2, $3, 'HP_INDIGO_6900', $4, $5, $6, NOW())
                                        ON CONFLICT (job_id, version_tag, operation_id) DO UPDATE SET
                                            machine_id = 'HP_INDIGO_6900',
                                            operation_duration_seconds = EXCLUDED.operation_duration_seconds,
                                            operation_started_at = COALESCE(EXCLUDED.operation_started_at, job_operation_duration.operation_started_at),
                                            operation_completed_at = COALESCE(EXCLUDED.operation_completed_at, job_operation_duration.operation_completed_at),
                                            updated_at = NOW();
                                    `, [op.job_id, op.version_tag, op.operation_id, durationSeconds, startedAt, completedAt]);
                                    
                                    backfillSuccess++;
                                    console.log(`  ✓ ${op.job_id}_${op.version_tag}_${op.operation_id}: ${durationSeconds}s from Print OS`);
                                } else {
                                    backfillSkipped++;
                                }
                            } else {
                                backfillSkipped++;
                            }
                        } finally {
                            printOSClient.release();
                        }
                    } else {
                        backfillSkipped++;
                    }
                    continue;
                }
                
                // For non-op001 operations, calculate from scans
                if (op.completed_by === 'scanner') {
                    await logsClient.query(`
                        SELECT update_operation_duration($1, $2, $3);
                    `, [op.job_id, op.version_tag, op.operation_id]);
                    
                    // Check if duration was calculated
                    const check = await logsClient.query(`
                        SELECT operation_duration_seconds
                        FROM job_operation_duration
                        WHERE job_id = $1 AND version_tag = $2 AND operation_id = $3;
                    `, [op.job_id, op.version_tag, op.operation_id]);
                    
                    if (check.rows.length > 0 && check.rows[0].operation_duration_seconds) {
                        backfillSuccess++;
                        console.log(`  ✓ ${op.job_id}_${op.version_tag}_${op.operation_id}: ${check.rows[0].operation_duration_seconds}s from scans`);
                    } else {
                        backfillSkipped++;
                        console.log(`  ⚠ ${op.job_id}_${op.version_tag}_${op.operation_id}: No duration calculated (only one batch?)`);
                    }
                } else {
                    backfillSkipped++;
                }
            } catch (error: any) {
                backfillErrors++;
                console.log(`  ✗ ${op.job_id}_${op.version_tag}_${op.operation_id}: ${error.message}`);
            }
        }
        
        console.log(`\n  ✓ Backfill complete:`);
        console.log(`    - Successfully processed: ${backfillSuccess}`);
        console.log(`    - Skipped (no duration available): ${backfillSkipped}`);
        console.log(`    - Errors: ${backfillErrors}\n`);
        
    } finally {
        logsClient.release();
    }
    
    // Step 5: Summary statistics
    console.log('Step 5: Final statistics...');
    const statsClient = await logsPool.connect();
    try {
        const stats = await statsClient.query(`
            SELECT 
                COUNT(*) as total_records,
                COUNT(operation_duration_seconds) as records_with_duration,
                COUNT(CASE WHEN operation_id = 'op001' THEN 1 END) as op001_count,
                COUNT(CASE WHEN operation_id = 'op001' AND operation_duration_seconds IS NOT NULL THEN 1 END) as op001_with_duration,
                AVG(operation_duration_seconds) as avg_duration_seconds,
                MIN(operation_duration_seconds) as min_duration_seconds,
                MAX(operation_duration_seconds) as max_duration_seconds
            FROM job_operation_duration;
        `);
        
        const stat = stats.rows[0];
        console.log(`\n  === Final Statistics ===`);
        console.log(`  Total duration records: ${stat.total_records}`);
        console.log(`  Records with duration: ${stat.records_with_duration}`);
        console.log(`  op001 records: ${stat.op001_count}`);
        console.log(`  op001 with duration: ${stat.op001_with_duration}`);
        console.log(`  Average duration: ${Math.round(stat.avg_duration_seconds || 0)}s (${Math.round((stat.avg_duration_seconds || 0) / 60)} minutes)`);
        console.log(`  Min duration: ${stat.min_duration_seconds || 'N/A'}s`);
        console.log(`  Max duration: ${stat.max_duration_seconds || 'N/A'}s`);
        
    } finally {
        statsClient.release();
    }
    
    console.log('\n=== Backfill Complete ===\n');
}

backfillAllDurations().catch((error) => {
    console.error('Error during backfill:', error);
    process.exit(1);
}).finally(async () => {
    await jobmanagerPool.end();
    await logsPool.end();
});

