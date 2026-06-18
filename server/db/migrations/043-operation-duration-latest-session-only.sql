-- Reliable operation duration from same-job scans only:
--   • Group consecutive scans into sessions; gap > batch_window_seconds starts a new session (timer restart).
--   • Use only the latest session (not first→last across days, not the next job's scan).
--   • started_at / completed_at = MIN / MAX within that session; single scan → 0s duration.

CREATE OR REPLACE FUNCTION calculate_operation_duration(
    job_id_param TEXT,
    version_tag_param TEXT,
    operation_id_param TEXT,
    batch_window_seconds INTEGER DEFAULT 3600
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
    numbered AS (
        SELECT
            scanned_at,
            ROW_NUMBER() OVER (ORDER BY scanned_at ASC NULLS LAST) AS scan_num
        FROM ordered_scans
    ),
    time_diffs AS (
        SELECT
            scanned_at,
            scan_num,
            CASE
                WHEN scan_num = 1 THEN 0::float8
                ELSE EXTRACT(EPOCH FROM (
                    scanned_at - LAG(scanned_at) OVER (ORDER BY scanned_at ASC NULLS LAST)
                ))
            END AS seconds_since_previous
        FROM numbered
    ),
    batched AS (
        SELECT
            scanned_at,
            scan_num,
            SUM(CASE
                WHEN scan_num = 1 THEN 1
                WHEN seconds_since_previous > batch_window_seconds THEN 1
                ELSE 0
            END) OVER (ORDER BY scanned_at ASC NULLS LAST ROWS UNBOUNDED PRECEDING)::int AS batch_num
        FROM time_diffs
    ),
    batch_stats AS (
        SELECT
            batch_num,
            MIN(scanned_at) AS batch_start,
            MAX(scanned_at) AS batch_end,
            COUNT(*)::int AS batch_size
        FROM batched
        GROUP BY batch_num
    ),
    latest_session AS (
        SELECT batch_start, batch_end, batch_size
        FROM batch_stats
        ORDER BY batch_num DESC
        LIMIT 1
    )
    SELECT
        CASE
            WHEN ls.batch_start IS NOT NULL AND ls.batch_end IS NOT NULL THEN
                EXTRACT(EPOCH FROM (ls.batch_end - ls.batch_start))::integer
            ELSE NULL
        END,
        (ls.batch_start AT TIME ZONE 'UTC'),
        (ls.batch_end AT TIME ZONE 'UTC'),
        COALESCE(ls.batch_size, 0),
        COALESCE(ls.batch_size, 0),
        COALESCE(ls.batch_size, 0)
    FROM (SELECT 1) AS _anchor
    LEFT JOIN latest_session ls ON true;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_operation_duration(TEXT, TEXT, TEXT, INTEGER) IS
'Duration from scanned_codes for one job/version/op. Consecutive scans within batch_window_seconds (default 3600s) form a session; a longer gap restarts the timer. Uses only the latest session: started_at = first scan, completed_at = last scan in that session. No next-job fallback. UTC-naive timestamps for op002+.';
