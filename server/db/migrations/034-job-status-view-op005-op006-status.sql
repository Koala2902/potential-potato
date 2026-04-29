-- Migration: extend job_status_view status mapping for op005/op006
-- Date: 2026-04-29
-- LOGS DATABASE (or app DB in single-DB mode via run-migrations pipe target)
-- Changes:
--   - op005 contributes to digital_cut
--   - op006 contributes to slitter
--   - scanned operation flags include op005/op006

DROP VIEW IF EXISTS job_status_runlist_view CASCADE;
DROP VIEW IF EXISTS job_status_view CASCADE;

CREATE VIEW job_status_view AS
WITH job_ops_flags AS (
  SELECT
    job_id,
    BOOL_OR(LOWER(operation_id) = 'op001' AND completed_at IS NOT NULL) AS jo_op001,
    BOOL_OR(LOWER(operation_id) = 'op002' AND completed_at IS NOT NULL) AS jo_op002,
    BOOL_OR(LOWER(operation_id) = 'op003' AND completed_at IS NOT NULL) AS jo_op003,
    BOOL_OR(LOWER(operation_id) = 'op004' AND completed_at IS NOT NULL) AS jo_op004,
    BOOL_OR(LOWER(operation_id) = 'op005' AND completed_at IS NOT NULL) AS jo_op005,
    BOOL_OR(LOWER(operation_id) = 'op006' AND completed_at IS NOT NULL) AS jo_op006
  FROM job_operations
  GROUP BY job_id
),
scanned_hits AS (
  SELECT DISTINCT
    SPLIT_PART(sc.code_text, '_', 1) || '_' || SPLIT_PART(sc.code_text, '_', 2) AS job_id,
    lower(trim(op_elem::text)) AS op_id
  FROM scanned_codes sc
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(sc.operations->'operations', '[]'::jsonb)) AS op_elem
  WHERE sc.code_type = 'job_op'
    AND sc.operations IS NOT NULL
    AND sc.operations::text <> '{}'
    AND jsonb_array_length(COALESCE(sc.operations->'operations', '[]'::jsonb)) > 0
    AND lower(trim(op_elem::text)) IN ('op001', 'op002', 'op003', 'op004', 'op005', 'op006')

  UNION ALL

  SELECT DISTINCT
    extract_job_id_from_labex_file(sc.code_text) AS job_id,
    lower(trim(op_elem::text)) AS op_id
  FROM scanned_codes sc
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(sc.operations->'operations', '[]'::jsonb)) AS op_elem
  WHERE sc.code_type = 'other'
    AND sc.operations IS NOT NULL
    AND sc.operations::text <> '{}'
    AND jsonb_array_length(COALESCE(sc.operations->'operations', '[]'::jsonb)) > 0
    AND sc.code_text ~* 'labex'
    AND extract_job_id_from_labex_file(sc.code_text) IS NOT NULL
    AND lower(trim(op_elem::text)) IN ('op001', 'op002', 'op003', 'op004', 'op005', 'op006')

  UNION ALL

  SELECT DISTINCT
    extract_job_id_from_labex_file(ifm.file_id) AS job_id,
    lower(trim(op_elem::text)) AS op_id
  FROM scanned_codes sc
  INNER JOIN production_planner_paths ppp ON ppp.runlist_id = sc.code_text
  INNER JOIN imposition_file_mapping ifm ON ppp.imposition_id = ifm.imposition_id
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(sc.operations->'operations', '[]'::jsonb)) AS op_elem
  WHERE sc.operations IS NOT NULL
    AND sc.operations::text <> '{}'
    AND jsonb_array_length(COALESCE(sc.operations->'operations', '[]'::jsonb)) > 0
    AND extract_job_id_from_labex_file(ifm.file_id) IS NOT NULL
    AND lower(trim(op_elem::text)) IN ('op001', 'op002', 'op003', 'op004', 'op005', 'op006')
),
scanned_flags AS (
  SELECT
    job_id,
    BOOL_OR(op_id = 'op001') AS sc_op001,
    BOOL_OR(op_id = 'op002') AS sc_op002,
    BOOL_OR(op_id = 'op003') AS sc_op003,
    BOOL_OR(op_id = 'op004') AS sc_op004,
    BOOL_OR(op_id = 'op005') AS sc_op005,
    BOOL_OR(op_id = 'op006') AS sc_op006
  FROM scanned_hits
  WHERE job_id IS NOT NULL
  GROUP BY job_id
),
latest_operations AS (
  SELECT DISTINCT ON (job_id)
    job_id,
    operation_id AS latest_completed_operation_id,
    completed_at AS latest_completed_at_raw,
    completed_at AT TIME ZONE 'Australia/Sydney' AS latest_completed_at_local
  FROM job_operations
  WHERE completed_at IS NOT NULL
  ORDER BY job_id,
    (completed_at AT TIME ZONE 'Australia/Sydney') DESC
),
latest_scanned_operations AS (
  SELECT DISTINCT ON (job_id_extracted)
    SPLIT_PART(sc.code_text, '_', 1) || '_' || SPLIT_PART(sc.code_text, '_', 2) AS job_id_extracted,
    op_elem::text AS operation_id,
    scanned_at AS latest_completed_at_raw,
    scanned_at AT TIME ZONE 'Australia/Sydney' AS latest_completed_at_local
  FROM scanned_codes sc
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(sc.operations->'operations', '[]'::jsonb)) AS op_elem
  WHERE sc.code_type = 'job_op'
    AND sc.operations IS NOT NULL
    AND sc.operations::text <> '{}'
    AND jsonb_array_length(COALESCE(sc.operations->'operations', '[]'::jsonb)) > 0
  ORDER BY
    SPLIT_PART(sc.code_text, '_', 1) || '_' || SPLIT_PART(sc.code_text, '_', 2),
    (scanned_at AT TIME ZONE 'Australia/Sydney') DESC
)
SELECT
  jo.job_id,
  COUNT(DISTINCT jo.version_tag) AS total_versions,
  COUNT(DISTINCT CASE WHEN jo.completed_at IS NOT NULL THEN jo.version_tag END) AS completed_versions,
  COALESCE(
    CASE
      WHEN ls.latest_completed_at_local > COALESCE(lo.latest_completed_at_local, '1970-01-01'::timestamp)
      THEN ls.operation_id
      ELSE lo.latest_completed_operation_id
    END,
    lo.latest_completed_operation_id,
    ls.operation_id
  ) AS latest_completed_operation_id,
  GREATEST(
    COALESCE(lo.latest_completed_at_local, '1970-01-01'::timestamp),
    COALESCE(ls.latest_completed_at_local, '1970-01-01'::timestamp)
  ) AS latest_completed_at,
  MIN(jo.completed_at AT TIME ZONE 'Australia/Sydney') AS earliest_completed_at,
  ARRAY_AGG(DISTINCT jo.version_tag ORDER BY jo.version_tag) AS version_tags,
  CASE
    WHEN COALESCE(jof.jo_op004, false) OR COALESCE(sf.sc_op004, false) THEN 'production_finished'
    WHEN COALESCE(jof.jo_op006, false) OR COALESCE(sf.sc_op006, false) THEN 'slitter'
    WHEN (COALESCE(jof.jo_op002, false) OR COALESCE(sf.sc_op002, false))
      AND (COALESCE(jof.jo_op003, false) OR COALESCE(sf.sc_op003, false)) THEN 'slitter'
    WHEN COALESCE(jof.jo_op003, false) OR COALESCE(sf.sc_op003, false) THEN 'slitter'
    WHEN COALESCE(jof.jo_op005, false) OR COALESCE(sf.sc_op005, false) THEN 'digital_cut'
    WHEN COALESCE(jof.jo_op002, false) OR COALESCE(sf.sc_op002, false) THEN 'digital_cut'
    WHEN COALESCE(jof.jo_op001, false) OR COALESCE(sf.sc_op001, false) THEN 'printed'
    ELSE 'print_ready'
  END AS status
