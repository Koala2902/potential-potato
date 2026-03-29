/**
 * Canonical catalog for **Ticket / scan validation** (`processScannedCodes`, `verifyOperationIdExists`)
 * is **`scheduler.Operation`** on the app database (`DATABASE_URL` / Prisma).
 *
 * Scan payloads use lowercase `op###` strings matching `Operation.id` (e.g. `op001`).
 *
 * **Scheduler config UI** uses the same Prisma models (`Machine`, `Operation`).
 */
export const CANONICAL_SCAN_OPERATION_SOURCE = "scheduler.Operation" as const;
