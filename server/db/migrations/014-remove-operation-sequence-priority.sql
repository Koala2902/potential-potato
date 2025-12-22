-- Migration: Remove operation sequence priority - use timestamp only
-- Date: 2025-12-22
-- Description: Show the actual latest operation by timestamp (local time), not by sequence
--              This allows reprints (op001 after op002) to be shown correctly

-- ============================================================================
-- LOGS DATABASE
-- ============================================================================

-- Drop existing view
DROP VIEW IF EXISTS job_status_view;

-- Recreate view using timestamp comparison only (no sequence priority)
-- This ensures reprints are shown correctly
CREATE VIEW job_status_view AS
WITH latest_operations AS (
    -- Get the latest completed operation for each job_id from job_operations
    -- Order by timestamp in local time only (no sequence priority)
    SELECT DISTINCT ON (job_id)
        job_id,
        operation_id as latest_completed_operation_id,
        completed_at as latest_completed_at_raw,
        -- Convert to Sydney time for comparison and display
        completed_at AT TIME ZONE 'Australia/Sydney' as latest_completed_at_local
    FROM job_operations
    WHERE completed_at IS NOT NULL
    ORDER BY job_id, 
             completed_at AT TIME ZONE 'Australia/Sydney' DESC  -- Latest local time first
),
latest_scanned_operations AS (
    -- Also check scanned_codes for latest operations that might not be in job_operations yet
    -- Extract job_id from code_text (format: job_id_version_tag, e.g., "4677_5995_1")
    -- Order by timestamp in local time only (no sequence priority)
    SELECT DISTINCT ON (job_id_extracted)
        SPLIT_PART(sc.code_text, '_', 1) || '_' || SPLIT_PART(sc.code_text, '_', 2) as job_id_extracted,
        (jsonb_array_elements_text(sc.operations->'operations'))::text as operation_id,
        scanned_at as latest_completed_at_raw,
        -- Convert to Sydney time for comparison and display
        scanned_at AT TIME ZONE 'Australia/Sydney' as latest_completed_at_local
    FROM scanned_codes sc
    CROSS JOIN LATERAL jsonb_array_elements_text(sc.operations->'operations') as op
    WHERE sc.operations IS NOT NULL
    AND sc.operations::text != '{}'
    AND sc.code_text ~ '^\d+_\d+_\d+$' -- Matches job_id_version_tag format (e.g., "4677_5995_1")
    AND jsonb_array_length(sc.operations->'operations') > 0
    ORDER BY 
        SPLIT_PART(sc.code_text, '_', 1) || '_' || SPLIT_PART(sc.code_text, '_', 2),
        scanned_at AT TIME ZONE 'Australia/Sydney' DESC  -- Latest local time first
)
SELECT 
    jo.job_id,
    COUNT(DISTINCT jo.version_tag) as total_versions,
    COUNT(DISTINCT CASE WHEN jo.completed_at IS NOT NULL THEN jo.version_tag END) as completed_versions,
    -- Use whichever operation has the latest timestamp in local time
    -- This allows reprints (op001 after op002) to be shown correctly
    COALESCE(
        CASE 
            -- Compare local times, not UTC
            WHEN ls.latest_completed_at_local > COALESCE(lo.latest_completed_at_local, '1970-01-01'::timestamp)
            THEN ls.operation_id
            ELSE lo.latest_completed_operation_id
        END,
        lo.latest_completed_operation_id,
        ls.operation_id
    ) as latest_completed_operation_id,
    -- Use the latest timestamp in local time
    GREATEST(
        COALESCE(lo.latest_completed_at_local, '1970-01-01'::timestamp),
        COALESCE(ls.latest_completed_at_local, '1970-01-01'::timestamp)
    ) as latest_completed_at,
    -- Convert earliest_completed_at to Australia/Sydney timezone
    MIN(jo.completed_at AT TIME ZONE 'Australia/Sydney') as earliest_completed_at,
    ARRAY_AGG(DISTINCT jo.version_tag ORDER BY jo.version_tag) as version_tags,
    -- Calculate status based on all completed operations (using the function)
    -- This still uses sequence priority for status calculation (which is correct)
    get_status_from_operations(jo.job_id) as status
FROM job_operations jo
LEFT JOIN latest_operations lo ON jo.job_id = lo.job_id
LEFT JOIN latest_scanned_operations ls ON jo.job_id = ls.job_id_extracted
GROUP BY jo.job_id, lo.latest_completed_operation_id, lo.latest_completed_at_local, ls.operation_id, ls.latest_completed_at_local;

COMMENT ON VIEW job_status_view IS 'Pre-computed view of job status grouped by job_id. latest_completed_operation_id shows the actual latest operation by timestamp in local time (Australia/Sydney), allowing reprints to be shown correctly. Status is calculated using operation sequence priority via get_status_from_operations(). All timestamps are displayed in Australia/Sydney timezone.';

