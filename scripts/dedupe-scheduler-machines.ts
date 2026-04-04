/**
 * One-time: remove duplicate scheduler.Machine rows that differ only by id
 * (e.g. after legacy public.machines was copied while seed already existed).
 * Keeps the row with lowest sortOrder, then lexicographically smallest id.
 *
 *   tsx scripts/dedupe-scheduler-machines.ts
 */
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

import { buildDatabaseUrl } from "../server/db/build-database-url.ts";

dotenv.config();
process.env.DATABASE_URL = buildDatabaseUrl();

const prisma = new PrismaClient();

async function main() {
  const all = await prisma.machine.findMany({
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });

  const seen = new Map<string, string>();
  const toDelete: string[] = [];

  for (const m of all) {
    const key = m.name.trim().toLowerCase();
    if (seen.has(key)) {
      toDelete.push(m.id);
    } else {
      seen.set(key, m.id);
    }
  }

  if (toDelete.length === 0) {
    console.log("No duplicate machine names (case-insensitive). Nothing to remove.");
    return;
  }

  const deleted = await prisma.machine.deleteMany({
    where: { id: { in: toDelete } },
  });

  console.log(`Removed ${deleted.count} duplicate machine row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
