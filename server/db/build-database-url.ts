import { getAppDatabaseUrl } from "./database-config.js";

/** Prisma CLI, PrismaClient, and seeds — app database only. */
export function buildDatabaseUrl(): string {
  return getAppDatabaseUrl();
}
