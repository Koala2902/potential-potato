/** In-progress lane funnel (excludes finished / op004). */
export const IN_PROGRESS_LANE_FUNNEL_ORDER = ['op001', 'op002', 'op003'] as const;

/**
 * SQL CASE on job_status_view columns → lane id (op001–op004).
 * Keep in sync with laneForJob() in job-operation-lane.ts.
 */
export const JOB_STATUS_VIEW_LANE_SQL = `
CASE
  WHEN LOWER(TRIM(latest_completed_operation_id)) = 'op004' THEN 'op004'
  WHEN LOWER(TRIM(latest_completed_operation_id)) IN ('op003', 'op006') THEN 'op003'
  WHEN LOWER(TRIM(latest_completed_operation_id)) IN ('op002', 'op005') THEN 'op002'
  WHEN LOWER(TRIM(latest_completed_operation_id)) = 'op001' THEN 'op001'
  WHEN status = 'production_finished' THEN 'op004'
  WHEN status = 'slitter' THEN 'op003'
  WHEN status = 'digital_cut' THEN 'op002'
  ELSE 'op001'
END`;

/** WHERE clause aligned with JobPage in-progress jobs. */
export const JOB_STATUS_VIEW_IN_PROGRESS_WHERE_SQL = `
  status != 'production_finished'
  AND latest_completed_operation_id IS NOT NULL
  AND latest_completed_at IS NOT NULL
`;
