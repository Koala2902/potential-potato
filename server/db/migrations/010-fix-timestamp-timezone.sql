-- Migration: Fix timestamp timezone handling for completed_at columns
-- Date: 2025-12-22
-- Description: Convert completed_at columns from timestamp to timestamptz to properly handle timezones
--              This ensures Print OS timestamps (which are timestamptz) are stored correctly

-- ============================================================================
-- LOGS DATABASE
-- ============================================================================

-- Drop view temporarily (will recreate it after column type change)
DROP VIEW IF EXISTS job_status_view;

-- Convert job_operations.completed_at to timestamptz
-- First, we need to convert existing data assuming it's in the server's timezone
-- Then change the column type
DO $$
BEGIN
    -- Check if column exists and is not already timestamptz
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'job_operations' 
        AND column_name = 'completed_at'
        AND data_type = 'timestamp without time zone'
    ) THEN
        -- Convert existing timestamps assuming they're in Australia/Sydney timezone
        -- Then convert to UTC for storage
        ALTER TABLE job_operations 
        ALTER COLUMN completed_at TYPE timestamptz 
        USING completed_at AT TIME ZONE 'Australia/Sydney';
        
        RAISE NOTICE 'Converted job_operations.completed_at to timestamptz';
    END IF;
END $$;

-- Convert imposition_operations.completed_at to timestamptz
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'imposition_operations' 
        AND column_name = 'completed_at'
        AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE imposition_operations 
        ALTER COLUMN completed_at TYPE timestamptz 
        USING completed_at AT TIME ZONE 'Australia/Sydney';
        
        RAISE NOTICE 'Converted imposition_operations.completed_at to timestamptz';
    END IF;
END $$;

-- Convert scanned_codes.scanned_at to timestamptz if it's not already
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'scanned_codes' 
        AND column_name = 'scanned_at'
        AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE scanned_codes 
        ALTER COLUMN scanned_at TYPE timestamptz 
        USING scanned_at AT TIME ZONE 'Australia/Sydney';
        
        RAISE NOTICE 'Converted scanned_codes.scanned_at to timestamptz';
    END IF;
END $$;

-- Add comment explaining timezone handling
COMMENT ON COLUMN job_operations.completed_at IS 'Timestamp when operation was completed. Stored as timestamptz (UTC) to match Print OS job_complete_time format.';
COMMENT ON COLUMN imposition_operations.completed_at IS 'Timestamp when operation was completed. Stored as timestamptz (UTC) to match Print OS job_complete_time format.';
COMMENT ON COLUMN scanned_codes.scanned_at IS 'Timestamp when code was scanned. Stored as timestamptz (UTC) for consistency.';

-- Recreate the view (using migration 007 definition)
-- This ensures the view works with the new timestamptz columns
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
    -- Extract job_id from code_text (format: job_id_version_tag, e.g., "4677_5995_1")
    SELECT DISTINCT ON (job_id_extracted)
        SPLIT_PART(sc.code_text, '_', 1) || '_' || SPLIT_PART(sc.code_text, '_', 2) as job_id_extracted,
        (jsonb_array_elements_text(sc.operations->'operations'))::text as operation_id,
        sc.scanned_at as latest_completed_at
    FROM scanned_codes sc
    CROSS JOIN LATERAL jsonb_array_elements_text(sc.operations->'operations') as op
    WHERE sc.operations IS NOT NULL
    AND sc.operations::text != '{}'
    AND sc.code_text ~ '^\d+_\d+_\d+$' -- Matches job_id_version_tag format (e.g., "4677_5995_1")
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
            WHEN ls.latest_completed_at > COALESCE(lo.latest_completed_at, '1970-01-01'::timestamptz) 
            THEN ls.operation_id 
            ELSE lo.latest_completed_operation_id 
        END,
        lo.latest_completed_operation_id
    ) as latest_completed_operation_id,
    GREATEST(
        COALESCE(lo.latest_completed_at, '1970-01-01'::timestamptz),
        COALESCE(ls.latest_completed_at, '1970-01-01'::timestamptz)
    ) as latest_completed_at,
    MIN(jo.completed_at) as earliest_completed_at,
    ARRAY_AGG(DISTINCT jo.version_tag ORDER BY jo.version_tag) as version_tags,
    -- Calculate status based on all completed operations (using the new function)
    get_status_from_operations(jo.job_id) as status
FROM job_operations jo
LEFT JOIN latest_operations lo ON jo.job_id = lo.job_id
LEFT JOIN latest_scanned_operations ls ON jo.job_id = ls.job_id_extracted
GROUP BY jo.job_id, lo.latest_completed_operation_id, lo.latest_completed_at, ls.operation_id, ls.latest_completed_at;

COMMENT ON VIEW job_status_view IS 'Pre-computed view of job status grouped by job_id. Status and latest_completed_operation_id determined by checking both job_operations table and scanned_codes table to ensure all scans are reflected, even if not yet processed into job_operations.';

