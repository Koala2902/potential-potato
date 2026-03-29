/**
 * Backfill scheduler.Job for Labex / switch imports:
 * - Sets `material` to composite `substrate_printcolour` (same rules as import-labex-submissions).
 * - Moves the former PDF name into `fileName` (from `switchDieInput.fileName`, else existing `fileName`, else prior `material`).
 *
 * Idempotent: safe to re-run; skips rows already on the target composite key.
 *
 * Usage: npx tsx scripts/migrate-job-material-filename.ts
 */
import {
  compositeMaterialPrintColour,
  splitLabexProfile,
} from "../src/lib/scheduler/job-material-key.ts";
import { prisma } from "../server/db/prisma.ts";

function targetMaterialFromJob(printColour: string, profile: string): string {
  if (profile.trim()) {
    const { substrate, printColour: printToken } = splitLabexProfile(profile);
    return compositeMaterialPrintColour(substrate, printToken);
  }
  return compositeMaterialPrintColour("unknown", printColour);
}

async function main() {
  const jobs = await prisma.job.findMany({
    where: { source: "switch" },
    select: {
      id: true,
      material: true,
      fileName: true,
      printColour: true,
      switchDieInput: true,
    },
  });

  let updated = 0;
  let skipped = 0;

  for (const job of jobs) {
    const die = job.switchDieInput;
    const dieObj =
      die && typeof die === "object" && die !== null ? (die as Record<string, unknown>) : null;
    const profile = typeof dieObj?.profile === "string" ? dieObj.profile : "";
    const fileFromJson =
      typeof dieObj?.fileName === "string" ? dieObj.fileName.trim() : "";

    const targetMaterial = targetMaterialFromJob(job.printColour, profile);

    if (job.material === targetMaterial) {
      if (!job.fileName && fileFromJson) {
        await prisma.job.update({
          where: { id: job.id },
          data: { fileName: fileFromJson },
        });
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    const nextFileName =
      fileFromJson || job.fileName || (job.material !== targetMaterial ? job.material : null);
    if (!nextFileName) {
      console.warn(`Job ${job.id}: no file name source; using material as fileName`);
    }

    await prisma.job.update({
      where: { id: job.id },
      data: {
        fileName: nextFileName ?? job.material,
        material: targetMaterial,
      },
    });
    updated += 1;
  }

  console.log(
    `Backfill done: ${updated} job(s) updated, ${skipped} already matched composite material.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
