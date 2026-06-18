/**
 * Samples HP Printbeat realtime rows from jobmanager DB, resolves current_job → job_ids,
 * then runs enrichProductionStatusWithSourceTables once (same logic as GET /api/production-status).
 *
 * Usage:
 *   npx tsx scripts/test-printbeat-parse.ts
 *   PRINTBEAT_MIN_ID=316298 PRINTBEAT_USE_ID_MARKER=false npx tsx scripts/test-printbeat-parse.ts
 *
 * If PRINTBEAT_USE_ID_MARKER=true, enrich advances processing_markers.printbeat_enrich (each run consumes one sequential row).
 */
import dotenv from "dotenv";

dotenv.config();

import {
    getPrintbeatMaxAgeMinutes,
    getPrintbeatMinId,
    getPrintbeatRealtimeTableSqlIdentifier,
    isPrintbeatIdMarkerSequentialEnabled,
} from "../server/db/database-config.js";
import { getPrintOsPool } from "../server/db/print-os-pool.js";
import {
    enrichProductionStatusWithSourceTables,
    getCachedIndigoMachineId,
    resolveJobIdsFromPressLine,
} from "../server/db/status-updates.js";

import { appPool } from "../server/db/app-connection.js";

async function readPrintbeatMarker(): Promise<number> {
    try {
        const r = await appPool.query(
            `SELECT COALESCE(last_processed_id, 0)::bigint AS m FROM processing_markers WHERE marker_type = 'printbeat_enrich'`
        );
        if (r.rows.length === 0) return 0;
        return Number(r.rows[0].m) || 0;
    } catch {
        return 0;
    }
}

async function main() {
    const table = getPrintbeatRealtimeTableSqlIdentifier();
    const minIdSet = getPrintbeatMinId();
    const sequential = isPrintbeatIdMarkerSequentialEnabled();

    console.log("[test-printbeat] Config");
    console.log("  JOBMANAGER / Print OS pool:", process.env.JOBMANAGER_DATABASE_URL ? "JOBMANAGER_DATABASE_URL" : "app DB pool");
    console.log("  table:", table);
    console.log("  PRINTBEAT_MIN_ID:", minIdSet || "(none)");
    console.log("  PRINTBEAT_USE_ID_MARKER (sequential):", sequential);
    console.log("  PRINTBEAT_MAX_AGE_MINUTES:", getPrintbeatMaxAgeMinutes());

    const markerBefore = await readPrintbeatMarker();
    if (sequential) {
        console.log("  printbeat_enrich marker before:", markerBefore);
    }

    const po = await getPrintOsPool();
    const jc = await po.connect();
    try {
        const clauses = [
            `current_job IS NOT NULL`,
            `TRIM(current_job) <> ''`,
            `(press_name ILIKE '%Indigo%' OR press_name ILIKE '%6900%')`,
        ];
        const params: unknown[] = [];
        let p = 1;
        if (minIdSet > 0) {
            clauses.unshift(`id >= $${p}::bigint`);
            params.push(BigInt(minIdSet));
            p++;
        }
        const where = clauses.join("\n              AND ");

        const sampleAsc = await jc.query(
            `
            SELECT id, current_job, updated_at::text AS updated_at, press_state
            FROM ${table}
            WHERE ${where}
            ORDER BY id ASC NULLS LAST
            LIMIT 5
            `,
            params.length ? params : undefined
        );
        console.log("\n[sample] Next 5 rows by id ASC" + (minIdSet ? ` (id >= ${minIdSet})` : "") + ":");
        for (const row of sampleAsc.rows) {
            const line = String(row.current_job ?? "");
            const jobs = await resolveJobIdsFromPressLine(line);
            console.log(`  id=${row.id} state=${row.press_state} ts=${row.updated_at}`);
            console.log(`    current_job (${line.length}c): ${line.slice(0, 120)}${line.length > 120 ? "…" : ""}`);
            console.log(`    → job_ids: ${jobs.length ? jobs.join(", ") : "(none — check imposition / Labex_* pattern)"}`);
        }

        const labexLike = await jc.query(`
            SELECT id, current_job, updated_at::text AS updated_at, press_state
            FROM ${table}
            WHERE current_job IS NOT NULL
              AND TRIM(current_job) <> ''
              AND (press_name ILIKE '%Indigo%' OR press_name ILIKE '%6900%')
              AND current_job LIKE 'Labex_%'
            ORDER BY id DESC NULLS LAST
            LIMIT 5
        `);
        if (labexLike.rows.length > 0) {
            console.log("\n[sample] Rows with current_job like Labex_% (typically parse to job_ids):");
            for (const row of labexLike.rows) {
                const line = String(row.current_job ?? "");
                const jobs = await resolveJobIdsFromPressLine(line);
                console.log(`  id=${row.id} state=${row.press_state}`);
                console.log(`    → job_ids: ${jobs.length ? jobs.join(", ") : "(none)"}`);
                console.log(`    text: ${line.slice(0, 100)}${line.length > 100 ? "…" : ""}`);
            }
        } else {
            console.log("\n[sample] No Labex_* current_job strings in recent Printbeat Indigo rows.");
        }

        const sampleDesc = await jc.query(`
            SELECT id, current_job, updated_at::text AS updated_at, press_state
            FROM ${table}
            WHERE current_job IS NOT NULL
              AND TRIM(current_job) <> ''
              AND (press_name ILIKE '%Indigo%' OR press_name ILIKE '%6900%')
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 5
        `);

        console.log("\n[sample] 5 most recently updated rows (parse check):");
        for (const row of sampleDesc.rows) {
            const line = String(row.current_job ?? "");
            const jobs = await resolveJobIdsFromPressLine(line);
            console.log(`  id=${row.id}`);
            console.log(`    → job_ids: ${jobs.length ? jobs.join(", ") : "(none)"}`);
        }
    } finally {
        jc.release();
    }

    const indigoId = await getCachedIndigoMachineId();
    if (!indigoId) {
        console.error("\n[test-printbeat] No Prisma scheduler.Machine hp_indigo_6900 — cannot run enrich bucket test.");
        process.exit(2);
        return;
    }

    console.log("\n[enrich] Indigo machine id:", indigoId);
    if (sequential) {
        console.warn(
            "  Sequential mode ON — enrich will advance processing_markers.printbeat_enrich if a row was consumed.\n"
        );
    }

    const grouped = {
        [indigoId]: {
            machine_id: indigoId,
            completed: [] as unknown[],
            processing: [] as unknown[],
        },
    };
    await enrichProductionStatusWithSourceTables(grouped as never);

    const g = grouped[indigoId];
    console.log("[enrich] processing (currently on press enrich):");
    console.log(JSON.stringify(g.processing, null, 2));
    console.log("[enrich] Indigo completed slice (first 6):");
    console.log(JSON.stringify(g.completed.slice(0, 6), null, 2));

    const markerAfter = await readPrintbeatMarker();
    if (sequential) {
        console.log("  printbeat_enrich marker after:", markerAfter);
        if (markerAfter !== markerBefore) {
            console.log("  ↑ marker advanced (next sequential id will be consumed on next run).");
        }
    }

    console.log("\n[test-printbeat] Done.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
