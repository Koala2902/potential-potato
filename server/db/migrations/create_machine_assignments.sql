-- Create table to track machine assignments for impositions
CREATE TABLE IF NOT EXISTS imposition_machine_assignments (
    imposition_id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (imposition_id) REFERENCES imposition_configurations(imposition_id) ON DELETE CASCADE
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_imposition_machine_assignments_machine_id 
ON imposition_machine_assignments(machine_id);

CREATE INDEX IF NOT EXISTS idx_imposition_machine_assignments_assigned_at 
ON imposition_machine_assignments(assigned_at);

