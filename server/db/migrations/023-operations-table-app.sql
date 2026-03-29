-- Legacy `operations` (op001… / OP001…) with machine_id link to `machines`.
-- Populated from jobmanager via: npm run migrate-jobmanager-tables

CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY,
    operation_name TEXT,
    machine_id TEXT,
    operation_category TEXT,
    can_run_parallel BOOLEAN DEFAULT false,
    requires_operator BOOLEAN DEFAULT true,
    setup_time_base_minutes REAL DEFAULT 0,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operations_machine_id
ON operations (machine_id)
WHERE machine_id IS NOT NULL;
