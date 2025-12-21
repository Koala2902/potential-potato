-- Migration: Update job_status_view to use operation_id-based status instead of sequence_order
-- Date: 2025-12-21
-- Description: Use latest completed operation_id to determine status, making it flexible for new operations

-- ============================================================================
-- LOGS DATABASE
-- ============================================================================

-- Drop existing view
DROP VIEW IF EXISTS job_status_view;

-- Create a function to determine status based on completed operations
-- Mapping rules:
-- op001 → printed
-- op002 → digital_cut (if only op002)
-- op003 → slitter (but if op003 is scanned, it's always production_finished)
-- op004 → production_finished
-- If both op002 and op003 are scanned → slitter (but op003 takes priority, so production_finished)
-- If only op002 → digital_cut
CREATE OR REPLACE FUNCTION get_status_from_operations(job_id_param TEXT)
RETURNS TEXT AS $$
DECLARE
    has_op001 BOOLEAN := FALSE;
    has_op002 BOOLEAN := FALSE;
    has_op003 BOOLEAN := FALSE;
    has_op004 BOOLEAN := FALSE;
BEGIN
    -- Check which operations have been completed for this job
    SELECT 
        BOOL_OR(LOWER(operation_id) = 'op001' AND completed_at IS NOT NULL),
        BOOL_OR(LOWER(operation_id) = 'op002' AND completed_at IS NOT NULL),
        BOOL_OR(LOWER(operation_id) = 'op003' AND completed_at IS NOT NULL),
        BOOL_OR(LOWER(operation_id) = 'op004' AND completed_at IS NOT NULL)
    INTO has_op001, has_op002, has_op003, has_op004
    FROM job_operations
    WHERE job_id = job_id_param;
    
    -- Apply status rules (in priority order):
    -- 1. If op004 is scanned, it's production_finished
    IF has_op004 THEN
        RETURN 'production_finished';
    END IF;
    
    -- 2. If both op002 and op003 are scanned, it's slitter
    IF has_op002 AND has_op003 THEN
        RETURN 'slitter';
    END IF;
    
    -- 3. If op003 is scanned alone, it's slitter
    IF has_op003 THEN
        RETURN 'slitter';
    END IF;
    
    -- 4. If only op002 is scanned (without op003), it's digital_cut
    IF has_op002 THEN
        RETURN 'digital_cut';
    END IF;
    
    -- 5. If op001 is scanned, it's printed
    IF has_op001 THEN
        RETURN 'printed';
    END IF;
    
    -- 6. No operations completed yet
    RETURN 'print_ready';
END;
$$ LANGUAGE plpgsql;

-- Create updated view that uses operation-based status determination
-- This checks all completed operations for each job and determines status based on the rules
CREATE VIEW job_status_view AS
WITH latest_operations AS (
    -- Get the latest completed operation for each job_id from job_operations
    SELECT DISTINCT ON (job_id)
        job_id,
        operation_id as latest_completed_operation_id,
        completed_at as latest_completed_at
    FROM job_operations
    WHERE completed_at IS NOT NULL
    ORDER BY job_id, completed_at DESC
),
latest_scanned_operations AS (
    -- Also check scanned_codes for latest operations that might not be in job_operations yet
    -- This ensures we show the most recent operation even if processing is delayed
    SELECT DISTINCT ON (
        -- Extract job_id from code_text (format: job_id_version_tag)
        SPLIT_PART(sc.code_text, '_', 1) || '_' || SPLIT_PART(sc.code_text, '_', 2)
    )
        SPLIT_PART(sc.code_text, '_', 1) || '_' || SPLIT_PART(sc.code_text, '_', 2) as job_id,
        -- Extract operation_id from operations JSONB
        (jsonb_array_elements_text(sc.operations->'operations'))::text as operation_id,
        sc.scanned_at as latest_completed_at
    FROM scanned_codes sc
    WHERE sc.operations IS NOT NULL
    AND sc.operations::text != '{}'
    AND sc.code_text ~ '^\d+_\d+_\d+$' -- Matches job_id_version_tag format
    AND jsonb_array_length(sc.operations->'operations') > 0
    ORDER BY 
        SPLIT_PART(sc.code_text, '_', 1) || '_' || SPLIT_PART(sc.code_text, '_', 2),
        sc.scanned_at DESC
)
SELECT 
    jo.job_id,
    COUNT(DISTINCT jo.version_tag) as total_versions,
    COUNT(DISTINCT CASE WHEN jo.completed_at IS NOT NULL THEN jo.version_tag END) as completed_versions,
    -- Use scanned_codes operation if it's newer, otherwise use job_operations
    COALESCE(
        CASE 
            WHEN ls.latest_completed_at > COALESCE(lo.latest_completed_at, '1970-01-01'::timestamp) 
            THEN ls.operation_id 
            ELSE lo.latest_completed_operation_id 
        END,
        lo.latest_completed_operation_id
    ) as latest_completed_operation_id,
    GREATEST(
        COALESCE(lo.latest_completed_at, '1970-01-01'::timestamp),
        COALESCE(ls.latest_completed_at, '1970-01-01'::timestamp)
    ) as latest_completed_at,
    MIN(jo.completed_at) as earliest_completed_at,
    ARRAY_AGG(DISTINCT jo.version_tag ORDER BY jo.version_tag) as version_tags,
    -- Calculate status based on all completed operations (using the new function)
    get_status_from_operations(jo.job_id) as status
FROM job_operations jo
LEFT JOIN latest_operations lo ON jo.job_id = lo.job_id
LEFT JOIN latest_scanned_operations ls ON jo.job_id = ls.job_id
GROUP BY jo.job_id, lo.latest_completed_operation_id, lo.latest_completed_at, ls.operation_id, ls.latest_completed_at;

-- Create index on completed_at for faster lookups
CREATE INDEX IF NOT EXISTS idx_job_operations_completed_at_desc 
ON job_operations(completed_at DESC) 
WHERE completed_at IS NOT NULL;

-- Create index on operation_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_job_operations_operation_id 
ON job_operations(operation_id) 
WHERE completed_at IS NOT NULL;

-- Add comment to view
COMMENT ON VIEW job_status_view IS 'Pre-computed view of job status grouped by job_id. Status determined by checking all completed operations in job_operations table. Scanned codes from jobmanager.scanned_codes are processed into job_operations via processScannedCodes() function, so this view reflects all processed scans.';

-- Add comment to function
COMMENT ON FUNCTION get_status_from_operations(TEXT) IS 'Determines job status based on all completed operations in job_operations table. Scanned codes from jobmanager.scanned_codes are processed into job_operations before being reflected in this view. Checks which operations (op001-op004) have been completed and applies status mapping rules.';

