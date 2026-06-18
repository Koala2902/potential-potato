/**
 * Print OS maintenance:
 * 1) Sync `processing_markers.print_os` cursor to `MAX(id)` or `MAX(marker)` on `"print OS"`
 *    (matches `PRINT_OS_CURSOR_USE_ROW_ID` / `processPrintOSRecords`).
 * 2) Run `processPrintOSRecords()` to apply newer rows.
 *
 * Usage:
 *   npx tsx scripts/print-os-maintenance.ts
 *   PRINT_OS_CURSOR_USE_ROW_ID=true npx tsx scripts/print-os-maintenance.ts   # sync MAX(id)
 *   npx tsx scripts/print-os-maintenance.ts --process-only
 *   npx tsx scripts/print-os-maintenance.ts --sync-only
 */
import dotenv from "dotenv";

dotenv.config();

import { appPool } from "../server/db/app-connection.js";
import { printOsCursorUsesRowId } from "../server/db/database-config.js";
import { getPrintOsPool } from "../server/db/print-os-pool.js";
import { processPrintOSRecords } from "../server/db/status-updates.js";

async function syncMarkerFromPrintOsMax(): Promise<{ value: number; column: "id" | "marker" }> {
  const useId = printOsCursorUsesRowId();
  const column: "id" | "marker" = useId ? "id" : "marker";
  const po = await getPrintOsPool().connect();
  let maxVal = 0;
  try {
    const r = await po.query(
      `SELECT COALESCE(MAX(${column}), 0)::bigint AS m FROM "print OS"`
    );
    maxVal = Number(r.rows[0]?.m ?? 0);
  } finally {
    po.release();
  }

  const app = await appPool.connect();
  try {
    await app.query(
      `INSERT INTO processing_markers (marker_type, last_processed_id, last_processed_at, updated_at)
       VALUES ('print_os', $1, NOW(), NOW())
       ON CONFLICT (marker_type) DO UPDATE SET
         last_processed_id = EXCLUDED.last_processed_id,
         last_processed_at = NOW(),
         updated_at = NOW()`,
      [maxVal]
    );
  } finally {
    app.release();
  }

  return { value: maxVal, column };
}

async function main() {
  const syncOnly = process.argv.includes("--sync-only");
  const processOnly = process.argv.includes("--process-only");

  if (!processOnly) {
    const { value, column } = await syncMarkerFromPrintOsMax();
    console.log(
      `[print-os] processing_markers.print_os set to MAX(${column}) from "print OS" → ${value}`
    );
    if (syncOnly) {
      return;
    }
  }

  console.log("[print-os] running processPrintOSRecords()…");
  const result = await processPrintOSRecords();
  console.log("[print-os] done:", result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
