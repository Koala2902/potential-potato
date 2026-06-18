-- Operation duration: start = first matching scan; end = last matching scan within
-- max_span_from_first_scan_seconds of that first scan (default 30 hours). Ignores
-- late reprint scans outside the window so duration does not span days/weeks.

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
            (SELECT MAX(w.scanned_at) FROM windowed w) AS last_at,
            (SELECT COUNT(*)::int FROM windowed w) AS cnt
        FROM first_row fr
    )
    SELECT
        CASE
            WHEN a.first_at IS NOT NULL AND a.last_at IS NOT NULL THEN
                EXTRACT(EPOCH FROM (a.last_at - a.first_at))::integer
            ELSE NULL
        END,
        a.first_at::timestamp,
        a.last_at::timestamp,
        COALESCE(a.cnt, 0),
        COALESCE(a.cnt, 0),
        COALESCE(a.cnt, 0)
    FROM agg a;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_operation_duration(TEXT, TEXT, TEXT, INTEGER) IS
'Duration from scanned_codes: started_at = first scan; completed_at = last scan within batch_window_seconds of first (default 108000 = 30h). Parameter name kept for PG replace compatibility. Scans after that window are ignored (e.g. reprints).';
