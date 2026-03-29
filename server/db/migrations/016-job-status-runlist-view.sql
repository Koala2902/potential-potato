-- Migration: Job status + runlist as SQL views (aggregate join pattern, like production queue by runlist)
-- Date: 2025-03-25
-- Description: Maps imposition file_id -> job_id + runlist_id in Postgres, then joins job_status_view
--              so /api/jobs uses one query instead of many batched LIKE lookups.

-- ============================================================================
-- LOGS DATABASE
-- ============================================================================

DROP VIEW IF EXISTS job_status_runlist_view CASCADE;
DROP VIEW IF EXISTS job_runlist_from_imposition CASCADE;
DROP FUNCTION IF EXISTS extract_job_id_from_labex_file(text) CASCADE;

-- Mirrors TypeScript parseFileId() in server/db/jobmanager-queries.ts
CREATE OR REPLACE FUNCTION extract_job_id_from_labex_file(file_id text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  m text[];
  after_labex text;
  parts text[];
  i int;
  numeric_parts text[] := ARRAY[]::text[];
BEGIN
  IF file_id IS NULL OR file_id !~* 'labex' THEN
    RETURN NULL;
  END IF;
  m := regexp_match(file_id, '^FILE_(\d+)_Labex_(.+)$', 'i');
  IF m IS NULL THEN
    RETURN NULL;
  END IF;
  after_labex := m[2];
  parts := string_to_array(after_labex, '_');
  IF parts IS NULL OR array_length(parts, 1) IS NULL THEN
    RETURN NULL;
  END IF;
  FOR i IN 1..array_length(parts, 1) LOOP
    IF parts[i] ~ '^[0-9]+$' THEN
      numeric_parts := array_append(numeric_parts, parts[i]);
    ELSE
      EXIT;
    END IF;
  END LOOP;
  IF array_length(numeric_parts, 1) >= 2 THEN
    RETURN array_to_string(numeric_parts, '_');
  ELSIF array_length(numeric_parts, 1) = 1 THEN
    RETURN numeric_parts[1];
  ELSIF array_length(parts, 1) >= 2 THEN
    RETURN array_to_string(
      parts[1 : GREATEST(1, array_length(parts, 1) - 1)],
      '_'
    );
  ELSE
    RETURN after_labex;
  END IF;
END;
$$;

COMMENT ON FUNCTION extract_job_id_from_labex_file(text) IS
  'Parses Labex-style file_id to job_id (same rules as parseFileId in jobmanager-queries.ts).';

-- Distinct (job_id, version_tag, runlist_id) from planner + imposition mapping — aggregate layer
CREATE OR REPLACE VIEW job_runlist_from_imposition AS
SELECT DISTINCT
  extract_job_id_from_labex_file(ifm.file_id) AS job_id,
  (regexp_match(ifm.file_id, '^FILE_(\d+)_Labex_', 'i'))[1] AS version_tag,
  ppp.runlist_id
FROM imposition_file_mapping ifm
INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
WHERE ppp.runlist_id IS NOT NULL
  AND ifm.file_id ~* 'labex'
  AND extract_job_id_from_labex_file(ifm.file_id) IS NOT NULL
  AND (regexp_match(ifm.file_id, '^FILE_(\d+)_Labex_', 'i')) IS NOT NULL;

COMMENT ON VIEW job_runlist_from_imposition IS
  'Distinct job_id + version_tag + runlist_id from imposition_file_mapping x production_planner_paths.';

-- One row per (job, runlist); jobs with no matching runlist get runlist_id NULL (LEFT JOIN LATERAL)
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
  'job_status_view expanded with runlist_id from job_runlist_from_imposition; primary data source for GET /api/jobs.';
