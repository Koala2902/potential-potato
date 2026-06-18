/** Recent jobs per machine on GET /api/production-status (Indigo + others from JOD + enrich). */
export const PRODUCTION_COMPLETED_JOBS_PER_MACHINE = 12;

/** How many latest PRINTED rows from "print OS" to merge for Indigo enrich (before per-job cap above). */
export const PRINT_OS_ENRICH_ROW_LIMIT = 48;

/** Recent scanned_codes rows to scan for op001 secondary enrich (before per-job filtering). */
export const OP001_SCAN_ENRICH_ROW_LIMIT = 120;

/** Recent slitter / digital-cut scans (op004–op006) merged into production-status when JOD lags or has legacy TZ rows. */
export const POST_PRINT_SCAN_ENRICH_ROW_LIMIT = 200;
