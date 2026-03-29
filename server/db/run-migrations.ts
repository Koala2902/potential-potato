import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logsPool from './connection.js';
import { appPool } from './app-connection.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration(filePath: string, database: 'logs' | 'app'): Promise<void> {
    const sql = fs.readFileSync(filePath, 'utf-8');
    const client =
        database === 'logs' ? await logsPool.connect() : await appPool.connect();

    try {
        console.log(`\nRunning ${path.basename(filePath)} on ${database} database...`);

        await client.query(sql);

        console.log(`✓ ${path.basename(filePath)} completed successfully`);
    } catch (error: any) {
        const errorMsg = error.message || String(error);

        if (
            errorMsg.includes('already exists') ||
            (errorMsg.includes('does not exist') && errorMsg.includes('DROP'))
        ) {
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
        const migration001 = path.join(migrationsDir, '001-add-tracking-columns.sql');
        const sql001 = fs.readFileSync(migration001, 'utf-8');

        const sections = sql001.split(
            '-- ============================================================================\n-- JOBMANAGER DATABASE'
        );
        const appSection = sections[0]
            .replace(
                '-- ============================================================================\n-- LOGS DATABASE\n-- ============================================================================',
                ''
            )
            .trim();
        const secondSection = sections[1]
            ? sections[1]
                  .replace(
                      '-- ============================================================================\n-- JOBMANAGER DATABASE\n-- ============================================================================',
                      ''
                  )
                  .trim()
            : '';

        const appClient = await appPool.connect();
        try {
            console.log('\nRunning 001-add-tracking-columns.sql (app DB, section 1)...');
            await appClient.query(appSection);
            console.log('✓ 001 section 1 completed');
            if (secondSection) {
                console.log('\nRunning 001-add-tracking-columns.sql (app DB, section 2)...');
                await appClient.query(secondSection);
                console.log('✓ 001 section 2 completed');
            }
        } catch (error: any) {
            const errorMsg = error.message || String(error);
            if (
                !errorMsg.includes('already exists') &&
                !(errorMsg.includes('does not exist') && errorMsg.includes('DROP'))
            ) {
                console.error('✗ Failed:', errorMsg);
                throw error;
            } else {
                console.log(`⚠ ${errorMsg.split('\n')[0]}`);
            }
        } finally {
            appClient.release();
        }

        await runMigration(path.join(migrationsDir, '002-create-job-status-view.sql'), 'app');
        await runMigration(path.join(migrationsDir, '006-migrate-scanned-codes-to-logs.sql'), 'logs');
        await runMigration(path.join(migrationsDir, '003-update-job-status-view-operation-based.sql'), 'app');
        await runMigration(path.join(migrationsDir, '007-update-view-latest-operation.sql'), 'app');
        await runMigration(path.join(migrationsDir, '009-fix-status-function-check-scanned-codes.sql'), 'app');
        await runMigration(path.join(migrationsDir, '010-fix-timestamp-timezone.sql'), 'app');
        await runMigration(path.join(migrationsDir, '011-update-view-localized-time.sql'), 'app');
        await runMigration(path.join(migrationsDir, '012-fix-view-operation-priority.sql'), 'app');
        await runMigration(path.join(migrationsDir, '013-fix-view-compare-local-time.sql'), 'app');
        await runMigration(path.join(migrationsDir, '014-remove-operation-sequence-priority.sql'), 'app');
        await runMigration(path.join(migrationsDir, '015-add-operation-duration-tracking.sql'), 'logs');
        await runMigration(path.join(migrationsDir, '016-job-status-runlist-view.sql'), 'app');
        await runMigration(path.join(migrationsDir, '018-job-status-view-performance.sql'), 'app');
        await runMigration(path.join(migrationsDir, '019-drop-redundant-job-ops-index.sql'), 'app');
        await runMigration(path.join(migrationsDir, '020-order-aggregate-printing-runlist-view.sql'), 'app');
        await runMigration(path.join(migrationsDir, '021-machines-table-app.sql'), 'app');
        await runMigration(path.join(migrationsDir, '022-machines-schema-match-jobmanager.sql'), 'app');
        await runMigration(path.join(migrationsDir, '023-operations-table-app.sql'), 'app');
        await runMigration(path.join(migrationsDir, '024-machine-modes.sql'), 'app');
        await runMigration(
            path.join(migrationsDir, '025-migrate-public-machines-operations-to-scheduler.sql'),
            'app'
        );

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
