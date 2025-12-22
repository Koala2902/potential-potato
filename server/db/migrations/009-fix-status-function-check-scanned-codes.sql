-- Migration: Fix get_status_from_operations to always check scanned_codes
-- Date: 2025-12-22
-- Description: The function should check scanned_codes for ALL operations, not just when missing from job_operations
--              This ensures newer operations in scanned_codes take priority over older ones in job_operations

-- ============================================================================
-- LOGS DATABASE
-- ============================================================================

-- Update get_status_from_operations function to ALWAYS check scanned_codes
-- This ensures that if a newer operation is scanned but not yet processed into job_operations,
-- it will still be reflected in the status
CREATE OR REPLACE FUNCTION get_status_from_operations(job_id_param TEXT)
RETURNS TEXT AS $$
DECLARE
    has_op001 BOOLEAN := FALSE;
    has_op002 BOOLEAN := FALSE;
    has_op003 BOOLEAN := FALSE;
    has_op004 BOOLEAN := FALSE;
BEGIN
    -- Check which operations have been completed for this job in job_operations
    SELECT 
        BOOL_OR(LOWER(operation_id) = 'op001' AND completed_at IS NOT NULL),
        BOOL_OR(LOWER(operation_id) = 'op002' AND completed_at IS NOT NULL),
        BOOL_OR(LOWER(operation_id) = 'op003' AND completed_at IS NOT NULL),
        BOOL_OR(LOWER(operation_id) = 'op004' AND completed_at IS NOT NULL)
    INTO has_op001, has_op002, has_op003, has_op004
    FROM job_operations
    WHERE job_id = job_id_param;
    
    -- ALWAYS check scanned_codes table for any scans (even if found in job_operations)
    -- This ensures we capture newer scans even if processing is delayed
    -- Use OR logic so scanned_codes can add operations, not just fill gaps
    has_op001 := has_op001 OR has_scanned_operation(job_id_param, 'op001');
    has_op002 := has_op002 OR has_scanned_operation(job_id_param, 'op002');
    has_op003 := has_op003 OR has_scanned_operation(job_id_param, 'op003');
    has_op004 := has_op004 OR has_scanned_operation(job_id_param, 'op004');
    
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

-- Add comment to function
COMMENT ON FUNCTION get_status_from_operations(TEXT) IS 'Determines job status based on completed operations in job_operations table AND scanned_codes table (both in logs database). ALWAYS checks both sources to ensure all scans are reflected, even if not yet processed into job_operations. Newer operations take priority over older ones.';

