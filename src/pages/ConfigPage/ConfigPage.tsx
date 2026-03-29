import { useCallback, useEffect, useState } from "react";

import { fetchSchedulerDiagnostics, type SchedulerDiagnostics } from "../../services/api";
import MachineConfigSection from "./MachineConfigSection";
import RoutingConfigSection from "./RoutingConfigSection";
import "../SchedulerPage/SchedulerPage.css";
import "./ConfigPage.css";

export default function ConfigPage() {
  const [tab, setTab] = useState<"machine" | "routing">("machine");
  const [diag, setDiag] = useState<SchedulerDiagnostics | null>(null);

  const loadDiag = useCallback(async () => {
    try {
      setDiag(await fetchSchedulerDiagnostics());
    } catch {
      setDiag(null);
    }
  }, []);

  useEffect(() => {
    void loadDiag();
  }, [loadDiag]);

  return (
    <div className="config-page" data-testid="scheduler-config">
      <div className="config-page__intro">
        <h2 className="config-page__title">Scheduler config</h2>
        <p className="scheduler-muted">
          Configure machines (operations and line speeds), machine modes (sets of operations), and routing
          rules matched by production path. Estimates use the slowest operation in a mode for line speed.
        </p>
      </div>

      {diag && (
        <p className="scheduler-muted scheduler-config__diag" data-testid="config-diagnostics">
          Connected to database <code className="scheduler-code">{diag.database}</code> —{" "}
          <code className="scheduler-code">scheduler</code> schema: {diag.schedulerMachineCount} machine(s),{" "}
          {diag.schedulerOperationCount} operation(s). In SQL clients, open schema{" "}
          <code className="scheduler-code">scheduler</code>, tables{" "}
          <code className="scheduler-code">Machine</code> and <code className="scheduler-code">Operation</code>{" "}
          (not <code className="scheduler-code">public</code>).
          {diag.publicMachineCount != null
            ? ` Legacy public."Machine" row count: ${diag.publicMachineCount}.`
            : ""}
          {diag.schedulerMachineCount === 0 &&
            diag.publicMachineCount != null &&
            diag.publicMachineCount > 0 && (
              <span>
                {" "}
                Rows exist only in <code className="scheduler-code">public</code>; the server tries to copy them
                into <code className="scheduler-code">scheduler</code> when you open this page. If the list stays
                empty, check the API server log for SQL errors.
              </span>
            )}
        </p>
      )}

      <nav className="config-page__subnav" aria-label="Config sections">
        <button
          type="button"
          className={
            tab === "machine"
              ? "config-page__subnav-btn config-page__subnav-btn--active"
              : "config-page__subnav-btn"
          }
          data-testid="config-tab-machine"
          onClick={() => setTab("machine")}
        >
          Machine
        </button>
        <button
          type="button"
          className={
            tab === "routing"
              ? "config-page__subnav-btn config-page__subnav-btn--active"
              : "config-page__subnav-btn"
          }
          data-testid="config-tab-routing"
          onClick={() => setTab("routing")}
        >
          Routing
        </button>
      </nav>

      {tab === "machine" && <MachineConfigSection />}
      {tab === "routing" && <RoutingConfigSection />}
    </div>
  );
}
