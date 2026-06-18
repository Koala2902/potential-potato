-- completed_at must use the same matching rules as started_at (same ordered_scans + 30h window).
-- If MAX(windowed) is ever NULL while first_at is set, COALESCE to first_at so end mirrors start
-- (single scan → same timestamp; avoids NULL operation_completed_at while operation_started_at is set).

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
        a.first_at::timestamp,
        a.last_at::timestamp,
        COALESCE(a.cnt, 0),
        COALESCE(a.cnt, 0),
        COALESCE(a.cnt, 0)
    FROM agg a;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_operation_duration(TEXT, TEXT, TEXT, INTEGER) IS
'Start = MIN(matching scans); end = MAX(same scans within 30h of start), or same as start if only one. Composite Labex job_id (5510_7110) + FILE version matches device Labex_5510_7110_* scans.';

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
    GROUP BY sc.machine_id
    ORDER BY COUNT(*) DESC
    LIMIT 1;

    RETURN machine_id_val;
END;
$$ LANGUAGE plpgsql;
