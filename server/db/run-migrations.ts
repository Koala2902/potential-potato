import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './connection.js';
import { jobmanagerPool } from './jobmanager-connection.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration(filePath: string, database: 'logs' | 'jobmanager'): Promise<void> {
    const sql = fs.readFileSync(filePath, 'utf-8');
    const client = database === 'logs' ? await pool.connect() : await jobmanagerPool.connect();
    
    try {
        console.log(`\nRunning ${path.basename(filePath)} on ${database} database...`);
        
        // Split SQL by semicolons, but be careful with functions and other multi-statement blocks
        // For now, just execute the entire SQL file
        await client.query(sql);
        
        console.log(`✓ ${path.basename(filePath)} completed successfully`);
    } catch (error: any) {
        // Some errors are expected (like "IF NOT EXISTS" clauses)
        const errorMsg = error.message || String(error);
        
        // Ignore "already exists" errors for IF NOT EXISTS clauses
        if (errorMsg.includes('already exists') || 
            errorMsg.includes('does not exist') && errorMsg.includes('DROP')) {
            console.log(`⚠ ${path.basename(filePath)}: ${errorMsg.split('\n')[0]}`);
        } else {
            console.error(`✗ ${path.basename(filePath)} failed:`, errorMsg);
            throw error;
        }
    } finally {
        client.release();
    }
}

async function main() {
    const migrationsDir = path.join(__dirname, 'migrations');
    
    console.log('Starting database migrations...\n');
    
    try {
        // Migration 001: Add tracking columns (runs on both databases)
        const migration001 = path.join(migrationsDir, '001-add-tracking-columns.sql');
        const sql001 = fs.readFileSync(migration001, 'utf-8');
        
        // Split migration 001 into logs and jobmanager parts
        const sections = sql001.split('-- ============================================================================\n-- JOBMANAGER DATABASE');
        const logsSection = sections[0].replace('-- ============================================================================\n-- LOGS DATABASE\n-- ============================================================================', '').trim();
        const jobmanagerSection = sections[1] ? sections[1].replace('-- ============================================================================\n-- JOBMANAGER DATABASE\n-- ============================================================================', '').trim() : '';
        
        // Run logs section
        const logsClient = await pool.connect();
        try {
            console.log('\nRunning 001-add-tracking-columns.sql (LOGS section)...');
            await logsClient.query(logsSection);
            console.log('✓ 001-add-tracking-columns.sql (LOGS section) completed');
        } catch (error: any) {
            const errorMsg = error.message || String(error);
            if (!errorMsg.includes('already exists') && 
                !(errorMsg.includes('does not exist') && errorMsg.includes('DROP'))) {
                console.error('✗ Failed:', errorMsg);
                throw error;
            } else {
                console.log(`⚠ ${errorMsg.split('\n')[0]}`);
            }
        } finally {
            logsClient.release();
        }
        
        // Run jobmanager section
        if (jobmanagerSection) {
            const jobmanagerClient = await jobmanagerPool.connect();
            try {
                console.log('\nRunning 001-add-tracking-columns.sql (JOBMANAGER section)...');
                await jobmanagerClient.query(jobmanagerSection);
                console.log('✓ 001-add-tracking-columns.sql (JOBMANAGER section) completed');
            } catch (error: any) {
                const errorMsg = error.message || String(error);
                if (!errorMsg.includes('already exists') && 
                    !(errorMsg.includes('does not exist') && errorMsg.includes('DROP'))) {
                    console.error('✗ Failed:', errorMsg);
                    throw error;
                } else {
                    console.log(`⚠ ${errorMsg.split('\n')[0]}`);
                }
            } finally {
                jobmanagerClient.release();
            }
        }
        
        // Migration 002: Create job_status_view (logs database only)
        await runMigration(path.join(migrationsDir, '002-create-job-status-view.sql'), 'logs');
        
        // Migration 006: Migrate scanned_codes to logs (logs database only)
        // Must run before 003 because 003 references scanned_codes table
        await runMigration(path.join(migrationsDir, '006-migrate-scanned-codes-to-logs.sql'), 'logs');
        
        // Migration 003: Update job_status_view operation-based (logs database only)
        // Runs after 006 because it references scanned_codes table
        await runMigration(path.join(migrationsDir, '003-update-job-status-view-operation-based.sql'), 'logs');
        
        // Migration 007: Update view latest operation (logs database only)
        await runMigration(path.join(migrationsDir, '007-update-view-latest-operation.sql'), 'logs');
        
        // Migration 015: Add operation duration tracking (logs database only)
        await runMigration(path.join(migrationsDir, '015-add-operation-duration-tracking.sql'), 'logs');
        
        console.log('\n=== Migration Summary ===');
        console.log('✓ All migrations completed successfully!');
        console.log('\nRun "npm run check-schema" to verify all schema elements are in place.');
        
    } catch (error: any) {
        console.error('\n✗ Migration failed:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
        await jobmanagerPool.end();
    }
}

main();

