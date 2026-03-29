import { formatInTimeZone } from "date-fns-tz";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getJobCalendarMeta } from "../../lib/scheduler/job-calendar-date";
import { getAppTimeZone } from "../../lib/scheduler/app-timezone";
import {
  compareJobsByRoutingStep,
  jobMatchesMachineForSchedule,
} from "../../lib/scheduler/machine-production-path";
import {
  parseSchedulerRoutingFlow,
  type RoutingRule,
} from "../../lib/scheduler/machine-routing";
import {
  estimateSchedulerJobs,
  fetchSchedulerJobs,
  fetchSchedulerMachines,
  fetchSchedulerRouting,
  type SchedulerJob,
} from "../../services/api";
import { CalendarGrid, monthNavParams } from "./CalendarGrid";
import type { CalendarJobItem } from "./types";
import "./SchedulerPage.css";

const MONTH_RE = /^(\d{4})-(\d{2})$/;

function parseMonthParam(s: string | undefined): { y: number; m: number } {
  const tz = getAppTimeZone();
  const fallback = () => {
    const key = formatInTimeZone(new Date(), tz, "yyyy-MM");
    return {
      y: Number(key.slice(0, 4)),
      m: Number(key.slice(5, 7)),
    };
  };
  if (!s || !MONTH_RE.test(s)) return fallback();
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  if (m < 1 || m > 12 || !Number.isFinite(y)) return fallback();
  return { y, m };
}

function buildJobsByDayForJobs(
  jobList: SchedulerJob[],
  estimatesByJobId: Map<string, number | null>
): Record<string, CalendarJobItem[]> {
  const map: Record<string, CalendarJobItem[]> = {};
  for (const job of jobList) {
    const meta = getJobCalendarMeta({
      scheduledDate: job.scheduledDate,
      dueDate: job.dueDate,
      createdAt: job.createdAt,
    });
    const item: CalendarJobItem = {
      id: job.id,
      material: job.material,
      finishing: job.finishing,
      productionPath: job.productionPath,
      pdfQty: job.pdfQty,
      source: job.source,
      dateBasis: meta.basis,
      estimatedMinutesForMachine: estimatesByJobId.get(job.id) ?? null,
    };
    const list = map[meta.dateKey] ?? [];
    list.push(item);
    map[meta.dateKey] = list;
  }
  return map;
}

export default function SchedulerPage() {
  const [jobs, setJobs] = useState<SchedulerJob[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<string>(() => {
    const tz = getAppTimeZone();
    return formatInTimeZone(new Date(), tz, "yyyy-MM");
  });

  const loadJobs = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await fetchSchedulerJobs();
      setJobs(list);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const [machines, setMachines] = useState<
    Array<{ id: string; name: string; displayName: string }>
  >([]);
  const [machinesError, setMachinesError] = useState<string | null>(null);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [routingRules, setRoutingRules] = useState<RoutingRule[]>([]);
  const [estimatesByJobId, setEstimatesByJobId] = useState<Map<string, number | null>>(
    () => new Map()
  );

  const loadMachines = useCallback(async () => {
    setMachinesError(null);
    try {
      const list = await fetchSchedulerMachines();
      const sorted = [...list]
        .filter((m) => m.enabled)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName))
        .map((m) => ({ id: m.id, name: m.name, displayName: m.displayName }));
      setMachines(sorted);
    } catch (e) {
      setMachinesError(e instanceof Error ? e.message : String(e));
      setMachines([]);
    }
  }, []);

  const loadRouting = useCallback(async () => {
    try {
      const row = await fetchSchedulerRouting();
      const parsed = parseSchedulerRoutingFlow(row.flowProperties);
      setRoutingRules(parsed?.rules ?? []);
    } catch {
      setRoutingRules([]);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    void loadMachines();
  }, [loadMachines]);

  useEffect(() => {
    void loadRouting();
  }, [loadRouting]);

  useEffect(() => {
    if (machines.length === 0) {
      setSelectedMachineId(null);
      return;
    }
    setSelectedMachineId((prev) => {
      if (prev && machines.some((m) => m.id === prev)) return prev;
      return machines[0].id;
    });
  }, [machines]);

  useEffect(() => {
    if (jobs.length === 0 || !selectedMachineId) {
      setEstimatesByJobId(new Map());
      return;
    }
    const machine = machines.find((m) => m.id === selectedMachineId);
    if (!machine) {
      setEstimatesByJobId(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await estimateSchedulerJobs(jobs.map((j) => j.id));
        if (cancelled) return;
        const map = new Map<string, number | null>();
        for (const jb of result.jobBreakdowns) {
          const step = jb.steps.find((s) => s.machineName === machine.name);
          map.set(jb.jobId, step != null ? step.minutes : null);
        }
        setEstimatesByJobId(map);
      } catch {
        if (!cancelled) setEstimatesByJobId(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobs, selectedMachineId, machines]);

  const { y, m } = parseMonthParam(calendarMonth);
  const nav = monthNavParams(y, m);

  const jobsByDayForSelectedMachine = useMemo(() => {
    if (!selectedMachineId) return {};
    const machine = machines.find((x) => x.id === selectedMachineId);
    if (!machine) return {};
    const filtered = jobs.filter((j) =>
      jobMatchesMachineForSchedule(j, machine, routingRules)
    );
    const sorted = [...filtered].sort((a, b) =>
      compareJobsByRoutingStep(a, b, selectedMachineId, routingRules)
    );
    return buildJobsByDayForJobs(sorted, estimatesByJobId);
  }, [jobs, machines, selectedMachineId, routingRules, estimatesByJobId]);

  return (
    <div className="scheduler-page">
      {loadError && <div className="scheduler-banner scheduler-banner--error">{loadError}</div>}
      {machinesError && (
        <div className="scheduler-banner scheduler-banner--error">{machinesError}</div>
      )}

      <section className="scheduler-section scheduler-section--calendar-fill">
        <CalendarGrid
          year={y}
          month={m}
          jobsByDay={jobsByDayForSelectedMachine}
          machines={machines}
          selectedMachineId={selectedMachineId}
          onSelectMachine={setSelectedMachineId}
          routingRulesConfigured={routingRules.length > 0}
          currentMonthParam={nav.current}
          prevMonthParam={nav.prev}
          nextMonthParam={nav.next}
          onMonthChange={setCalendarMonth}
        />
      </section>
    </div>
  );
}
