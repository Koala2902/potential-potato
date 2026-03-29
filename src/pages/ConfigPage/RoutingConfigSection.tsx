import { useCallback, useEffect, useMemo, useState } from "react";

import {
  estimateJobRouteMinutes,
  findMatchingRoutingRule,
  parseSchedulerModes,
  parseSchedulerRoutingFlow,
  type MachineLike,
  type RoutingRule,
  type SchedulerRoutingFlow,
} from "../../lib/scheduler/machine-routing";
import {
  fetchSchedulerMachines,
  fetchSchedulerRouting,
  putSchedulerRouting,
  type SchedulerMachine,
} from "../../services/api";

function toMachineLike(m: SchedulerMachine): MachineLike {
  return {
    id: m.id,
    name: m.name,
    displayName: m.displayName,
    constants: m.constants,
    operations: (m.operations ?? []).map((op) => ({
      id: op.id,
      enabled: op.enabled,
      params: op.params.map((p) => ({ key: p.key, value: p.value })),
    })),
  };
}

export default function RoutingConfigSection() {
  const [machines, setMachines] = useState<SchedulerMachine[]>([]);
  const [flow, setFlow] = useState<SchedulerRoutingFlow>({ rules: [] });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewPath, setPreviewPath] = useState("");
  const [previewRoll, setPreviewRoll] = useState("100");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [mList, routingRow] = await Promise.all([
        fetchSchedulerMachines(),
        fetchSchedulerRouting(),
      ]);
      setMachines(mList);
      const parsed = parseSchedulerRoutingFlow(routingRow.flowProperties);
      setFlow(parsed ?? { rules: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const machinesById = useMemo(() => {
    const map = new Map<string, MachineLike>();
    for (const m of machines) map.set(m.id, toMachineLike(m));
    return map;
  }, [machines]);

  const preview = useMemo(() => {
    const rules = flow.rules;
    const rule = findMatchingRoutingRule(rules, previewPath.trim());
    const roll = Number(previewRoll);
    const rollLen = Number.isFinite(roll) && roll > 0 ? roll : null;
    return estimateJobRouteMinutes(rule, machinesById, rollLen);
  }, [flow.rules, previewPath, previewRoll, machinesById]);

  async function onSave() {
    setSuccess(null);
    setError(null);
    setLoading(true);
    try {
      await putSchedulerRouting(flow);
      setSuccess("Routing saved.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function addRule() {
    const rule: RoutingRule = {
      id: crypto.randomUUID(),
      match: { kind: "exact", productionPath: "" },
      steps: [],
    };
    setFlow((f) => ({ ...f, rules: [...f.rules, rule] }));
  }

  function updateRule(index: number, patch: Partial<RoutingRule>) {
    setFlow((f) => {
      const next = [...f.rules];
      next[index] = { ...next[index], ...patch };
      return { ...f, rules: next };
    });
  }

  function removeRule(index: number) {
    setFlow((f) => ({ ...f, rules: f.rules.filter((_, i) => i !== index) }));
  }

  function addStep(ruleIndex: number) {
    const firstMachine = machines[0];
    const mode0 = firstMachine ? parseSchedulerModes(firstMachine.constants)[0] : undefined;
    setFlow((f) => {
      const rules = [...f.rules];
      const step = {
        machineId: firstMachine?.id ?? "",
        modeId: mode0?.id ?? null,
        customOperationIds: undefined as string[] | undefined,
      };
      rules[ruleIndex] = {
        ...rules[ruleIndex],
        steps: [...rules[ruleIndex].steps, step],
      };
      return { ...f, rules };
    });
  }

  function updateStep(
    ruleIndex: number,
    stepIndex: number,
    patch: Partial<RoutingRule["steps"][0]>
  ) {
    setFlow((f) => {
      const rules = [...f.rules];
      const steps = [...rules[ruleIndex].steps];
      steps[stepIndex] = { ...steps[stepIndex], ...patch };
      rules[ruleIndex] = { ...rules[ruleIndex], steps };
      return { ...f, rules };
    });
  }

  function removeStep(ruleIndex: number, stepIndex: number) {
    setFlow((f) => {
      const rules = [...f.rules];
      rules[ruleIndex] = {
        ...rules[ruleIndex],
        steps: rules[ruleIndex].steps.filter((_, i) => i !== stepIndex),
      };
      return { ...f, rules };
    });
  }

  return (
    <div className="config-page__routing-tab" data-testid="config-routing-tab">
      {error && (
        <div className="scheduler-banner scheduler-banner--error" data-testid="config-routing-error">
          {error}
        </div>
      )}
      {success && (
        <div className="scheduler-banner scheduler-banner--ok" data-testid="config-routing-success">
          {success}
        </div>
      )}

      <p className="scheduler-muted">
        Rules match jobs by <code className="scheduler-code">productionPath</code>: exact match first, then
        longest prefix. Each step uses a machine mode (operation set) or a custom set of operations.
      </p>

      <div className="config-page__routing-actions">
        <button
          type="button"
          className="scheduler-btn scheduler-btn--secondary"
          onClick={addRule}
          data-testid="config-routing-add-rule"
        >
          Add rule
        </button>
        <button
          type="button"
          className="scheduler-btn scheduler-btn--primary"
          onClick={() => void onSave()}
          disabled={loading}
          data-testid="config-routing-save"
        >
          {loading ? "Saving…" : "Save routing"}
        </button>
      </div>

      <ul className="config-page__routing-rules">
        {flow.rules.map((rule, ri) => (
          <li key={rule.id} className="config-page__routing-rule" data-testid={`config-routing-rule-${ri}`}>
            <div className="config-page__routing-rule-head">
              <label className="scheduler-field">
                <span className="scheduler-field__label">Match kind</span>
                <select
                  className="scheduler-input"
                  value={rule.match.kind}
                  onChange={(e) =>
                    updateRule(ri, {
                      match: {
                        ...rule.match,
                        kind: e.target.value as "exact" | "prefix",
                      },
                    })
                  }
                >
                  <option value="exact">Exact</option>
                  <option value="prefix">Prefix</option>
                </select>
              </label>
              <label className="scheduler-field config-page__routing-path">
                <span className="scheduler-field__label">Production path</span>
                <input
                  className="scheduler-input"
                  value={rule.match.productionPath}
                  onChange={(e) =>
                    updateRule(ri, {
                      match: { ...rule.match, productionPath: e.target.value },
                    })
                  }
                  placeholder="e.g. indigo_only"
                />
              </label>
              <button
                type="button"
                className="scheduler-btn scheduler-btn--ghost"
                onClick={() => removeRule(ri)}
              >
                Remove rule
              </button>
            </div>

            <div className="config-page__routing-steps-head">
              <h4 className="config-page__operations-title">Steps</h4>
              <button
                type="button"
                className="scheduler-btn scheduler-btn--secondary"
                onClick={() => addStep(ri)}
                disabled={!machines.length}
              >
                Add step
              </button>
            </div>

            <ol className="config-page__routing-step-list">
              {rule.steps.map((step, si) => {
                const m = machines.find((x) => x.id === step.machineId);
                const modes = m ? parseSchedulerModes(m.constants) : [];
                const isCustomPath = step.customOperationIds !== undefined;
                const stepKind: "mode" | "custom" = isCustomPath ? "custom" : "mode";

                return (
                  <li key={`${rule.id}-step-${si}`} className="config-page__routing-step">
                    <label className="scheduler-field">
                      <span className="scheduler-field__label">Machine</span>
                      <select
                        className="scheduler-input"
                        value={step.machineId}
                        onChange={(e) => {
                          const mid = e.target.value;
                          const mm = machines.find((x) => x.id === mid);
                          const m0 = mm ? parseSchedulerModes(mm.constants)[0] : undefined;
                          updateStep(ri, si, {
                            machineId: mid,
                            modeId: m0?.id ?? null,
                            customOperationIds: undefined,
                          });
                        }}
                      >
                        <option value="">Select machine</option>
                        {machines.map((mm) => (
                          <option key={mm.id} value={mm.id}>
                            {mm.displayName}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="config-page__routing-step-kind">
                      <label className="scheduler-field scheduler-field--inline">
                        <input
                          type="radio"
                          name={`step-kind-${rule.id}-${si}`}
                          checked={stepKind === "mode"}
                          onChange={() =>
                            updateStep(ri, si, {
                              modeId: modes[0]?.id ?? step.modeId ?? null,
                              customOperationIds: undefined,
                            })
                          }
                        />
                        <span>Mode</span>
                      </label>
                      <label className="scheduler-field scheduler-field--inline">
                        <input
                          type="radio"
                          name={`step-kind-${rule.id}-${si}`}
                          checked={stepKind === "custom"}
                          onChange={() =>
                            updateStep(ri, si, {
                              modeId: null,
                              customOperationIds: [],
                            })
                          }
                        />
                        <span>Custom ops</span>
                      </label>
                    </div>

                    {stepKind === "mode" && m && (
                      <label className="scheduler-field">
                        <span className="scheduler-field__label">Mode</span>
                        <select
                          className="scheduler-input"
                          value={step.modeId ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            updateStep(ri, si, {
                              modeId: v ? v : null,
                              customOperationIds: undefined,
                            });
                          }}
                        >
                          <option value="">Select mode</option>
                          {modes.map((mo) => (
                            <option key={mo.id} value={mo.id}>
                              {mo.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    {stepKind === "custom" && m && (
                      <fieldset className="config-page__mode-ops">
                        <legend className="config-page__mode-ops-legend">Operations</legend>
                        <div className="config-page__mode-checks">
                          {(m.operations ?? []).map((op) => (
                            <label key={op.id} className="config-page__mode-check">
                              <input
                                type="checkbox"
                                checked={(step.customOperationIds ?? []).includes(op.id)}
                                onChange={(e) => {
                                  const cur = step.customOperationIds ?? [];
                                  const next = e.target.checked
                                    ? [...cur, op.id]
                                    : cur.filter((id) => id !== op.id);
                                  updateStep(ri, si, {
                                    modeId: null,
                                    customOperationIds: next,
                                  });
                                }}
                              />
                              <span>{op.name}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    )}

                    <button
                      type="button"
                      className="scheduler-btn scheduler-btn--ghost"
                      onClick={() => removeStep(ri, si)}
                    >
                      Remove step
                    </button>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ul>

      <section className="config-page__routing-preview" data-testid="config-routing-preview">
        <h3 className="config-page__preview-title">Preview</h3>
        <div className="config-page__preview-grid">
          <label className="scheduler-field">
            <span className="scheduler-field__label">Production path</span>
            <input
              className="scheduler-input"
              value={previewPath}
              onChange={(e) => setPreviewPath(e.target.value)}
              data-testid="config-routing-preview-path"
            />
          </label>
          <label className="scheduler-field">
            <span className="scheduler-field__label">Roll length (m)</span>
            <input
              className="scheduler-input"
              type="number"
              min={0}
              step={0.1}
              value={previewRoll}
              onChange={(e) => setPreviewRoll(e.target.value)}
              data-testid="config-routing-preview-roll"
            />
          </label>
        </div>
        <p className="scheduler-muted">
          Total: <strong>{preview.minutes.toFixed(2)}</strong> min
          {preview.routingRuleId ? (
            <>
              {" "}
              (rule <code className="scheduler-code">{preview.routingRuleId}</code>)
            </>
          ) : (
            " — no matching rule"
          )}
        </p>
        <ul className="config-page__preview-steps">
          {preview.stepDetails.map((s, i) => (
            <li key={i}>
              {s.machineDisplayName}: {s.minutes.toFixed(2)} min
              {s.effectiveSpeedMpm != null && (
                <span className="scheduler-muted">
                  {" "}
                  @ {s.effectiveSpeedMpm} m/min
                </span>
              )}
              {s.skippedReason && (
                <span className="config-page__preview-skip"> — {s.skippedReason}</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
