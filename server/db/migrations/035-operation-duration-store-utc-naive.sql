-- job_operation_duration timestamps from scans must be UTC wall-clock naives: GET /api/production-status
-- interprets non-op001 rows as `AT TIME ZONE 'UTC'`. Using `timestamptz::timestamp` followed the *session*
-- TimeZone (e.g. Australia/Perth +8), which shifted relative times (~8h) vs scanned_at (timestamptz).

CREATE OR REPLACE FUNCTION calculate_operation_duration(
    job_id_param TEXT,
    version_tag_param TEXT,
    operation_id_param TEXT,
    batch_window_seconds INTEGER DEFAULT 108000
)
RETURNS TABLE (
    duration_seconds INTEGER,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    scan_count INTEGER,
    start_batch_size INTEGER,
    end_batch_size INTEGER
) AS $$
BEGIN
    RETURN QUERY
    WITH ordered_scans AS (
        SELECT sc.scanned_at
        FROM scanned_codes sc
        WHERE sc.operations IS NOT NULL
        AND sc.operations::text != '{}'
        AND (
            sc.code_text LIKE job_id_param || '\_' || version_tag_param || '%' ESCAPE '\'
            OR sc.code_text LIKE 'FILE\_%\_Labex\_' || job_id_param || '\_%' ESCAPE '\'
            OR sc.code_text ILIKE 'Labex\_' || job_id_param || '\_' || version_tag_param || '%' ESCAPE '\'
            OR (
                job_id_param ~ '^[0-9]+(_[0-9]+)+$'
                AND sc.code_text ILIKE 'Labex\_' || job_id_param || '\_%' ESCAPE '\'
            )
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
    ),
    first_row AS (
        SELECT MIN(scanned_at) AS first_at FROM ordered_scans
    ),
    windowed AS (
        SELECT sc.scanned_at
        FROM ordered_scans sc
        CROSS JOIN first_row fr
        WHERE fr.first_at IS NOT NULL
        AND sc.scanned_at <= fr.first_at + (batch_window_seconds * interval '1 second')
    ),
    agg AS (
        SELECT
            fr.first_at,
            COALESCE(
                (SELECT MAX(w.scanned_at) FROM windowed w),
                fr.first_at
            ) AS last_at,
            (SELECT COUNT(*)::int FROM windowed w) AS cnt
        FROM first_row fr
    )
    SELECT
        CASE
            WHEN a.first_at IS NOT NULL AND a.last_at IS NOT NULL THEN
                EXTRACT(EPOCH FROM (a.last_at - a.first_at))::integer
            ELSE NULL
        END,
        (a.first_at AT TIME ZONE 'UTC'),
        (a.last_at AT TIME ZONE 'UTC'),
        COALESCE(a.cnt, 0),
        COALESCE(a.cnt, 0),
        COALESCE(a.cnt, 0)
    FROM agg a;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_operation_duration(TEXT, TEXT, TEXT, INTEGER) IS
'Start/end from scanned_codes (timestamptz). Stores TIMESTAMP as UTC wall clock so production-status AT TIME ZONE ''UTC'' matches op002+ writers.';
