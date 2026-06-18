CREATE SCHEMA IF NOT EXISTS scheduler;

CREATE TABLE IF NOT EXISTS scheduler.scanner_devices (
    device_id TEXT PRIMARY KEY,
    label TEXT NULL,
    hostname TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    machine_id TEXT NULL REFERENCES scheduler."Machine"(id) ON DELETE SET NULL,
    mode_id TEXT NULL,
    operation_id TEXT NULL,
    notes TEXT NULL,
    last_seen_at TIMESTAMPTZ NULL,
    last_seen_ip TEXT NULL,
    last_scan_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scanner_devices_machine_id
    ON scheduler.scanner_devices(machine_id);

CREATE INDEX IF NOT EXISTS idx_scanner_devices_last_seen_at
    ON scheduler.scanner_devices(last_seen_at DESC);
