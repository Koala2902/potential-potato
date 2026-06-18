/**
 * Backfill op004 (slitting): run update_operation_duration + set job_operations.completed_at
 * for existing rows. Does not INSERT job_operations (FK to jobs — may fail on Prisma-only DBs).
 *
 * Usage: npx tsx scripts/backfill-op004-completion.ts
 */
import dotenv from "dotenv";

dotenv.config();

import logsPool from "../server/db/connection.js";
import { decodeScanCodeText } from "../server/db/scan-code-text.js";
import { parseJobIdVersionFromScanCode } from "../server/db/scan-job-version.js";

async function main() {
  const client = await logsPool.connect();
  try {
    const scans = await client.query(`
      SELECT scan_id, code_text, scanned_at, operations
      FROM scanned_codes
      WHERE operations IS NOT NULL
        AND operations::text != '{}'
        AND (
          operations::text ILIKE '%op004%'
          OR (operations->'operations')::text ILIKE '%op004%'
        )
      ORDER BY scan_id
    `);

    const byPair = new Map<
      string,
      { jobId: string; versionTag: string; lastScan: Date; lastScanId: number }
    >();

    for (const row of scans.rows) {
      const stored = String(row.code_text ?? "");
      const { baseCodeText } = decodeScanCodeText(stored);
      const parsed = parseJobIdVersionFromScanCode(baseCodeText);
      if (!parsed) continue;
      const key = `${parsed.jobId}|${parsed.versionTag}`;
      const t = row.scanned_at ? new Date(row.scanned_at) : new Date();
      const scanId = Number(row.scan_id);
      const prev = byPair.get(key);
      if (!prev || t.getTime() > prev.lastScan.getTime()) {
        byPair.set(key, {
          jobId: parsed.jobId,
          versionTag: parsed.versionTag,
          lastScan: t,
          lastScanId: scanId,
        });
      }
    }

    console.log(`Found ${byPair.size} distinct job_id/version_tag with op004 scans.\n`);

    let durOk = 0;
    let durFail = 0;
    let joUpdated = 0;
    let joMissing = 0;

    for (const { jobId, versionTag, lastScan, lastScanId } of byPair.values()) {
      try {
        await client.query(`SELECT update_operation_duration($1, $2, 'op004')`, [jobId, versionTag]);
        durOk++;
      } catch (e: unknown) {
        durFail++;
        console.warn(
          `[duration] ${jobId} ${versionTag}:`,
          e instanceof Error ? e.message : e
        );
      }

      const upd = await client.query(
        `UPDATE job_operations
         SET completed_at = COALESCE(completed_at, $3::timestamptz),
             completed_by = COALESCE(completed_by, 'scanner'),
             source_id = COALESCE(source_id, $4::bigint),
             status = COALESCE(status, 'completed')
         WHERE job_id = $1 AND version_tag = $2 AND operation_id = 'op004'
         RETURNING job_operation_id`,
        [jobId, versionTag, lastScan.toISOString(), lastScanId]
      );

      if (upd.rowCount && upd.rowCount > 0) {
        joUpdated++;
      } else {
        joMissing++;
      }
    }

    console.log("\n=== Summary ===");
    console.log(`update_operation_duration(op004): ${durOk} ok, ${durFail} failed`);
    console.log(
      `job_operations: ${joUpdated} rows updated (no INSERT — ${joMissing} pairs had no op004 row yet)`
    );
  } finally {
    client.release();
    await logsPool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
