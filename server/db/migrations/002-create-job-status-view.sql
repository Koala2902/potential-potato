-- Migration: Create job_status_view for pre-computed job status aggregations
-- Date: 2025-12-21
-- Description: Create a view that groups job_operations by job_id and calculates status

-- ============================================================================
-- LOGS DATABASE
-- ============================================================================

-- Drop view if it exists (for idempotency)
DROP VIEW IF EXISTS job_status_view;

-- Create view that groups job_operations by job_id
CREATE VIEW job_status_view AS
SELECT 
    jo.job_id,
    COUNT(DISTINCT jo.version_tag) as total_versions,
    COUNT(DISTINCT CASE WHEN jo.completed_at IS NOT NULL THEN jo.version_tag END) as completed_versions,
    MAX(CASE WHEN jo.completed_at IS NOT NULL THEN jo.sequence_order END) as max_completed_sequence,
    MAX(jo.sequence_order) as max_sequence,
    ARRAY_AGG(DISTINCT jo.version_tag ORDER BY jo.version_tag) as version_tags,
    MIN(jo.completed_at) as earliest_completed_at,
    MAX(jo.completed_at) as latest_completed_at,
    -- Calculate status based on max_completed_sequence
    -- NULL means no operations completed yet -> print_ready
    CASE 
        WHEN MAX(CASE WHEN jo.completed_at IS NOT NULL THEN jo.sequence_order END) IS NULL THEN 'print_ready'
        WHEN MAX(CASE WHEN jo.completed_at IS NOT NULL THEN jo.sequence_order END) >= 4 THEN 'production_finished'
        WHEN MAX(CASE WHEN jo.completed_at IS NOT NULL THEN jo.sequence_order END) >= 3 THEN 'slitter'
        WHEN MAX(CASE WHEN jo.completed_at IS NOT NULL THEN jo.sequence_order END) >= 2 THEN 'digital_cut'
        WHEN MAX(CASE WHEN jo.completed_at IS NOT NULL THEN jo.sequence_order END) >= 1 THEN 'printed'
        ELSE 'print_ready'
    END as status
FROM job_operations jo
GROUP BY jo.job_id;

-- Create index on job_id for faster lookups (if not exists)
CREATE INDEX IF NOT EXISTS idx_job_operations_job_id ON job_operations(job_id);
CREATE INDEX IF NOT EXISTS idx_job_operations_completed_at ON job_operations(completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_operations_sequence_order ON job_operations(sequence_order);

-- Add comment to view
COMMENT ON VIEW job_status_view IS 'Pre-computed view of job status grouped by job_id with version counts and status calculation';

