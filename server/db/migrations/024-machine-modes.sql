-- Preset operation bundles per press (Ticket). FK to scheduler.Machine only — no legacy public.machines.

CREATE TABLE IF NOT EXISTS machine_modes (
    mode_id SERIAL PRIMARY KEY,
    machine_id TEXT NOT NULL,
    label TEXT NOT NULL,
    operation_ids TEXT[] NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (machine_id, label)
);

CREATE INDEX IF NOT EXISTS idx_machine_modes_machine_id ON machine_modes (machine_id);

-- Ensure FK targets scheduler."Machine" (idempotent if already migrated).
ALTER TABLE machine_modes DROP CONSTRAINT IF EXISTS machine_modes_machine_id_fkey;

DO $$
BEGIN
  ALTER TABLE machine_modes
    ADD CONSTRAINT machine_modes_machine_id_fkey
    FOREIGN KEY (machine_id) REFERENCES scheduler."Machine"(id) ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE machine_modes IS 'Preset lists of scheduler.Operation.id (op001…) for Ticket / scans; optional.';
