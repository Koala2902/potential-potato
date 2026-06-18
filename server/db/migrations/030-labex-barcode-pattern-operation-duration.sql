-- Match barcodes like Labex_4920_6306_... (ticket / device format) in addition to
-- 4920_6306_... and FILE_*_Labex_4920_*. Without this, calculate_operation_duration
-- sees zero scans, operation_completed_at stays NULL, and Production Overview stays "processing".

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
    WITH ordered_scans AS (
        SELECT
            sc.scanned_at,
            ROW_NUMBER() OVER (ORDER BY sc.scanned_at) as scan_num
        FROM scanned_codes sc
        WHERE sc.operations IS NOT NULL
        AND sc.operations::text != '{}'
        AND (
            sc.code_text LIKE job_id_param || '\_' || version_tag_param || '%' ESCAPE '\'
            OR
            sc.code_text LIKE 'FILE\_%\_Labex\_' || job_id_param || '\_%' ESCAPE '\'
            OR
            sc.code_text ILIKE 'Labex\_' || job_id_param || '\_' || version_tag_param || '%' ESCAPE '\'
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
        ORDER BY sc.scanned_at
    ),
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
    batches AS (
        SELECT
            scanned_at,
            scan_num,
            seconds_since_previous,
            SUM(CASE
                WHEN scan_num = 1 THEN 1
                WHEN seconds_since_previous > batch_window_seconds THEN 1
                ELSE 0
            END) OVER (ORDER BY scanned_at ROWS UNBOUNDED PRECEDING) as batch_num
        FROM time_diffs
    ),
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
        MIN(CASE WHEN batch_num = 1 THEN batch_start END),
        MIN(CASE WHEN batch_num = 1 THEN batch_end END),
        MIN(CASE WHEN batch_num = 2 THEN batch_start END),
        MIN(CASE WHEN batch_num = 2 THEN batch_end END),
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

    IF start_batch_start IS NOT NULL AND end_batch_start IS NOT NULL THEN
        duration := EXTRACT(EPOCH FROM (end_batch_start - start_batch_start))::INTEGER;
    ELSIF start_batch_start IS NOT NULL THEN
        duration := NULL;
        end_batch_start := NULL;
        end_batch_end := NULL;
        end_batch_count := 0;
    ELSE
        duration := NULL;
        start_batch_start := NULL;
        start_batch_end := NULL;
        end_batch_start := NULL;
        end_batch_end := NULL;
        total_scan_count := 0;
        start_batch_count := 0;
        end_batch_count := 0;
    END IF;

    RETURN QUERY SELECT
        duration,
        start_batch_start as started_at,
        end_batch_start as completed_at,
        total_scan_count,
        COALESCE(start_batch_count, 0),
        COALESCE(end_batch_count, 0);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_operation_duration(TEXT, TEXT, TEXT, INTEGER) IS
'Duration from scanned_codes batches. Matches job_id_version, FILE_*_Labex_job_id_*, and Labex_job_id_version_* barcodes.';

CREATE OR REPLACE FUNCTION get_operation_machine_id(
    job_id_param TEXT,
    version_tag_param TEXT,
    operation_id_param TEXT
)
RETURNS VARCHAR AS $$
DECLARE
    machine_id_val VARCHAR;
BEGIN
    SELECT sc.machine_id INTO machine_id_val
    FROM scanned_codes sc
    WHERE sc.operations IS NOT NULL
    AND sc.operations::text != '{}'
    AND sc.machine_id IS NOT NULL
    AND (
        sc.code_text LIKE job_id_param || '\_' || version_tag_param || '%' ESCAPE '\'
        OR sc.code_text LIKE 'FILE\_%\_Labex\_' || job_id_param || '\_%' ESCAPE '\'
        OR sc.code_text ILIKE 'Labex\_' || job_id_param || '\_' || version_tag_param || '%' ESCAPE '\'
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
