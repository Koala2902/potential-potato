/**
 * Deletes all rows in the Prisma `scheduler` schema (jobs, machines, operations, settings, etc.).
 * Does not touch other PostgreSQL schemas (e.g. legacy `public` tables).
 *
 * Usage:
 *   tsx scripts/clean-scheduler-db.ts
 *   tsx scripts/clean-scheduler-db.ts --seed   # then run prisma seed
 */
import { execSync } from "node:child_process";

import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

import { buildDatabaseUrl } from "../server/db/build-database-url.ts";

dotenv.config();
process.env.DATABASE_URL = buildDatabaseUrl();

const prisma = new PrismaClient();

async function main() {
  const wantSeed = process.argv.includes("--seed");

  const counts = await prisma.$transaction(async (tx) => {
    const j = await tx.job.deleteMany();
    const od = await tx.operationDependency.deleteMany();
    const mo = await tx.materialOverride.deleteMany();
    const op = await tx.operationParam.deleteMany();
    const br = await tx.batchRule.deleteMany();
    const o = await tx.operation.deleteMany();
    const m = await tx.machine.deleteMany();
    const c = await tx.connector.deleteMany();
    const tes = await tx.timeEstimatorSettings.deleteMany();
    return {
      job: j.count,
      operationDependency: od.count,
      materialOverride: mo.count,
      operationParam: op.count,
      batchRule: br.count,
      operation: o.count,
      machine: m.count,
      connector: c.count,
      timeEstimatorSettings: tes.count,
    };
  });

  console.log("scheduler schema cleaned:", counts);

  if (wantSeed) {
    console.log("Running prisma seed…");
    execSync("npm run prisma:seed", {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });
  } else {
    console.log("Tip: run `npm run prisma:seed` to restore baseline machines and settings.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
