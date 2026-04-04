import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logsPool from './connection.js';
import { appPool } from './app-connection.js';
import { getLogsDatabaseUrl, getAppDatabaseUrl } from './database-config.js';
import dotenv from 'dotenv';

dotenv.config();

/** job_operations + job_status_* views: logs DB when dual-DB; else same as app (single DATABASE_URL). */
function pipelineMigrationTarget(): 'logs' | 'app' {
    return getLogsDatabaseUrl() !== getAppDatabaseUrl() ? 'logs' : 'app';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isBenignMigrationError(errorMsg: string): boolean {
    return (
        errorMsg.includes('already exists') ||
        (errorMsg.includes('does not exist') && errorMsg.includes('DROP'))
    );
}

async function runSqlOnDatabase(
    sql: string,
    label: string,
    database: 'logs' | 'app'
): Promise<void> {
    const client =
        database === 'logs' ? await logsPool.connect() : await appPool.connect();

    try {
        console.log(`\nRunning ${label} on ${database} database...`);
        await client.query(sql);
        console.log(`✓ ${label} completed`);
    } catch (error: any) {
        const errorMsg = error.message || String(error);
        if (isBenignMigrationError(errorMsg)) {
            console.log(`⚠ ${label}: ${errorMsg.split('\n')[0]}`);
        } else {
            console.error(`✗ ${label} failed:`, errorMsg);
            throw error;
        }
    } finally {
        client.release();
    }
}

async function runMigration(filePath: string, database: 'logs' | 'app'): Promise<void> {
    const sql = fs.readFileSync(filePath, 'utf-8');
    await runSqlOnDatabase(sql, path.basename(filePath), database);
}

async function main() {
    const migrationsDir = path.join(__dirname, 'migrations');

    console.log('Starting database migrations...\n');

    try {
        const migration001 = path.join(migrationsDir, '001-add-tracking-columns.sql');
        const sql001 = fs.readFileSync(migration001, 'utf-8');

        // Split 001: LOGS block (job_operations, …) → logs DB; JOBMANAGER block (jobs, processing_markers) → app DB.
        const sections = sql001.split(
            '-- ============================================================================\n-- JOBMANAGER DATABASE'
        );
        const logsSection = sections[0]
            .replace(
                '-- ============================================================================\n-- LOGS DATABASE\n-- ============================================================================',
                ''
            )
            .trim();
        const appSection001 = sections[1]
            ? sections[1]
                  .replace(
                      '-- ============================================================================\n-- JOBMANAGER DATABASE\n-- ============================================================================',
                      ''
                  )
                  .trim()
            : '';

        await runSqlOnDatabase(
            logsSection,
            '001-add-tracking-columns.sql (logs: job_operations / imposition_operations)',
            'logs'
        );
        if (appSection001) {
            await runSqlOnDatabase(
                appSection001,
                '001-add-tracking-columns.sql (app: jobs / processing_markers)',
                'app'
            );
        }

        const pipe = pipelineMigrationTarget();
        // 002–020: job_operations + views. Dual-DB: pipeline tables/views live on LOGS_DATABASE_URL.
        await runMigration(path.join(migrationsDir, '002-create-job-status-view.sql'), pipe);
        await runMigration(path.join(migrationsDir, '006-migrate-scanned-codes-to-logs.sql'), 'logs');
        await runMigration(path.join(migrationsDir, '003-update-job-status-view-operation-based.sql'), pipe);
        await runMigration(path.join(migrationsDir, '007-update-view-latest-operation.sql'), pipe);
        await runMigration(path.join(migrationsDir, '009-fix-status-function-check-scanned-codes.sql'), pipe);
        await runMigration(path.join(migrationsDir, '010-fix-timestamp-timezone.sql'), pipe);
        await runMigration(path.join(migrationsDir, '011-update-view-localized-time.sql'), pipe);
        await runMigration(path.join(migrationsDir, '012-fix-view-operation-priority.sql'), pipe);
        await runMigration(path.join(migrationsDir, '013-fix-view-compare-local-time.sql'), pipe);
        await runMigration(path.join(migrationsDir, '014-remove-operation-sequence-priority.sql'), pipe);
        await runMigration(path.join(migrationsDir, '015-add-operation-duration-tracking.sql'), 'logs');
        await runMigration(path.join(migrationsDir, '016-job-status-runlist-view.sql'), pipe);
        await runMigration(path.join(migrationsDir, '018-job-status-view-performance.sql'), pipe);
        await runMigration(path.join(migrationsDir, '019-drop-redundant-job-ops-index.sql'), pipe);
        await runMigration(path.join(migrationsDir, '020-order-aggregate-printing-runlist-view.sql'), pipe);
        await runMigration(path.join(migrationsDir, '024-machine-modes.sql'), 'app');
        await runMigration(path.join(migrationsDir, '026-scheduler-job-file-name.sql'), 'app');
        await runMigration(path.join(migrationsDir, '027-scheduler-job-machine-schedule.sql'), 'app');

        console.log('\n=== Migration Summary ===');
        console.log('✓ All migrations completed successfully!');
        console.log('\nRun "npm run check-schema" to verify all schema elements are in place.');
    } catch (error: any) {
        console.error('\n✗ Migration failed:', error.message);
        process.exit(1);
    } finally {
        await logsPool.end();
        await appPool.end();
    }
}

main();
