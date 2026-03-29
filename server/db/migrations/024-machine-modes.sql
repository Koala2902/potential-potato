-- Preset operation bundles per machine (Ticket "modes"). When rows exist for a machine,
-- the UI can offer modes; each mode lists legacy operation_ids (lowercase op001…) from public.operations.

CREATE TABLE IF NOT EXISTS machine_modes (
    mode_id SERIAL PRIMARY KEY,
    machine_id TEXT NOT NULL REFERENCES machines (machine_id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    operation_ids TEXT[] NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (machine_id, label)
);

CREATE INDEX IF NOT EXISTS idx_machine_modes_machine_id ON machine_modes (machine_id);

COMMENT ON TABLE machine_modes IS 'Preset lists of public.operations.operation_id for Ticket / scans; optional.';
