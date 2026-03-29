/**
 * Prisma CLI expects DATABASE_URL (or APP_DB_HOST / APP_DB_PORT / APP_DB_NAME / APP_DB_USER / APP_DB_PASSWORD).
 * Use: tsx scripts/prisma-with-env.ts <prisma args…>  e.g. tsx scripts/prisma-with-env.ts db push
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";

import { buildDatabaseUrl } from "../server/db/build-database-url.ts";

dotenv.config();
process.env.DATABASE_URL = buildDatabaseUrl();

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: tsx scripts/prisma-with-env.ts <prisma arguments…>");
  console.error("Example: npm run prisma:push   →   tsx scripts/prisma-with-env.ts db push");
  process.exit(1);
}

const redacted =
  process.env.DATABASE_URL?.replace(/:([^:@/]+)@/, ":****@") ?? "(missing)";
console.log("[prisma-with-env] DATABASE_URL:", redacted);
console.log("[prisma-with-env] Running: prisma", args.join(" "));

/** Prefer running the installed CLI with Node (reliable stdio; avoids npx spawn issues). */
function prismaCliPath(): string | null {
  const candidates = [
    join(process.cwd(), "node_modules", "prisma", "build", "index.js"),
    join(process.cwd(), "node_modules", "prisma", "cli", "build", "index.js"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

const cli = prismaCliPath();
let result: ReturnType<typeof spawnSync>;

if (cli) {
  result = spawnSync(process.execPath, [cli, ...args], {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });
} else {
  console.warn(
    "[prisma-with-env] Local prisma CLI not found; falling back to npx prisma"
  );
  result = spawnSync("npx", ["prisma", ...args], {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
    shell: true,
  });
}

if (result.error) {
  console.error("[prisma-with-env] Spawn error:", result.error);
  process.exit(1);
}

const code = result.status ?? 1;
if (code !== 0) {
  console.error("[prisma-with-env] prisma exited with code", code);
}
process.exit(code);
