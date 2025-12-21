-- Migration: Migrate scanned_codes table from jobmanager to logs database
-- Date: 2025-12-21
-- Description: Copy scanned_codes table structure and data to logs database for easier querying

-- ============================================================================
-- LOGS DATABASE
-- ============================================================================

-- Create scanned_codes table in logs database (same structure as jobmanager)
CREATE TABLE IF NOT EXISTS scanned_codes (
    scan_id SERIAL PRIMARY KEY,
    code_text TEXT NOT NULL,
    scanned_at TIMESTAMP DEFAULT NOW(),
    machine_id VARCHAR,
    user_id VARCHAR,
    operations JSONB,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_scanned_codes_code_text ON scanned_codes(code_text);
CREATE INDEX IF NOT EXISTS idx_scanned_codes_scanned_at ON scanned_codes(scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scanned_codes_machine_id ON scanned_codes(machine_id) WHERE machine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanned_codes_operations ON scanned_codes USING gin(operations) WHERE operations IS NOT NULL;

-- Data migration: Use migrate-scanned-codes-data.ts script to copy data from jobmanager to logs

-- Add comment to table
COMMENT ON TABLE scanned_codes IS 'Scanned codes from barcode scanners. Migrated from jobmanager database for easier querying in job status views.';

-- ============================================================================
-- Update get_status_from_operations to query scanned_codes from logs database
-- ============================================================================

-- Drop the old function that used dblink
DROP FUNCTION IF EXISTS has_scanned_operation(TEXT, TEXT);

-- Create a simpler function that queries scanned_codes directly from logs database
CREATE OR REPLACE FUNCTION has_scanned_operation(job_id_param TEXT, operation_id_param TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    scan_count INTEGER := 0;
BEGIN
    -- Query scanned_codes table directly (now in logs database)
    -- code_text now stores file_ids (e.g., "FILE_1_Labex_4677_5995_...") or job_id_version_tag (e.g., "4677_5995_1")
    SELECT COUNT(*) INTO scan_count
    FROM scanned_codes sc
    WHERE sc.operations IS NOT NULL
    AND sc.operations::text != '{}'
    AND (
        -- Check 1: Direct file_id pattern match (e.g., "FILE_1_Labex_4677_5995_...")
        -- Extract job_id from file_id pattern: FILE_version_Labex_job_id_...
        sc.code_text LIKE 'FILE\_%\_Labex\_' || job_id_param || '\_%' ESCAPE '\'
        OR
        -- Check 2: Direct job_id_version_tag pattern match (e.g., "4677_5995_1")
        sc.code_text LIKE job_id_param || '\_%' ESCAPE '\'
        OR
        -- Check 3: Legacy - Check if code_text is a runlist that contains this job
        -- (for backward compatibility with old scans)
        EXISTS (
            SELECT 1 
            FROM production_planner_paths ppp
            INNER JOIN imposition_file_mapping ifm ON ppp.imposition_id = ifm.imposition_id
            WHERE ppp.runlist_id = sc.code_text
            AND ifm.file_id LIKE 'FILE\_%\_Labex\_' || job_id_param || '\_%' ESCAPE '\'
        )
    )
    AND (
        -- Check if the operation_id is in the operations JSONB
        -- Handle different JSONB structures: {operations: ['op001']} or {op001: true}
        sc.operations::text LIKE '%"' || operation_id_param || '"%'
        OR (sc.operations->>operation_id_param)::boolean = true
        OR EXISTS (
            SELECT 1 
            FROM jsonb_array_elements_text(
                COALESCE(sc.operations->'operations', '[]'::jsonb)
            ) AS op
            WHERE op.value = operation_id_param
        )
    );
    
    RETURN scan_count > 0;
END;
$$ LANGUAGE plpgsql;

-- Update get_status_from_operations function to also check scanned_codes via has_scanned_operation
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
    
    -- Also check scanned_codes table for any scans that might not be processed yet
    -- This ensures we capture scans even if processing is delayed
    IF NOT has_op001 THEN
        has_op001 := has_scanned_operation(job_id_param, 'op001');
    END IF;
    IF NOT has_op002 THEN
        has_op002 := has_scanned_operation(job_id_param, 'op002');
    END IF;
    IF NOT has_op003 THEN
        has_op003 := has_scanned_operation(job_id_param, 'op003');
    END IF;
    IF NOT has_op004 THEN
        has_op004 := has_scanned_operation(job_id_param, 'op004');
    END IF;
    
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

-- Add comments
COMMENT ON FUNCTION get_status_from_operations(TEXT) IS 'Determines job status based on completed operations in job_operations table AND scanned_codes table (both in logs database). Checks both sources to ensure all scans are reflected, even if not yet processed into job_operations.';

COMMENT ON FUNCTION has_scanned_operation(TEXT, TEXT) IS 'Checks if a job has a specific operation scanned in scanned_codes table (logs database). Queries directly without dblink.';

