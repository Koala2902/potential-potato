/**
 * Resolve URL for jobmanager / Print OS material tables.
 * Mirrors scripts/list-jobmanager-material-tables.ts.
 */
export function resolveJobmanagerDatabaseUrl(): string {
  const explicit = process.env.JOBMANAGER_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const app = process.env.DATABASE_URL?.trim();
  if (!app) {
    throw new Error(
      "Set DATABASE_URL or JOBMANAGER_DATABASE_URL to connect to jobmanager."
    );
  }
  try {
    const u = new URL(app);
    u.pathname = "/jobmanager";
    return u.toString();
  } catch {
    throw new Error(
      "Could not derive jobmanager URL from DATABASE_URL; set JOBMANAGER_DATABASE_URL."
    );
  }
}
