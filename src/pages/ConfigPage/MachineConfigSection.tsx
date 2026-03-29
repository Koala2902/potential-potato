import { useCallback, useEffect, useMemo, useState } from "react";

import {
  LINE_SPEED_PARAM_KEY,
  parseSchedulerModes,
  type SchedulerMode,
} from "../../lib/scheduler/machine-routing";
import type { BatchRuleBodyInput, OperationParamRowInput } from "../../lib/scheduler/validations/config";
import {
  createSchedulerMachine,
  createSchedulerOperation,
  deleteSchedulerOperation,
  fetchSchedulerMachines,
  patchSchedulerMachine,
  updateSchedulerOperation,
  type SchedulerMachine,
  type SchedulerOperation,
} from "../../services/api";
import { Modal } from "./Modal";

function readLineSpeed(op: SchedulerOperation): number {
  const p = op.params?.find((x) => x.key === LINE_SPEED_PARAM_KEY);
  if (!p) return 0;
  const v = p.value;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function withLineSpeedParam(op: SchedulerOperation, speed: number): OperationParamRowInput[] {
  const rest = (op.params ?? [])
    .filter((p) => p.key !== LINE_SPEED_PARAM_KEY)
    .map((p) => ({
      key: p.key,
      value: p.value,
      valueType: p.valueType,
      label: p.label,
      unit: p.unit ?? null,
      isConfigurable: p.isConfigurable,
      sortOrder: p.sortOrder,
    }));
  const line: OperationParamRowInput = {
    key: LINE_SPEED_PARAM_KEY,
    value: speed,
    valueType: "number",
    label: "Line speed",
    unit: "m/min",
    isConfigurable: true,
    sortOrder: 0,
  };
  return [line, ...rest.map((r, i) => ({ ...r, sortOrder: i + 1 }))];
}

function opToBatchRule(op: SchedulerOperation): BatchRuleBodyInput {
  const br = op.batchRule;
  if (!br) {
    return {
      scope: "per_job",
      groupByFields: [],
      appliesOnce: false,
      thresholdValue: null,
      routeToMachine: null,
      conditionExpr: null,
    };
  }
  return {
    scope: br.scope,
    groupByFields: [...br.groupByFields],
    appliesOnce: br.appliesOnce,
    thresholdValue: br.thresholdValue,
    routeToMachine: br.routeToMachine,
    conditionExpr: br.conditionExpr,
  };
}

export default function MachineConfigSection() {
  const [machines, setMachines] = useState<SchedulerMachine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [machineModalOpen, setMachineModalOpen] = useState(false);
  const [machineForm, setMachineForm] = useState({
    name: "",
    displayName: "",
    sortOrder: 10,
    enabled: true,
    constantsJson: "",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await fetchSchedulerMachines();
      setMachines(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!machineModalOpen) return;
    setMachineForm({
      name: "",
      displayName: "",
      sortOrder: 10,
      enabled: true,
      constantsJson: "",
    });
  }, [machineModalOpen]);

  const machinesSorted = useMemo(
    () =>
      [...machines].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName)
      ),
    [machines]
  );

  async function saveOperationRow(machineId: string, op: SchedulerOperation, patch: Partial<SchedulerOperation> & { lineSpeed?: number }) {
    setError(null);
    setLoading(true);
    try {
      const lineSpeed = patch.lineSpeed ?? readLineSpeed(op);
      await updateSchedulerOperation(machineId, op.id, {
        name: patch.name ?? op.name,
        type: patch.type ?? op.type,
        sortOrder: patch.sortOrder ?? op.sortOrder,
        enabled: patch.enabled ?? op.enabled,
        calcFnKey: op.calcFnKey ?? null,
        notes: op.notes ?? null,
        params: withLineSpeedParam(op, lineSpeed),
        batchRule: opToBatchRule(op),
      });
      setSuccess("Operation saved.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function onAddMachine(e: React.FormEvent) {
    e.preventDefault();
    setSuccess(null);
    setError(null);
    setLoading(true);
    try {
      await createSchedulerMachine({
        name: machineForm.name,
        displayName: machineForm.displayName,
        sortOrder: machineForm.sortOrder,
        enabled: machineForm.enabled,
        constantsJson: machineForm.constantsJson.trim() || null,
      });
      setSuccess(`Machine “${machineForm.displayName}” saved.`);
      setMachineModalOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function onAddOperation(machineId: string) {
    setError(null);
    setLoading(true);
    try {
      const m = machines.find((x) => x.id === machineId);
      const nextSort =
        Math.max(0, ...(m?.operations?.map((o) => o.sortOrder) ?? [0])) + 1;
      const created = await createSchedulerOperation(machineId, {
        name: "New operation",
        type: "production",
        sortOrder: nextSort,
        enabled: true,
        calcFnKey: null,
        notes: null,
      });
      await updateSchedulerOperation(machineId, created.id, {
        name: "New operation",
        type: "production",
        sortOrder: nextSort,
        enabled: true,
        calcFnKey: null,
        notes: null,
        params: withLineSpeedParam(created, 10),
        batchRule: opToBatchRule(created),
      });
      setSuccess("Operation added.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function onDeleteOperation(machineId: string, op: SchedulerOperation) {
    if (!window.confirm(`Delete operation “${op.name}”?`)) return;
    setError(null);
    setLoading(true);
    try {
      await deleteSchedulerOperation(machineId, op.id);
      setSuccess("Operation removed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function saveModes(machine: SchedulerMachine, modes: SchedulerMode[]) {
    setError(null);
    setLoading(true);
    try {
      const base =
        machine.constants && typeof machine.constants === "object" && machine.constants !== null
          ? { ...machine.constants }
          : {};
      await patchSchedulerMachine(machine.id, {
        constants: { ...base, schedulerModes: modes },
      });
      setSuccess("Modes saved.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="config-page__machine-tab">
      {error && (
        <div className="scheduler-banner scheduler-banner--error" data-testid="config-error">
          {error}
        </div>
      )}
      {success && (
        <div className="scheduler-banner scheduler-banner--ok" data-testid="config-success">
          {success}
        </div>
      )}

      <div className="config-page__machines">
        {machinesSorted.length === 0 ? (
          <p className="scheduler-muted">No machines yet. Add one below.</p>
        ) : (
          <ul className="config-page__machine-list" data-testid="config-machine-list">
            {machinesSorted.map((m) => (
              <MachineCard
                key={m.id}
                machine={m}
                loading={loading}
                onSaveRow={saveOperationRow}
                onAddOperation={() => void onAddOperation(m.id)}
                onDeleteOperation={(op) => void onDeleteOperation(m.id, op)}
                onSaveModes={(modes) => void saveModes(m, modes)}
              />
            ))}
          </ul>
        )}

        <button
          type="button"
          className="scheduler-btn scheduler-btn--primary config-page__add-machine-footer"
          data-testid="config-add-machine-open"
          onClick={() => setMachineModalOpen(true)}
        >
          Add machine
        </button>
      </div>

      <Modal
        open={machineModalOpen}
        title="Add machine"
        onClose={() => setMachineModalOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="scheduler-btn scheduler-btn--ghost"
              onClick={() => setMachineModalOpen(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="config-form-add-machine"
              className="scheduler-btn scheduler-btn--primary"
              disabled={loading}
              data-testid="config-save-machine"
            >
              {loading ? "Saving…" : "Save machine"}
            </button>
          </>
        }
      >
        <form id="config-form-add-machine" className="scheduler-config__form" onSubmit={onAddMachine}>
          <div className="config-page__add-machine-grid">
            <label className="scheduler-field">
              <span className="scheduler-field__label">Internal name (unique)</span>
              <input
                className="scheduler-input"
                data-testid="config-new-machine-name"
                value={machineForm.name}
                onChange={(e) => setMachineForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. finisher_line_1"
                required
              />
            </label>
            <label className="scheduler-field">
              <span className="scheduler-field__label">Display name</span>
              <input
                className="scheduler-input"
                data-testid="config-new-machine-display"
                value={machineForm.displayName}
                onChange={(e) => setMachineForm((f) => ({ ...f, displayName: e.target.value }))}
                placeholder="Shown in UI"
                required
              />
            </label>
            <label className="scheduler-field">
              <span className="scheduler-field__label">Sort order</span>
              <input
                type="number"
                className="scheduler-input"
                data-testid="config-new-machine-sort"
                value={machineForm.sortOrder}
                onChange={(e) =>
                  setMachineForm((f) => ({ ...f, sortOrder: Number(e.target.value) }))
                }
                required
              />
            </label>
          </div>
          <label className="scheduler-field">
            <span className="scheduler-field__label">Constants (JSON object, optional)</span>
            <textarea
              className="scheduler-input scheduler-input--textarea"
              data-testid="config-new-machine-constants"
              value={machineForm.constantsJson ?? ""}
              onChange={(e) =>
                setMachineForm((f) => ({ ...f, constantsJson: e.target.value }))
              }
              rows={4}
              placeholder='{"KEY": 1}'
            />
          </label>
        </form>
      </Modal>
    </div>
  );
}

type SortKey = "name" | "speed" | "sortOrder";

function MachineCard({
  machine,
  loading,
  onSaveRow,
  onAddOperation,
  onDeleteOperation,
  onSaveModes,
}: {
  machine: SchedulerMachine;
  loading: boolean;
  onSaveRow: (
    machineId: string,
    op: SchedulerOperation,
    patch: Partial<SchedulerOperation> & { lineSpeed?: number }
  ) => Promise<void>;
  onAddOperation: () => void;
  onDeleteOperation: (op: SchedulerOperation) => void;
  onSaveModes: (modes: SchedulerMode[]) => void;
}) {
  const [sortBy, setSortBy] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "sortOrder",
    dir: "asc",
  });

  function toggleSort(key: SortKey) {
    setSortBy((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }
    );
  }

  const modes = parseSchedulerModes(machine.constants);
  const [modeDraft, setModeDraft] = useState<SchedulerMode[] | null>(null);
  const draft = modeDraft ?? modes;

  useEffect(() => {
    setModeDraft(null);
  }, [machine.id, machine.constants]);

  const opsSorted = useMemo(() => {
    const ops = [...(machine.operations ?? [])];
    const dir = sortBy.dir === "asc" ? 1 : -1;
    ops.sort((a, b) => {
      if (sortBy.key === "name") return a.name.localeCompare(b.name) * dir;
      if (sortBy.key === "speed")
        return (readLineSpeed(a) - readLineSpeed(b)) * dir;
      return (a.sortOrder - b.sortOrder) * dir;
    });
    return ops;
  }, [machine.operations, sortBy]);

  function addMode() {
    const next: SchedulerMode = {
      id: crypto.randomUUID(),
      name: "New mode",
      operationIds: [],
    };
    setModeDraft([...draft, next]);
  }

  function updateMode(index: number, patch: Partial<SchedulerMode>) {
    const next = [...draft];
    next[index] = { ...next[index], ...patch };
    setModeDraft(next);
  }

  function removeMode(index: number) {
    setModeDraft(draft.filter((_, i) => i !== index));
  }

  return (
    <li
      className="config-page__machine-card"
      data-machine-name={machine.name}
      data-testid={`config-machine-${machine.id}`}
    >
      <header className="config-page__machine-card-head">
        <div>
          <h3 className="config-page__machine-card-title">{machine.displayName}</h3>
          <p className="config-page__machine-card-sub">
            <code className="scheduler-code">{machine.name}</code>
            {!machine.enabled && <span className="config-page__badge-disabled">disabled</span>}
            <span className="config-page__machine-card-count">
              {machine.operations?.length ?? 0} operation(s)
            </span>
          </p>
        </div>
      </header>

      <section className="config-page__machine-ops" aria-label={`Operations for ${machine.displayName}`}>
        <div className="config-page__machine-ops-head">
          <h4 className="config-page__operations-title">Operations</h4>
          <button
            type="button"
            className="scheduler-btn scheduler-btn--secondary"
            data-testid={`config-add-operation-${machine.id}`}
            onClick={onAddOperation}
            disabled={loading}
          >
            Add operation
          </button>
        </div>
        {opsSorted.length === 0 ? (
          <p className="scheduler-muted">No operations on this machine yet.</p>
        ) : (
          <div className="config-page__ops-table-wrap">
            <table className="config-page__ops-table">
              <thead>
                <tr>
                  <th>
                    <button
                      type="button"
                      className="config-page__th-sort"
                      onClick={() => toggleSort("name")}
                    >
                      Operation {sortBy.key === "name" ? (sortBy.dir === "asc" ? "↑" : "↓") : ""}
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      className="config-page__th-sort"
                      onClick={() => toggleSort("speed")}
                    >
                      Line speed (m/min) {sortBy.key === "speed" ? (sortBy.dir === "asc" ? "↑" : "↓") : ""}
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      className="config-page__th-sort"
                      onClick={() => toggleSort("sortOrder")}
                    >
                      Order {sortBy.key === "sortOrder" ? (sortBy.dir === "asc" ? "↑" : "↓") : ""}
                    </button>
                  </th>
                  <th>On</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {opsSorted.map((op) => (
                  <tr
                    key={`${op.id}-${op.name}-${readLineSpeed(op)}-${op.sortOrder}-${op.enabled}`}
                    data-testid={`config-op-row-${op.id}`}
                  >
                    <td>
                      <input
                        className="scheduler-input config-page__ops-table-input"
                        defaultValue={op.name}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v && v !== op.name) void onSaveRow(machine.id, op, { name: v });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        className="scheduler-input config-page__ops-table-input"
                        defaultValue={readLineSpeed(op)}
                        onBlur={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n !== readLineSpeed(op)) {
                            void onSaveRow(machine.id, op, { lineSpeed: n });
                          }
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        className="scheduler-input config-page__ops-table-input"
                        defaultValue={op.sortOrder}
                        onBlur={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n !== op.sortOrder) {
                            void onSaveRow(machine.id, op, { sortOrder: n });
                          }
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={op.enabled}
                        onChange={(e) => void onSaveRow(machine.id, op, { enabled: e.target.checked })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="scheduler-btn scheduler-btn--ghost"
                        data-testid={`config-op-delete-${op.id}`}
                        onClick={() => onDeleteOperation(op)}
                        disabled={loading}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="config-page__modes" aria-label={`Modes for ${machine.displayName}`}>
        <div className="config-page__machine-ops-head">
          <h4 className="config-page__operations-title">Machine modes</h4>
          <button type="button" className="scheduler-btn scheduler-btn--secondary" onClick={addMode}>
            Add mode
          </button>
        </div>
        <p className="scheduler-muted config-page__modes-hint">
          A mode is a set of operations. Effective line speed is the minimum speed among selected operations.
        </p>
        {draft.length === 0 ? (
          <p className="scheduler-muted">No modes yet.</p>
        ) : (
          <ul className="config-page__mode-list">
            {draft.map((mode, mi) => (
              <li key={mode.id} className="config-page__mode-item">
                <label className="scheduler-field config-page__mode-name">
                  <span className="scheduler-field__label">Mode name</span>
                  <input
                    className="scheduler-input"
                    value={mode.name}
                    onChange={(e) => updateMode(mi, { name: e.target.value })}
                  />
                </label>
                <fieldset className="config-page__mode-ops">
                  <legend className="config-page__mode-ops-legend">Operations in this mode</legend>
                  <div className="config-page__mode-checks">
                    {(machine.operations ?? []).map((op) => (
                      <label key={op.id} className="config-page__mode-check">
                        <input
                          type="checkbox"
                          checked={mode.operationIds.includes(op.id)}
                          onChange={(e) => {
                            const nextIds = e.target.checked
                              ? [...mode.operationIds, op.id]
                              : mode.operationIds.filter((id) => id !== op.id);
                            updateMode(mi, { operationIds: nextIds });
                          }}
                        />
                        <span>{op.name}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <button
                  type="button"
                  className="scheduler-btn scheduler-btn--ghost"
                  onClick={() => removeMode(mi)}
                >
                  Delete mode
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="scheduler-btn scheduler-btn--primary"
          disabled={loading}
          onClick={() => void onSaveModes(draft)}
        >
          Save modes
        </button>
      </section>
    </li>
  );
}