FROM job_operations jo
LEFT JOIN latest_operations lo ON jo.job_id = lo.job_id
LEFT JOIN latest_scanned_operations ls ON jo.job_id = ls.job_id_extracted
INNER JOIN job_ops_flags jof ON jo.job_id = jof.job_id
LEFT JOIN scanned_flags sf ON jo.job_id = sf.job_id
GROUP BY
  jo.job_id,
  lo.latest_completed_operation_id,
  lo.latest_completed_at_local,
  ls.operation_id,
  ls.latest_completed_at_local,
  jof.jo_op001,
  jof.jo_op002,
  jof.jo_op003,
  jof.jo_op004,
  jof.jo_op005,
  jof.jo_op006,
  sf.sc_op001,
  sf.sc_op002,
  sf.sc_op003,
  sf.sc_op004,
  sf.sc_op005,
  sf.sc_op006;

COMMENT ON VIEW job_status_view IS
  'Job status: latest op by Sydney-local time; status from inlined op001-op006 flags (job_operations OR scanned_codes). op005 maps to digital_cut and op006 maps to slitter.';

CREATE OR REPLACE VIEW job_status_runlist_view AS
SELECT
  jsv.job_id,
  jsv.total_versions,
  jsv.completed_versions,
  jsv.latest_completed_operation_id,
  jsv.latest_completed_at,
  jsv.earliest_completed_at,
  jsv.version_tags,
  jsv.status,
  m.runlist_id
FROM job_status_view jsv
LEFT JOIN LATERAL (
  SELECT DISTINCT r.runlist_id
  FROM job_runlist_from_imposition r
  WHERE r.job_id = jsv.job_id
    AND r.version_tag = ANY (
      SELECT unnest(COALESCE(jsv.version_tags, ARRAY[]::text[]))
    )
) AS m ON TRUE;

COMMENT ON VIEW job_status_runlist_view IS
  'job_status_view expanded with runlist_id; primary data source for GET /api/jobs.';
