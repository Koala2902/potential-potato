-- Migration: Add operation duration tracking (separate table)
-- Date: 2025-01-XX
-- Description: Create separate table for tracking operation durations by grouping scans into batches
--              A job can be scanned 2-10 times within 30 seconds (start and end of batches)

-- ============================================================================
-- LOGS DATABASE
-- ============================================================================

-- Create job_operation_duration table for tracking operation durations
CREATE TABLE IF NOT EXISTS job_operation_duration (
    job_operation_duration_id SERIAL PRIMARY KEY,
    job_id TEXT NOT NULL,
    version_tag TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    machine_id VARCHAR,
    operation_duration_seconds INTEGER,
    operation_started_at TIMESTAMP,
    operation_completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    -- Unique constraint to prevent duplicates
    UNIQUE(job_id, version_tag, operation_id)
);

-- Add indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_job_operation_duration_job 
ON job_operation_duration(job_id, version_tag);

CREATE INDEX IF NOT EXISTS idx_job_operation_duration_operation 
ON job_operation_duration(operation_id);

CREATE INDEX IF NOT EXISTS idx_job_operation_duration_machine 
ON job_operation_duration(machine_id) 
WHERE machine_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_job_operation_duration_duration 
ON job_operation_duration(operation_duration_seconds) 
WHERE operation_duration_seconds IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_job_operation_duration_time_range 
ON job_operation_duration(operation_started_at, operation_completed_at) 
WHERE operation_started_at IS NOT NULL AND operation_completed_at IS NOT NULL;

-- Add comment
COMMENT ON TABLE job_operation_duration IS 'Tracks operation durations by grouping scans into batches. First batch = START, second batch (after gap) = END. Duration calculated between START and END batches.';

-- ============================================================================
-- Function: Calculate operation duration from scanned_codes
-- ============================================================================

-- Function to calculate operation duration for a specific job/operation
-- Groups scans into batches (scans within 20-30 seconds = one batch)
-- First batch = START, Second batch (after gap) = END
-- Returns duration between START batch and END batch
CREATE OR REPLACE FUNCTION calculate_operation_duration(
    job_id_param TEXT,
    version_tag_param TEXT,
    operation_id_param TEXT,
    batch_window_seconds INTEGER DEFAULT 30
)
RETURNS TABLE (
    duration_seconds INTEGER,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    scan_count INTEGER,
    start_batch_size INTEGER,
    end_batch_size INTEGER
) AS $$
DECLARE
    start_batch_start TIMESTAMP;
    start_batch_end TIMESTAMP;
    end_batch_start TIMESTAMP;
    end_batch_end TIMESTAMP;
    total_scan_count INTEGER;
    start_batch_count INTEGER;
    end_batch_count INTEGER;
    duration INTEGER;
