/**
 * Imports Labex "Submit Point" CSV rows into scheduler.Job with source = "switch".
 *
 * Default CSV paths (first match wins):
 *   data/labex-submissions.csv
 *   Labex Submit Point - Submissions.csv  (project root)
 *
 * Usage:
 *   tsx scripts/import-labex-submissions.ts
 *   tsx scripts/import-labex-submissions.ts --append   # do not delete existing switch jobs first
 *   LABEX_CSV=/path/to/file.csv tsx scripts/import-labex-submissions.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "csv-parse/sync";
import { Prisma } from "@prisma/client";

import {
  compositeMaterialPrintColour,
  splitLabexProfile,
} from "../src/lib/scheduler/job-material-key.ts";
import { prisma } from "../server/db/prisma.ts";

type Row = {
  "File Name": string;
  "Time of Submission": string;
  "Date of Submission": string;
  "Linear Meters": string;
  Profile: string;
  Path: string;
  MediaBoxW: string;
  MediaBoxH: string;
};

function resolveCsvPath(): string {
  const fromEnv = process.env.LABEX_CSV?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    join(process.cwd(), "data", "labex-submissions.csv"),
    join(process.cwd(), "Labex Submit Point - Submissions.csv"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `CSV not found. Place the file at data/labex-submissions.csv or "Labex Submit Point - Submissions.csv", or set LABEX_CSV.`
  );
}

function mapProductionPath(pathRaw: string): "indigo_only" | "digicon" | "digital_cutter" | "slitter" {
  const p = pathRaw.trim();
  if (p === "Digicon") return "digicon";
  if (p === "Slitter") return "slitter";
  if (p === "Digital_Cut" || p.toLowerCase().replace(/-/g, "_") === "digital_cut") {
    return "digital_cutter";
  }
  return "digital_cutter";
}

function parseNum(s: string): number | null {
  const t = s?.trim();
  if (!t) return null;
  const n = Number.parseFloat(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseDueDate(dateStr: string, timeStr: string): Date | null {
  const d = dateStr?.trim();
  const t = timeStr?.trim();
  if (!d) return null;
  const iso = t ? `${d}T${t}` : `${d}T12:00:00`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function loadCsv() {
  const append = process.argv.includes("--append");
  const path = resolveCsvPath();
  const raw = readFileSync(path, "utf-8");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as Row[];

  return { append, path, rows };
}

async function run() {
  const { append, path, rows } = loadCsv();
  console.log(`Reading ${path} (${rows.length} data rows)`);

  if (!append) {
    const del = await prisma.job.deleteMany({ where: { source: "switch" } });
    console.log(`Removed ${del.count} existing job(s) with source "switch".`);
  }

  const data: Prisma.JobCreateManyInput[] = rows.map((row, index) => {
    const fileName = row["File Name"]?.trim() ?? "";
    const linearM = parseNum(row["Linear Meters"] ?? "");
    const rollLengthMetres = linearM ?? undefined;
    const pdfQty = Math.max(1, Math.round(linearM ?? 1));
    const profile = row.Profile?.trim() ?? "";
    const pathCol = row.Path?.trim() ?? "";
    const mediaW = parseNum(row.MediaBoxW ?? "");
    const mediaH = parseNum(row.MediaBoxH ?? "");
    const dueDate = parseDueDate(row["Date of Submission"] ?? "", row["Time of Submission"] ?? "");

    const switchDieInput: Prisma.InputJsonValue = {
      fileName,
      timeOfSubmission: row["Time of Submission"]?.trim() ?? "",
      dateOfSubmission: row["Date of Submission"]?.trim() ?? "",
      linearMeters: linearM,
      profile,
      path: pathCol,
      mediaBoxW: mediaW,
      mediaBoxH: mediaH,
    };

    const { substrate, printColour: printToken } = splitLabexProfile(profile);
    const materialKey = compositeMaterialPrintColour(substrate, printToken);

    return {
      source: "switch",
      externalId: `labex:${String(index + 1).padStart(5, "0")}`,
      material: materialKey.slice(0, 512),
      fileName: fileName.slice(0, 512) || `row_${index + 1}`,
      pdfQty,
      printColour: printToken,
      finishing: "none",
      productionPath: mapProductionPath(pathCol),
      rollLengthMetres: rollLengthMetres ?? undefined,
      dueDate: dueDate ?? undefined,
      labelWidthMm: mediaW ?? undefined,
      labelHeightMm: mediaH ?? undefined,
      switchDieInput,
    };
  });

  const batchSize = 200;
  let inserted = 0;
  for (let i = 0; i < data.length; i += batchSize) {
    const chunk = data.slice(i, i + batchSize);
    const r = await prisma.job.createMany({ data: chunk });
    inserted += r.count;
  }

  console.log(`Inserted ${inserted} job(s) with source "switch".`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
