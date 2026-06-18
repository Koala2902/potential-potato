-- Shared manual lane overrides for JobPage drag/drop across devices.
-- Applied on pipeline DB (logs in dual-DB mode, app DB in single-DB mode).

CREATE TABLE IF NOT EXISTS public.job_lane_overrides (
  job_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'job_page',
  actor TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  CONSTRAINT job_lane_overrides_operation_check
    CHECK (LOWER(operation_id) IN ('op001', 'op002', 'op003', 'op004'))
);

CREATE INDEX IF NOT EXISTS job_lane_overrides_expires_at_idx
  ON public.job_lane_overrides (expires_at);

-- Best-effort cleanup (keeps table compact without needing scheduler jobs).
DELETE FROM public.job_lane_overrides
WHERE expires_at <= NOW();
