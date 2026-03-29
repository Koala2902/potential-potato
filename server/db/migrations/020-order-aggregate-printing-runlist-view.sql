-- View: order_id + printing aggregate status + runlist_id (one row per distinct triple)
-- Depends on: order_aggregate_printing_status, imposition_file_mapping, production_planner_paths
-- LOGS DATABASE

CREATE OR REPLACE VIEW order_printing_status_by_runlist AS
SELECT DISTINCT
  oaps.order_id,
  oaps.job_status AS status,
  ppp.runlist_id
FROM order_aggregate_printing_status oaps
INNER JOIN imposition_file_mapping m
  ON (
    CASE
      WHEN m.file_id ~~ 'FILE_%'::text THEN split_part(m.file_id, '_'::text, 4)
      WHEN m.file_id ~~ 'Labex_%'::text THEN split_part(m.file_id, '_'::text, 2)
      ELSE NULL::text
    END
  ) = oaps.order_id
INNER JOIN production_planner_paths ppp ON m.imposition_id = ppp.imposition_id
WHERE ppp.runlist_id IS NOT NULL;

COMMENT ON VIEW order_printing_status_by_runlist IS
  'One row per distinct (order_id, job_status from order_aggregate_printing_status, runlist_id). '
  'Joins aggregate printing status to planner runlists via imposition_file_mapping.';
