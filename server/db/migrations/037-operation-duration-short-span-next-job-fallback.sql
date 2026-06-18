-- Extend next-job fallback: use first scan of a different job as completed_at when either
-- (1) exactly one matching scan for this job/op, or
-- (2) raw windowed duration is under 10 seconds (multiple quick scans still often bogus).

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
        SELECT sc.scanned_at, sc.machine_id
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
    tot AS (
        SELECT COUNT(*)::int AS total_matching FROM ordered_scans
    ),
    first_detail AS (
        SELECT scanned_at AS first_at, machine_id AS first_machine_id
        FROM ordered_scans
        ORDER BY scanned_at ASC NULLS LAST
        LIMIT 1
    ),
    windowed AS (
        SELECT os.scanned_at
        FROM ordered_scans os
        CROSS JOIN first_detail fd
        WHERE fd.first_at IS NOT NULL
        AND os.scanned_at <= fd.first_at + (batch_window_seconds * interval '1 second')
    ),
    agg AS (
        SELECT
            fd.first_at,
            COALESCE(
                (SELECT MAX(w.scanned_at) FROM windowed w),
                fd.first_at
            ) AS last_at,
            (SELECT COUNT(*)::int FROM windowed w) AS cnt,
            fd.first_machine_id,
            tot.total_matching
        FROM first_detail fd
        CROSS JOIN tot
    ),
    next_fallback AS (
        SELECT MIN(sc.scanned_at) AS next_at
        FROM scanned_codes sc
        CROSS JOIN agg a
        WHERE a.first_at IS NOT NULL
        AND (
            a.total_matching = 1
            OR EXTRACT(EPOCH FROM (a.last_at - a.first_at))::integer < 10
        )
        AND sc.scanned_at > a.first_at
        AND sc.operations IS NOT NULL
        AND sc.operations::text != '{}'
        AND NOT (
            sc.code_text LIKE job_id_param || '\_' || version_tag_param || '%' ESCAPE '\'
            OR sc.code_text LIKE 'FILE\_%\_Labex\_' || job_id_param || '\_%' ESCAPE '\'
            OR sc.code_text ILIKE 'Labex\_' || job_id_param || '\_' || version_tag_param || '%' ESCAPE '\'
            OR (
                job_id_param ~ '^[0-9]+(_[0-9]+)+$'
                AND sc.code_text ILIKE 'Labex\_' || job_id_param || '\_%' ESCAPE '\'
            )
        )
        AND (
            a.first_machine_id IS NULL
            OR sc.machine_id = a.first_machine_id
        )
    ),
    resolved AS (
        SELECT
            a.first_at,
            CASE
                WHEN nf.next_at IS NOT NULL
                     AND (
                         a.total_matching = 1
                         OR EXTRACT(EPOCH FROM (a.last_at - a.first_at))::integer < 10
                     )
                THEN nf.next_at
                ELSE a.last_at
            END AS last_at,
            a.cnt
        FROM agg a
        CROSS JOIN next_fallback nf
    )
    SELECT
        CASE
            WHEN r.first_at IS NOT NULL AND r.last_at IS NOT NULL THEN
                EXTRACT(EPOCH FROM (r.last_at - r.first_at))::integer
            ELSE NULL
        END,
        (r.first_at AT TIME ZONE 'UTC'),
        (r.last_at AT TIME ZONE 'UTC'),
        COALESCE(r.cnt, 0),
        COALESCE(r.cnt, 0),
        COALESCE(r.cnt, 0)
    FROM resolved r;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_operation_duration(TEXT, TEXT, TEXT, INTEGER) IS
'Start/end from scanned_codes (timestamptz). Same-machine 30h window; UTC-naive timestamps. If one matching scan OR windowed span < 10s, completed_at falls back to earliest later scan for a different job (same machine when known).';