BEGIN
    -- Get all scans for this job/operation, ordered by time
    -- Group scans into batches: scans within batch_window_seconds are in the same batch
    WITH ordered_scans AS (
        SELECT 
            sc.scanned_at,
            ROW_NUMBER() OVER (ORDER BY sc.scanned_at) as scan_num
        FROM scanned_codes sc
        WHERE sc.operations IS NOT NULL
        AND sc.operations::text != '{}'
        AND (
            -- Pattern 1: Direct job_id_version_tag match
            sc.code_text LIKE job_id_param || '\_' || version_tag_param || '%' ESCAPE '\'
            OR
            -- Pattern 2: FILE_*_Labex_job_id_* pattern
            sc.code_text LIKE 'FILE\_%\_Labex\_' || job_id_param || '\_%' ESCAPE '\'
        )
        AND (
            -- Check if the operation_id is in the operations JSONB
            sc.operations::text LIKE '%"' || operation_id_param || '"%'
            OR (sc.operations->>operation_id_param)::boolean = true
            OR EXISTS (
                SELECT 1 
                FROM jsonb_array_elements_text(
                    COALESCE(sc.operations->'operations', '[]'::jsonb)
                ) AS op
                WHERE op.value = operation_id_param
            )
        )
        ORDER BY sc.scanned_at
    ),
    -- Calculate time differences first (avoid nested window functions)
    time_diffs AS (
        SELECT 
            scanned_at,
            scan_num,
            CASE 
                WHEN scan_num = 1 THEN 0
                ELSE EXTRACT(EPOCH FROM (scanned_at - LAG(scanned_at) OVER (ORDER BY scanned_at)))
            END as seconds_since_previous
        FROM ordered_scans
    ),
    -- Assign batch numbers: new batch starts when gap > batch_window_seconds
    batches AS (
        SELECT 
            scanned_at,
            scan_num,
            seconds_since_previous,
            -- Assign batch number: increment when gap > batch_window_seconds
            SUM(CASE 
                WHEN scan_num = 1 THEN 1
                WHEN seconds_since_previous > batch_window_seconds THEN 1
                ELSE 0
            END) OVER (ORDER BY scanned_at ROWS UNBOUNDED PRECEDING) as batch_num
        FROM time_diffs
    ),
    -- Get batch statistics
    batch_stats AS (
        SELECT 
            batch_num,
            MIN(scanned_at) as batch_start,
            MAX(scanned_at) as batch_end,
            COUNT(*) as batch_size
        FROM batches
        GROUP BY batch_num
        ORDER BY batch_num
    )
    SELECT 
        -- First batch = START
        MIN(CASE WHEN batch_num = 1 THEN batch_start END),
        MIN(CASE WHEN batch_num = 1 THEN batch_end END),
        -- Second batch = END (if exists)
        MIN(CASE WHEN batch_num = 2 THEN batch_start END),
        MIN(CASE WHEN batch_num = 2 THEN batch_end END),
        -- Counts
        COUNT(*),
        MAX(CASE WHEN batch_num = 1 THEN batch_size END),
        MAX(CASE WHEN batch_num = 2 THEN batch_size END)
    INTO 
        start_batch_start,
        start_batch_end,
        end_batch_start,
        end_batch_end,
        total_scan_count,
        start_batch_count,
        end_batch_count
    FROM batch_stats;
    
    -- Calculate duration: time between START batch and END batch
    -- If only one batch exists, we can't calculate duration yet (job not finished)
    IF start_batch_start IS NOT NULL AND end_batch_start IS NOT NULL THEN
        -- Duration = time from start of first batch to start of second batch
        -- OR time from end of first batch to end of second batch
        -- Using start of batches for consistency
        duration := EXTRACT(EPOCH FROM (end_batch_start - start_batch_start))::INTEGER;
    ELSIF start_batch_start IS NOT NULL THEN
        -- Only start batch exists - job in progress, no duration yet
        duration := NULL;
        end_batch_start := NULL;
        end_batch_end := NULL;
        end_batch_count := 0;
    ELSE
        -- No scans found
        duration := NULL;
        start_batch_start := NULL;
        start_batch_end := NULL;
        end_batch_start := NULL;
        end_batch_end := NULL;
        total_scan_count := 0;
        start_batch_count := 0;
        end_batch_count := 0;
    END IF;
    
    -- Return: duration, start time (first batch start), end time (second batch start), total scans
    RETURN QUERY SELECT 
        duration,
        start_batch_start as started_at,
        end_batch_start as completed_at,  -- Use start of end batch as completion time
        total_scan_count,
        COALESCE(start_batch_count, 0),
        COALESCE(end_batch_count, 0);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_operation_duration(TEXT, TEXT, TEXT, INTEGER) IS 
'Calculates operation duration by grouping scans into batches (scans within batch_window_seconds = one batch). First batch = START, second batch (after gap) = END. Returns duration between START and END batches, start time, end time, total scan count, and batch sizes. Uses 30 second window by default.';

-- ============================================================================
-- Function: Get machine_id from scanned_codes for a job/operation
-- ============================================================================

CREATE OR REPLACE FUNCTION get_operation_machine_id(
    job_id_param TEXT,
    version_tag_param TEXT,
    operation_id_param TEXT
)
RETURNS VARCHAR AS $$
DECLARE
    machine_id_val VARCHAR;
BEGIN
    -- Get the most common machine_id from scans for this job/operation
    SELECT sc.machine_id INTO machine_id_val
    FROM scanned_codes sc
    WHERE sc.operations IS NOT NULL
    AND sc.operations::text != '{}'
    AND sc.machine_id IS NOT NULL
    AND (
        sc.code_text LIKE job_id_param || '\_' || version_tag_param || '%' ESCAPE '\'
        OR sc.code_text LIKE 'FILE\_%\_Labex\_' || job_id_param || '\_%' ESCAPE '\'
    )
    AND (
        sc.operations::text LIKE '%"' || operation_id_param || '"%'
        OR (sc.operations->>operation_id_param)::boolean = true
        OR EXISTS (
            SELECT 1 
            FROM jsonb_array_elements_text(
                COALESCE(sc.operations->'operations', '[]'::jsonb)
            ) AS op
            WHERE op.value = operation_id_param
        )
    )
    GROUP BY sc.machine_id
    ORDER BY COUNT(*) DESC
    LIMIT 1;
    
    RETURN machine_id_val;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_operation_machine_id(TEXT, TEXT, TEXT) IS 
'Gets the most common machine_id from scanned_codes for a specific job/version/operation.';

-- ============================================================================
-- Function: Update operation duration in job_operation_duration table
-- ============================================================================

CREATE OR REPLACE FUNCTION update_operation_duration(
    job_id_param TEXT,
    version_tag_param TEXT,
    operation_id_param TEXT
)
RETURNS VOID AS $$
DECLARE
    duration_result RECORD;
    machine_id_val VARCHAR;
