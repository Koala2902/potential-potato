/**
 * Upsert rows from Material List.csv into jobmanager public.materials as company = NP Material.
 *
 * Prerequisites:
 *   - Run server/db/migrations-jobmanager/001-materials-company.sql on the jobmanager DB once.
 *   - Run `npm run run-migrations` so `public.materials` has barcode columns (038) and `location` (040).
 *
 * Usage:
 *   npx tsx scripts/import-material-list-csv.ts
 *   npx tsx scripts/import-material-list-csv.ts --dry-run
 *   MATERIAL_LIST_CSV=/path/to.csv npx tsx scripts/import-material-list-csv.ts
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "csv-parse/sync";
import dotenv from "dotenv";
import pg from "pg";

import { resolveJobmanagerDatabaseUrl } from "./jobmanager-url.js";

dotenv.config();

const { Pool } = pg;

const COMPANY_NP = "NP Material";

/** `public.materials` uses numeric(8,2) for width_mm, length_mm, cost_aud on this DB. */
const MAX_NUMERIC_82 = 999999.99;

function clampNumeric82(n: number | null): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n > MAX_NUMERIC_82) return MAX_NUMERIC_82;
  if (n < -MAX_NUMERIC_82) return -MAX_NUMERIC_82;
  return Math.round(n * 100) / 100;
}

function normalizeCell(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function rowFingerprint(row: Record<string, string>): string {
  const pick = (keys: string[]) => keys.map((k) => normalizeCell(row[k] ?? "")).join("|");
  return pick([
    "Vendor name",
    "Item",
    "Description",
    "Storage",
    "Standard length",
    "Storage Type Length",
    "Storage Type Width",
    "Unit Cost",
    "Sub Category",
  ]);
}

function hash12(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
}

function parseMoney(raw: string): number | null {
  const t = raw?.replace(/[$]/g, "").replace(/,/g, "").trim() ?? "";
  if (!t) return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function parseNum(raw: string): number | null {
  const t = raw?.replace(/,/g, "").trim() ?? "";
  if (!t) return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function mapSubstrateType(materialType: string): string {
  const t = normalizeCell(materialType);
  if (t.includes("laminate")) return "other";
  if (t.includes("media")) return "paper";
  return "other";
}

function mapPricingUnit(uom: string): string {
  const u = normalizeCell(uom);
  if (!u || u === "each") return "each";
  return u;
}

/**
 * CSV has two columns that both become `Status` after csv-parse trims headers (`Status` + ` Status` → duplicate key; last wins = `synchronized`).
 * Treat ERP sync states as catalog-active; only explicit inactive values disable the row.
 */
function isActiveFromCsvStatus(row: Record<string, string>): boolean {
  const raw = String(row["Status"] ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return true;
  if (raw === "inactive" || raw === "archived" || raw === "deprecated") return false;
  return true;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const csvPath =
    process.env.MATERIAL_LIST_CSV?.trim() || join(process.cwd(), "Material List.csv");

  if (!existsSync(csvPath)) {
    throw new Error(
      `CSV not found: ${csvPath}. Set MATERIAL_LIST_CSV or place "Material List.csv" in the project root.`
    );
  }

  const raw = readFileSync(csvPath, "utf-8");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const url = resolveJobmanagerDatabaseUrl();
  const pool = new Pool({ connectionString: url });

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let processed = 0;
  const samples: string[] = [];

  try {
    for (const row of rows) {
      const item = (row["Item"] ?? "").trim();
      if (!item) {
        skipped++;
        continue;
      }

      const fp = rowFingerprint(row);
      const h = hash12(fp);
      const material_code = `NP-${h}`;
      const material_id = `MAT-NP-${h}`;

      const material_name = (row["Description"] ?? "").trim() || item;
      const vendor = (row["Vendor name"] ?? "").trim();
      const is_active = isActiveFromCsvStatus(row);

      const cost_aud = clampNumeric82(parseMoney(row["Unit Cost"] ?? ""));
      const stock = parseNum(row["Onhand Qty"] ?? "") ?? 0;
      const width_mm = clampNumeric82(parseNum(row["Storage Type Width"] ?? ""));
      const length_mm = clampNumeric82(parseNum(row["Storage Type Length"] ?? ""));

      const substrate_type = mapSubstrateType(row["Material Type"] ?? "");
      const pricing_unit = mapPricingUnit(row["Quantity Uom"] ?? "");
      const storage = (row["Storage"] ?? "").trim();
      const aliasesParts = [vendor, storage].filter(Boolean);
      const aliases = aliasesParts.join(" · ").slice(0, 2000) || null;

      if (samples.length < 5) {
        samples.push(`${material_code}\t${material_name.slice(0, 48)}`);
      }

      processed++;

      if (dryRun) {
        continue;
      }

      const existing = await pool.query<{ material_id: string }>(
        `SELECT material_id FROM public.materials WHERE material_code = $1 LIMIT 1`,
        [material_code]
      );

      if (existing.rows.length > 0) {
        const id = existing.rows[0]!.material_id;
        await pool.query(
          `UPDATE public.materials SET
             material_name = $1,
             substrate_type = $2,
             width_mm = $3,
             length_mm = $4,
             cost_aud = $5,
             stock = $6,
             aliases = $7,
             pricing_unit = $8,
             is_active = $9,
             company = $10,
             location = $11
           WHERE material_id = $12`,
          [
            material_name,
            substrate_type,
            width_mm,
            length_mm,
            cost_aud,
            stock,
            aliases,
            pricing_unit,
            is_active,
            COMPANY_NP,
            storage || null,
            id,
          ]
        );
        updated++;
      } else {
        await pool.query(
          `INSERT INTO public.materials (
             material_id, material_code, material_name,
             substrate_type, adhesive_type, handling,
             weight_gsm, width_mm, length_mm,
             coating, grain_direction, glossy_level,
             conductive, white_material,
             cost_aud, stock, reorder_level, lead_time_days,
             aliases, pricing_unit, substrate_group, is_active, company,
             location
           ) VALUES (
             $1, $2, $3,
             $4, NULL, NULL,
             NULL, $5, $6,
             NULL, NULL, NULL,
             false, false,
             $7, $8, 0, 7,
             $9, $10, NULL, $11, $12,
             $13
           )`,
          [
            material_id,
            material_code,
            material_name,
            substrate_type,
            width_mm,
            length_mm,
            cost_aud,
            stock,
            aliases,
            pricing_unit,
            is_active,
            COMPANY_NP,
            storage || null,
          ]
        );
        inserted++;
      }
    }

    console.log(
      dryRun
        ? `[dry-run] ${processed} data rows (skipped empty Item: ${skipped}). No DB writes.`
        : `Done. inserted=${inserted} updated=${updated} skipped_empty_item=${skipped}`
    );
    if (samples.length) {
      console.log("Sample material_code / name:");
      for (const s of samples) console.log(" ", s);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
