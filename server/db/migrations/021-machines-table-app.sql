-- Legacy `machines` table for /api/machines (public schema on APP database).
-- Column types match jobmanager.public.machines (see migrate-jobmanager-tables).
CREATE TABLE IF NOT EXISTS machines (
    machine_id TEXT PRIMARY KEY,
    machine_name TEXT,
    machine_type TEXT,
    capabilities TEXT,
    hourly_rate_aud NUMERIC,
    max_web_width_mm INTEGER,
    availability_status TEXT DEFAULT 'available',
    maintenance_schedule TEXT,
    shift_hours INTEGER DEFAULT 8
);

CREATE INDEX IF NOT EXISTS idx_machines_availability
ON machines (availability_status)
WHERE availability_status IS NOT NULL;
