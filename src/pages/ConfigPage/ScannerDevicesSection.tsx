import { useCallback, useEffect, useMemo, useState } from "react";

import { parseSchedulerModes } from "../../lib/scheduler/machine-routing";
import {
  fetchScannerDevices,
  fetchSchedulerMachines,
  patchScannerDevice,
  type ScannerDevice,
  type SchedulerMachine,
} from "../../services/api";

const INSTALL_COMMAND =
  "curl -fsSL http://10.1.1.64:3001/pi/install.sh | sudo env SERVER_URL=http://10.1.1.64:3001 DEVICE_ID=$(hostname) bash";

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function ScannerDeviceCard({
  device,
  machines,
  onSave,
}: {
  device: ScannerDevice;
  machines: SchedulerMachine[];
  onSave: (
    deviceId: string,
    body: {
      label: string | null;
      enabled: boolean;
      machineId: string | null;
      modeId: string | null;
      operationId: string | null;
      notes: string | null;
    }
  ) => Promise<void>;
}) {
  const [label, setLabel] = useState(device.label ?? "");
  const [enabled, setEnabled] = useState(device.enabled);
  const [machineId, setMachineId] = useState(device.machineId ?? "");
  const [modeId, setModeId] = useState(device.modeId ?? "");
  const [operationId, setOperationId] = useState(device.operationId ?? "");
  const [notes, setNotes] = useState(device.notes ?? "");

  useEffect(() => {
    setLabel(device.label ?? "");
    setEnabled(device.enabled);
    setMachineId(device.machineId ?? "");
    setModeId(device.modeId ?? "");
    setOperationId(device.operationId ?? "");
    setNotes(device.notes ?? "");
  }, [device]);

  const selectedMachine = useMemo(
    () => machines.find((machine) => machine.id === machineId) ?? null,
    [machineId, machines]
  );
  const modes = useMemo(
    () => (selectedMachine ? parseSchedulerModes(selectedMachine.constants) : []),
    [selectedMachine]
  );
  const operations = useMemo(
    () => selectedMachine?.operations.filter((operation) => operation.enabled) ?? [],
    [selectedMachine]
  );
  const assignmentSummary = modeId
    ? `Mode assignment (${modes.find((mode) => mode.id === modeId)?.name ?? modeId})`
    : operationId
      ? `Operation assignment (${operations.find((operation) => operation.id === operationId)?.name ?? operationId})`
      : machineId
        ? "Machine selected, but no scan mode/operation yet"
        : "Not assigned";

  async function handleSave() {
    await onSave(device.deviceId, {
      label: label.trim() || null,
      enabled,
      machineId: machineId || null,
      modeId: modeId || null,
      operationId: operationId || null,
      notes: notes.trim() || null,
    });
  }

  return (
    <li className="config-page__device-card">
      <div className="config-page__device-head">
        <div>
          <h3 className="config-page__machine-card-title">{device.label || device.deviceId}</h3>
          <p className="config-page__machine-card-sub">
            <code className="scheduler-code">{device.deviceId}</code>
            {device.hostname ? <span>Hostname: {device.hostname}</span> : null}
            {!device.enabled ? <span className="config-page__badge-disabled">disabled</span> : null}
          </p>
        </div>
        <div className="config-page__device-last-seen">
          <strong>Last seen</strong>
          <span>{formatDateTime(device.lastSeenAt)}</span>
          {device.lastSeenIp ? <span>{device.lastSeenIp}</span> : null}
        </div>
      </div>

      <div className="config-page__device-grid">
        <label>
          Label
          <input
            className="config-page__ops-table-input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Optional friendly name"
          />
        </label>

        <label>
          Machine
          <select
            className="config-page__ops-table-input"
            value={machineId}
            onChange={(event) => {
              setMachineId(event.target.value);
              setModeId("");
              setOperationId("");
            }}
          >
            <option value="">Unassigned</option>
            {machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.displayName}
              </option>
            ))}
          </select>
        </label>

        <label>
          Mode
          <select
            className="config-page__ops-table-input"
            value={modeId}
            onChange={(event) => {
              setModeId(event.target.value);
              if (event.target.value) setOperationId("");
            }}
            disabled={!selectedMachine || modes.length === 0}
          >
            <option value="">
              {!selectedMachine
                ? "Select a machine first"
                : modes.length === 0
                  ? "No modes on this machine"
                  : "Use explicit operation instead"}
            </option>
            {modes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Operation
          <select
            className="config-page__ops-table-input"
            value={operationId}
            onChange={(event) => {
              setOperationId(event.target.value);
              if (event.target.value) setModeId("");
            }}
            disabled={!selectedMachine || operations.length === 0}
          >
            <option value="">
              {!selectedMachine ? "Select a machine first" : "Optional explicit operation"}
            </option>
            {operations.map((operation) => (
              <option key={operation.id} value={operation.id}>
                {operation.name}
              </option>
            ))}
          </select>
        </label>

        <label className="config-page__device-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
      </div>

      <label className="config-page__device-notes">
        Notes
        <textarea
          className="config-page__param-value"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Optional location or scanner notes"
        />
      </label>

      <div className="config-page__device-footer">
        <span className="scheduler-muted">{assignmentSummary}</span>
        <button type="button" className="config-page__op-edit" onClick={handleSave}>
          Save device
        </button>
      </div>
    </li>
  );
}

