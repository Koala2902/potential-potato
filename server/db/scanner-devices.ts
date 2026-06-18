import { appPool } from "./app-connection.js";

export interface ScannerDeviceRecord {
  deviceId: string;
  label: string | null;
  hostname: string | null;
  enabled: boolean;
  machineId: string | null;
  modeId: string | null;
  operationId: string | null;
  notes: string | null;
  lastSeenAt: string | null;
  lastSeenIp: string | null;
  lastScanAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PatchScannerDeviceRecordInput {
  label?: string | null;
  enabled?: boolean;
  machineId?: string | null;
  modeId?: string | null;
  operationId?: string | null;
  notes?: string | null;
}

type ScannerDeviceRow = {
  device_id: string;
  label: string | null;
  hostname: string | null;
  enabled: boolean;
  machine_id: string | null;
  mode_id: string | null;
  operation_id: string | null;
  notes: string | null;
  last_seen_at: Date | string | null;
  last_seen_ip: string | null;
  last_scan_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

let ensured = false;

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  return s ? s : null;
}

function mapRow(row: ScannerDeviceRow): ScannerDeviceRecord {
  return {
    deviceId: row.device_id,
    label: row.label,
    hostname: row.hostname,
    enabled: Boolean(row.enabled),
    machineId: row.machine_id,
    modeId: row.mode_id,
    operationId: row.operation_id,
    notes: row.notes,
    lastSeenAt: isoOrNull(row.last_seen_at),
    lastSeenIp: row.last_seen_ip,
    lastScanAt: isoOrNull(row.last_scan_at),
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoOrNull(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function cleanNullableString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function ensureScannerDevicesTable(): Promise<void> {
  if (ensured) return;
  const client = await appPool.connect();
  try {
    await client.query(`
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
    `);
    ensured = true;
  } finally {
    client.release();
  }
}

export async function listScannerDevices(): Promise<ScannerDeviceRecord[]> {
  await ensureScannerDevicesTable();
  const result = await appPool.query<ScannerDeviceRow>(
    `
      SELECT *
      FROM scheduler.scanner_devices
      ORDER BY last_seen_at DESC NULLS LAST, device_id ASC
    `
  );
  return result.rows.map(mapRow);
}

export async function getScannerDevice(
  deviceId: string
): Promise<ScannerDeviceRecord | null> {
  await ensureScannerDevicesTable();
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) return null;
  const result = await appPool.query<ScannerDeviceRow>(
    `
      SELECT *
      FROM scheduler.scanner_devices
      WHERE device_id = $1
      LIMIT 1
    `,
    [normalizedDeviceId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function upsertScannerDeviceHeartbeat(input: {
  deviceId: string;
  hostname?: string | null;
  lastSeenIp?: string | null;
}): Promise<ScannerDeviceRecord> {
  await ensureScannerDevicesTable();
  const normalizedDeviceId = input.deviceId.trim();
  if (!normalizedDeviceId) {
    throw new Error("deviceId is required");
  }

  const result = await appPool.query<ScannerDeviceRow>(
    `
      INSERT INTO scheduler.scanner_devices (
        device_id,
        hostname,
        last_seen_at,
        last_seen_ip,
        last_scan_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, NOW(), $3, NOW(), NOW(), NOW())
      ON CONFLICT (device_id)
      DO UPDATE SET
        hostname = COALESCE(EXCLUDED.hostname, scheduler.scanner_devices.hostname),
        last_seen_at = NOW(),
        last_seen_ip = COALESCE(EXCLUDED.last_seen_ip, scheduler.scanner_devices.last_seen_ip),
        last_scan_at = NOW(),
        updated_at = NOW()
      RETURNING *
    `,
    [
      normalizedDeviceId,
      cleanNullableString(input.hostname),
      cleanNullableString(input.lastSeenIp),
    ]
  );

  return mapRow(result.rows[0]);
}

export async function patchScannerDeviceRecord(
  deviceId: string,
  patch: PatchScannerDeviceRecordInput
): Promise<ScannerDeviceRecord | null> {
  await ensureScannerDevicesTable();
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) {
    throw new Error("deviceId is required");
  }

  const updates: string[] = [];
  const values: Array<string | boolean | null> = [];

  const append = (column: string, value: string | boolean | null | undefined) => {
    if (value === undefined) return;
    values.push(value);
    updates.push(`${column} = $${values.length}`);
  };

  append("label", cleanNullableString(patch.label));
  append("enabled", patch.enabled);
  append("machine_id", cleanNullableString(patch.machineId));
  append("mode_id", cleanNullableString(patch.modeId));
  append("operation_id", cleanNullableString(patch.operationId));
  append("notes", cleanNullableString(patch.notes));

  if (updates.length === 0) {
    return getScannerDevice(normalizedDeviceId);
  }

  values.push(normalizedDeviceId);
  const result = await appPool.query<ScannerDeviceRow>(
    `
      UPDATE scheduler.scanner_devices
      SET ${updates.join(", ")},
          updated_at = NOW()
      WHERE device_id = $${values.length}
      RETURNING *
    `,
    values
  );

  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
