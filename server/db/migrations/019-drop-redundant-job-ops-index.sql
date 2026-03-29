-- Remove index from old migration 017 (superseded by functional indexes in 018)
-- LOGS DATABASE

DROP INDEX IF EXISTS idx_job_operations_job_id_completed_at;
