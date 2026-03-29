#!/usr/bin/env node
/**
 * Diagnostic script: check runlist distribution in the app database (DATABASE_URL / APP_DB_*).
 * Run with: npx tsx server/db/check-runlists.ts
 */
import { appPool } from './app-connection.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
    const client = await appPool.connect();
    try {
        console.log('=== Runlist diagnostics (primary app DB) ===\n');

        // 1. How many runlists exist?
        const r1 = await client.query(
            `SELECT COUNT(DISTINCT runlist_id) as count FROM production_planner_paths WHERE runlist_id IS NOT NULL`
        );
        console.log('1. Total distinct runlists:', r1.rows[0].count);

        // 2. How many impositions per runlist?
        const r2 = await client.query(`
            SELECT runlist_id, COUNT(DISTINCT imposition_id) as imposition_count
            FROM production_planner_paths
            WHERE runlist_id IS NOT NULL
            GROUP BY runlist_id
            ORDER BY imposition_count DESC
            LIMIT 20
        `);
        console.log('\n2. Top 20 runlists by imposition count:');
        console.table(r2.rows);

        // 3. File count per runlist (how many file_ids = how many jobs can match)
        const r3 = await client.query(`
            SELECT ppp.runlist_id, COUNT(DISTINCT ifm.file_id) as file_count
            FROM imposition_file_mapping ifm
            INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
            WHERE ppp.runlist_id IS NOT NULL
            GROUP BY ppp.runlist_id
            ORDER BY file_count DESC
            LIMIT 20
        `);
        console.log('\n3. Top 20 runlists by file count (potential jobs per runlist):');
        console.table(r3.rows);

        // 4. Sample file_ids from the largest runlist
        const topRunlist = r3.rows[0]?.runlist_id;
        if (topRunlist) {
            const r4 = await client.query(
                `SELECT ifm.file_id
                 FROM imposition_file_mapping ifm
                 INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
                 WHERE ppp.runlist_id = $1
                 ORDER BY ifm.file_id
                 LIMIT 10`,
                [topRunlist]
            );
            console.log(`\n4. Sample file_ids from runlist "${topRunlist}" (first 10):`);
            r4.rows.forEach((r, i) => console.log(`   ${i + 1}. ${r.file_id}`));
        }

        // 5. Check if production planner runlist IDs (773114, 946670, 141501, etc.) exist in production_planner_paths
        const idsToCheck = ['773114', '946670', '141501', '146077'];
        console.log('\n5. Do these runlist IDs exist in production_planner_paths?');
        for (const id of idsToCheck) {
            const r5 = await client.query(
                `SELECT runlist_id, COUNT(DISTINCT imposition_id) as cnt
                 FROM production_planner_paths WHERE runlist_id = $1 GROUP BY runlist_id`,
                [id]
            );
            console.log(`   ${id}: ${r5.rows.length > 0 ? `YES (${r5.rows[0].cnt} impositions)` : 'NO'}`);
        }

        // 6. Table/database info
        const r6 = await client.query(
            `SELECT table_schema, table_name FROM information_schema.tables
             WHERE table_name IN ('production_planner_paths', 'imposition_file_mapping')
             ORDER BY table_schema, table_name`
        );
        console.log('\n6. Tables used for runlist resolution:');
        r6.rows.forEach((r) => console.log(`   ${r.table_schema}.${r.table_name}`));
    } finally {
        client.release();
        await appPool.end();
    }
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