BEGIN
    -- Calculate duration from scanned_codes
    SELECT * INTO duration_result
    FROM calculate_operation_duration(job_id_param, version_tag_param, operation_id_param);
    
    -- Get machine_id from scanned_codes
    machine_id_val := get_operation_machine_id(job_id_param, version_tag_param, operation_id_param);
    
    -- Insert or update job_operation_duration record
    INSERT INTO job_operation_duration (
        job_id,
        version_tag,
        operation_id,
        machine_id,
        operation_duration_seconds,
        operation_started_at,
        operation_completed_at,
        updated_at
    )
    VALUES (
        job_id_param,
        version_tag_param,
        operation_id_param,
        machine_id_val,
        duration_result.duration_seconds,
        duration_result.started_at,
        duration_result.completed_at,
        NOW()
    )
    ON CONFLICT (job_id, version_tag, operation_id) DO UPDATE SET
        machine_id = COALESCE(EXCLUDED.machine_id, job_operation_duration.machine_id),
        operation_duration_seconds = EXCLUDED.operation_duration_seconds,
        operation_started_at = EXCLUDED.operation_started_at,
        operation_completed_at = EXCLUDED.operation_completed_at,
        updated_at = NOW();
    
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_operation_duration(TEXT, TEXT, TEXT) IS 
'Updates job_operation_duration table with calculated duration, start time, end time, and machine_id based on scanned_codes data. Creates row if it doesn''t exist.';

-- ============================================================================
-- Function: Update operation duration from Print OS (for op001 only)
-- ============================================================================

CREATE OR REPLACE FUNCTION update_operation_duration_from_print_os(
    job_id_param TEXT,
    version_tag_param TEXT,
    operation_id_param TEXT,
    print_os_source_id BIGINT
)
RETURNS VOID AS $$
DECLARE
    print_os_record RECORD;
    duration_seconds INTEGER;
    started_at TIMESTAMP;
    completed_at TIMESTAMP;
    machine_id_val VARCHAR;
BEGIN
    -- Get Print OS record from jobmanager database
    -- Note: This function runs in logs database, so we need to use dblink or handle this differently
    -- For now, we'll expect the duration to be passed or calculated elsewhere
    -- This is a placeholder - actual implementation may need to query jobmanager database
    
    -- Try to get Print OS data via job_operations source_id
    -- The source_id should be the print_os.id
    SELECT 
        jo.completed_at as print_completed_at
    INTO print_os_record
    FROM job_operations jo
    WHERE jo.job_id = job_id_param
    AND jo.version_tag = version_tag_param
    AND jo.operation_id = operation_id_param
    AND jo.completed_by = 'print_os'
    AND jo.source_id::text = print_os_source_id::text
    ORDER BY jo.completed_at DESC
    LIMIT 1;
    
    -- If we found a record, we can use completed_at as the end time
    -- But we still need duration from Print OS payload
    -- For now, we'll set duration to NULL and let it be populated by a separate process
    -- that queries Print OS table directly
    
    -- This function will be called from TypeScript code that has access to Print OS payload
    -- So we'll leave duration_seconds as NULL for now - it will be updated by the calling code
    
    -- Insert or update job_operation_duration record
    -- Duration will be NULL initially, to be filled by the calling TypeScript code
    INSERT INTO job_operation_duration (
        job_id,
        version_tag,
        operation_id,
        machine_id,
        operation_duration_seconds,
        operation_started_at,
        operation_completed_at,
        updated_at
    )
    VALUES (
        job_id_param,
        version_tag_param,
        operation_id_param,
        NULL, -- Machine ID not available from Print OS
        NULL, -- Duration will be set by TypeScript code that calls this
        NULL, -- Start time will be set by TypeScript code
        print_os_record.print_completed_at, -- Use completed_at from job_operations
        NOW()
    )
    ON CONFLICT (job_id, version_tag, operation_id) DO UPDATE SET
        operation_completed_at = COALESCE(EXCLUDED.operation_completed_at, job_operation_duration.operation_completed_at),
        updated_at = NOW();
    
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_operation_duration_from_print_os(TEXT, TEXT, TEXT, BIGINT) IS 
'Placeholder function for updating op001 duration from Print OS. Duration should be extracted from Print OS payload by calling code and stored directly.';

-- ============================================================================
-- View: Job operations with calculated durations
-- ============================================================================

-- Create a view that shows job operations with calculated durations
-- This view joins job_operations with job_operation_duration
CREATE OR REPLACE VIEW job_operations_with_duration AS
SELECT 
    jo.*,
    COALESCE(
        jod.operation_duration_seconds,
        calc.duration_seconds
    ) as calculated_duration_seconds,
    COALESCE(
        jod.operation_started_at,
        calc.started_at
    ) as calculated_started_at,
    COALESCE(
        jod.operation_completed_at,
        calc.completed_at
    ) as calculated_completed_at,
    jod.machine_id as operation_machine_id,
    calc.scan_count as calculated_scan_count,
    calc.start_batch_size,
    calc.end_batch_size
FROM job_operations jo
LEFT JOIN job_operation_duration jod 
    ON jo.job_id = jod.job_id 
    AND jo.version_tag = jod.version_tag 
    AND jo.operation_id = jod.operation_id
LEFT JOIN LATERAL calculate_operation_duration(jo.job_id, jo.version_tag, jo.operation_id) calc ON true;

COMMENT ON VIEW job_operations_with_duration IS 
'View showing job_operations with operation durations from job_operation_duration table. Uses stored values if available, otherwise calculates from scanned_codes on-the-fly.';
