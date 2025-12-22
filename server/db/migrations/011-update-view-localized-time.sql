-- Migration: Update job_status_view to use localized time (Australia/Sydney)
-- Date: 2025-12-22
-- Description: Convert timestamps in the view to Australia/Sydney timezone for display
--              This ensures the view shows times in local timezone matching Print OS display

-- ============================================================================
-- LOGS DATABASE
-- ============================================================================

-- Drop existing view
DROP VIEW IF EXISTS job_status_view;

-- Recreate view with localized timestamps (Australia/Sydney timezone)
-- Note: Timestamps are stored as timestamptz (UTC) but displayed in Australia/Sydney timezone
CREATE VIEW job_status_view AS
WITH latest_operations AS (
    -- Get the latest completed operation for each job_id from job_operations
    SELECT DISTINCT ON (job_id)
        job_id,
        operation_id as latest_completed_operation_id,
        completed_at as latest_completed_at_raw  -- Keep raw timestamptz for comparison
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
        scanned_at as latest_completed_at_raw  -- Keep raw timestamptz for comparison
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
            WHEN ls.latest_completed_at_raw > COALESCE(lo.latest_completed_at_raw, '1970-01-01'::timestamptz) 
            THEN ls.operation_id 
            ELSE lo.latest_completed_operation_id 
        END,
        lo.latest_completed_operation_id
    ) as latest_completed_operation_id,
    -- Convert to Australia/Sydney timezone for display (matching Print OS table display)
    GREATEST(
        COALESCE(lo.latest_completed_at_raw AT TIME ZONE 'Australia/Sydney', '1970-01-01'::timestamp),
        COALESCE(ls.latest_completed_at_raw AT TIME ZONE 'Australia/Sydney', '1970-01-01'::timestamp)
    ) as latest_completed_at,
    -- Convert earliest_completed_at to Australia/Sydney timezone
    MIN(jo.completed_at AT TIME ZONE 'Australia/Sydney') as earliest_completed_at,
    ARRAY_AGG(DISTINCT jo.version_tag ORDER BY jo.version_tag) as version_tags,
    -- Calculate status based on all completed operations (using the new function)
    get_status_from_operations(jo.job_id) as status
FROM job_operations jo
LEFT JOIN latest_operations lo ON jo.job_id = lo.job_id
LEFT JOIN latest_scanned_operations ls ON jo.job_id = ls.job_id_extracted
GROUP BY jo.job_id, lo.latest_completed_operation_id, lo.latest_completed_at_raw, ls.operation_id, ls.latest_completed_at_raw;

COMMENT ON VIEW job_status_view IS 'Pre-computed view of job status grouped by job_id. All timestamps are displayed in Australia/Sydney timezone to match Print OS table display. Status and latest_completed_operation_id determined by checking both job_operations table and scanned_codes table.';

