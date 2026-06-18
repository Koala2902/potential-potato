/**
 * Advance processing_markers to the current head of scanned_codes / print OS
 * without re-running job updates. Use after a mistaken backfill or dev replay.
 *
 *   npm run db:catch-up-markers
 */
import dotenv from 'dotenv';

import { appPool } from '../server/db/app-connection.js';
import logsPool from '../server/db/connection.js';
import { printOsCursorUsesRowId } from '../server/db/database-config.js';
import { getPrintOsPool } from '../server/db/print-os-pool.js';
import { isUndefinedTableError } from '../server/db/pg-errors.js';

dotenv.config();

async function upsertMarker(markerType: string, lastId: number): Promise<void> {
    const client = await appPool.connect();
    try {
        await client.query(
            `INSERT INTO processing_markers (marker_type, last_processed_id, last_processed_at, updated_at)
             VALUES ($1, $2, NOW(), NOW())
             ON CONFLICT (marker_type) DO UPDATE SET
                 last_processed_id = EXCLUDED.last_processed_id,
                 last_processed_at = NOW(),
                 updated_at = NOW()`,
            [markerType, lastId]
        );
    } finally {
        client.release();
    }
}

async function readMarker(markerType: string): Promise<number> {
    const client = await appPool.connect();
    try {
        const r = await client.query(
            'SELECT last_processed_id FROM processing_markers WHERE marker_type = $1',
            [markerType]
        );
        if (r.rows.length === 0) return 0;
        return parseInt(String(r.rows[0].last_processed_id), 10) || 0;
    } finally {
        client.release();
    }
}

async function catchUpScannedCodes(): Promise<void> {
    const client = await logsPool.connect();
    try {
        const r = await client.query(
            `SELECT COALESCE(MAX(scan_id), 0)::bigint AS max_id FROM scanned_codes`
        );
        const maxId = parseInt(String(r.rows[0]?.max_id ?? 0), 10) || 0;
        const before = await readMarker('scanned_codes');
        await upsertMarker('scanned_codes', maxId);
        console.log(`scanned_codes marker: ${before} → ${maxId} (skip replay)`);
    } catch (e) {
        if (isUndefinedTableError(e)) {
            console.log('scanned_codes table missing on logs DB — skipped');
            return;
        }
        throw e;
    } finally {
        client.release();
    }
}

async function catchUpPrintOs(): Promise<void> {
    const useRowId = printOsCursorUsesRowId();
    const column = useRowId ? 'id' : 'marker';
    const client = await getPrintOsPool().connect();
    try {
        const r = await client.query(
            `SELECT COALESCE(MAX(${column}), 0)::bigint AS max_cursor FROM "print OS"`
        );
        const maxCursor = parseInt(String(r.rows[0]?.max_cursor ?? 0), 10) || 0;
        const before = await readMarker('print_os');
        await upsertMarker('print_os', maxCursor);
        console.log(`print_os marker (${column}): ${before} → ${maxCursor} (skip replay)`);
    } catch (e) {
        if (isUndefinedTableError(e)) {
            console.log('"print OS" table missing — skipped');
            return;
        }
        throw e;
    } finally {
        client.release();
    }
}

async function main() {
    console.log('Catching up processing_markers (no scan replay)…\n');
    await catchUpScannedCodes();
    await catchUpPrintOs();
    console.log('\nDone. Restart dev — only new scans after this marker will be processed.');
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(async () => {
        await appPool.end();
        await logsPool.end();
        try {
            await getPrintOsPool().end();
        } catch {
            /* pool may not have been opened */
        }
    });