export default function ScannerDevicesSection() {
  const [devices, setDevices] = useState<ScannerDevice[]>([]);
  const [machines, setMachines] = useState<SchedulerMachine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [deviceRows, machineRows] = await Promise.all([
        fetchScannerDevices(),
        fetchSchedulerMachines(),
      ]);
      setDevices(deviceRows);
      setMachines(machineRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const devicesSorted = useMemo(
    () =>
      [...devices].sort((a, b) =>
        (a.label || a.deviceId).localeCompare(b.label || b.deviceId)
      ),
    [devices]
  );

  const saveDevice = useCallback(
    async (
      deviceId: string,
      body: {
        label: string | null;
        enabled: boolean;
        machineId: string | null;
        modeId: string | null;
        operationId: string | null;
        notes: string | null;
      }
    ) => {
      setLoading(true);
      setError(null);
      setSuccess(null);
      try {
        await patchScannerDevice(deviceId, body);
        setSuccess(`Saved ${deviceId}.`);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [load]
  );

  return (
    <section className="config-page__devices">
      {error ? (
        <div className="scheduler-banner scheduler-banner--error" data-testid="scanner-device-error">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="scheduler-banner scheduler-banner--ok" data-testid="scanner-device-success">
          {success}
        </div>
      ) : null}

      <div className="config-page__device-install">
        <h3 className="config-page__preview-title">Pi one-line install</h3>
        <p className="scheduler-muted">
          Paste this on the Raspberry Pi. The installer downloads the scanner client from the API
          server, writes config, and enables a systemd service.
        </p>
        <pre className="config-page__constants-pre">{INSTALL_COMMAND}</pre>
        <p className="scheduler-muted">
          After the service starts and the scanner sends its first scan, the Pi appears below as a
          known device.
        </p>
      </div>

      {devicesSorted.length === 0 ? (
        <p className="scheduler-muted">
          No scanner devices have checked in yet. Install a Pi scanner and trigger a scan once to
          register it automatically.
        </p>
      ) : (
        <ul className="config-page__device-list">
          {devicesSorted.map((device) => (
            <ScannerDeviceCard
              key={device.deviceId}
              device={device}
              machines={machines}
              onSave={saveDevice}
            />
          ))}
        </ul>
      )}

      {loading ? <p className="scheduler-muted">Saving scanner device changes…</p> : null}
    </section>
  );
}
