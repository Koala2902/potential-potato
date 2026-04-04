/**
 * One-time: copy legacy `scheduler.Job.scheduledDate` into `JobMachineSchedule`
 * for every (job × machine) pair where `scheduledDate` was set.
 *
 * Run only when `Job.scheduledDate` still exists (before a Prisma push that drops it)
 * and after `JobMachineSchedule` exists. If the legacy column is already gone, exits with a message.
 *
 *   tsx scripts/backfill-job-machine-schedules.ts
 */
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

import { buildDatabaseUrl } from "../server/db/build-database-url.ts";

dotenv.config();
process.env.DATABASE_URL = buildDatabaseUrl();

const prisma = new PrismaClient();

async function main() {
  const [tableRow] = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'scheduler' AND table_name = 'JobMachineSchedule'
    ) AS "exists"
  `;
  if (!tableRow?.exists) {
    console.log("scheduler.JobMachineSchedule table not found — run `npm run prisma:push` first.");
    return;
  }

  const [colRow] = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'scheduler' AND table_name = 'Job' AND column_name = 'scheduledDate'
    ) AS "exists"
  `;
  if (!colRow?.exists) {
    console.log("Job.scheduledDate column not found — nothing to backfill.");
    return;
  }

  const result = await prisma.$executeRaw`
    INSERT INTO scheduler."JobMachineSchedule" (id, "jobId", "machineId", "scheduledDate")
    SELECT gen_random_uuid(), j.id, m.id, j."scheduledDate"
    FROM scheduler."Job" j
    CROSS JOIN scheduler."Machine" m
    WHERE j."scheduledDate" IS NOT NULL
    ON CONFLICT ("jobId", "machineId") DO UPDATE SET "scheduledDate" = EXCLUDED."scheduledDate"
  `;
  console.log("Backfill done — rows affected:", result);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
