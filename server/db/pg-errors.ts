/** PostgreSQL undefined_table */
export function isUndefinedTableError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "42P01"
  );
}

/** PostgreSQL undefined_column (42703) */
export function isUndefinedColumnError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "42703"
  );
}
