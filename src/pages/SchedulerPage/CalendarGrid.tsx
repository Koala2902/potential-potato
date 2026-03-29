import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { useMemo } from "react";

import { getAppTimeZone } from "../../lib/scheduler/app-timezone";
import { formatProductionTimeShort } from "../../lib/scheduler/format-production-time";
import { productionPathForMachineName } from "../../lib/scheduler/machine-production-path";
import type { CalendarJobItem } from "./types";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Visible material snippet in a day cell (full text on hover via `title`). */
const MATERIAL_PILL_MAX = 14;

function calendarJobTooltip(j: CalendarJobItem): string {
  const est = formatProductionTimeShort(j.estimatedMinutesForMachine);
  return [
    j.fileName ? `File: ${j.fileName}` : null,
    `Material: ${j.material}`,
    j.finishing,
    j.productionPath,
    `${j.pdfQty} copies`,
    j.source,
    `Date: ${j.dateBasis}`,
    est === "—" ? "Est. on this machine: n/a" : `Est. on this machine: ${est}`,
  ]
    .filter((line): line is string => line != null && line !== "")
    .join(" · ");
}

function materialPillShort(material: string): string {
  const s = material.replace(/_/g, " ");
  if (s.length <= MATERIAL_PILL_MAX) return s;
  return `${s.slice(0, MATERIAL_PILL_MAX)}…`;
}

/** Prefer PDF / submission file name in the pill; otherwise the composite material key. */
function jobPillLabel(j: CalendarJobItem): string {
  const raw = j.fileName?.trim() ? j.fileName.trim() : j.material;
  return materialPillShort(raw);
}

export type CalendarMachineStripItem = {
  id: string;
  name: string;
  displayName: string;
};

function daysInMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate();
}

function padMonthParam(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}`;
}


export function monthNavParams(y: number, m: number): {
  current: string;
  prev: string;
  next: string;
} {
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  return {
    current: padMonthParam(y, m),
    prev: padMonthParam(prevY, prevM),
    next: padMonthParam(nextY, nextM),
  };
}

type MonthGridProps = {
  year: number;
  month: number;
  jobsByDay: Record<string, CalendarJobItem[]>;
};

function CalendarMonthGrid({ year, month, jobsByDay }: MonthGridProps) {
  const tz = getAppTimeZone();
  const dim = daysInMonth(year, month);
  const anchor = fromZonedTime(
    `${year}-${String(month).padStart(2, "0")}-01T12:00:00`,
    tz
  );
  const firstIsoDow = Number(formatInTimeZone(anchor, tz, "i"));
  const leading = firstIsoDow - 1;

  const cells: ({ kind: "empty" } | { kind: "day"; day: number })[] = [];
  for (let i = 0; i < leading; i++) cells.push({ kind: "empty" });
  for (let d = 1; d <= dim; d++) cells.push({ kind: "day", day: d });

  const rows: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7));
  }
  if (rows.length > 0 && rows[rows.length - 1].length < 7) {
    const last = rows[rows.length - 1];
    while (last.length < 7) last.push({ kind: "empty" });
  }

  return (
    <div className="scheduler-cal__month">
      <div className="scheduler-cal__weekday-row">
        {WEEKDAYS.map((d) => (
          <div key={d} className="scheduler-cal__weekday">
            {d}
          </div>
        ))}
      </div>
      <div className="scheduler-cal__days-grid">
        {rows.flatMap((row, ri) =>
          row.map((cell, ci) => {
            const key = `${ri}-${ci}`;
            if (cell.kind === "empty") {
              return <div key={key} className="scheduler-cal__cell scheduler-cal__cell--empty" />;
            }
            const dateKey =
              padMonthParam(year, month) + `-${String(cell.day).padStart(2, "0")}`;
            const dayJobs = jobsByDay[dateKey] ?? [];
            const isToday =
              dateKey === formatInTimeZone(new Date(), tz, "yyyy-MM-dd");

            return (
              <div
                key={key}
                className={
                  "scheduler-cal__cell scheduler-cal__cell--day" +
                  (isToday ? " scheduler-cal__cell--today" : "")
                }
              >
                <span
                  className={
                    "scheduler-cal__daynum" +
                    (isToday ? " scheduler-cal__daynum--today" : "")
                  }
                >
                  {cell.day}
                </span>
                <ul className="scheduler-cal__jobs">
                  {dayJobs.map((j) => (
                    <li
                      key={j.id}
                      title={calendarJobTooltip(j)}
                      className="scheduler-cal__jobpill"
                    >
                      <span className="scheduler-cal__jobtime">
                        {formatProductionTimeShort(j.estimatedMinutesForMachine)}
                      </span>
                      <span className="scheduler-cal__jobmat">{jobPillLabel(j)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

type Props = {
  year: number;
  month: number;
  /** Jobs for the currently selected machine only (by calendar day). */
  jobsByDay: Record<string, CalendarJobItem[]>;
  machines: CalendarMachineStripItem[];
  selectedMachineId: string | null;
  onSelectMachine: (machineId: string) => void;
  /** When true, jobs are filtered by Config → Routing (productionPath → machine steps). */
  routingRulesConfigured: boolean;
  currentMonthParam: string;
  prevMonthParam: string;
  nextMonthParam: string;
  onMonthChange: (yyyyMm: string) => void;
};

export function CalendarGrid({
  year,
  month,
  jobsByDay,
  machines,
  selectedMachineId,
  onSelectMachine,
  routingRulesConfigured,
  currentMonthParam,
  prevMonthParam,
  nextMonthParam,
  onMonthChange,
}: Props) {
  const tz = getAppTimeZone();
  const anchor = fromZonedTime(
    `${year}-${String(month).padStart(2, "0")}-01T12:00:00`,
    tz
  );
  const title = formatInTimeZone(anchor, tz, "MMMM yyyy");

  const selectedMachine = useMemo(
    () => machines.find((m) => m.id === selectedMachineId) ?? null,
    [machines, selectedMachineId]
  );

  const pathForSelected = selectedMachine
    ? productionPathForMachineName(selectedMachine.name)
    : null;

  return (
    <div className="scheduler-cal scheduler-cal--fill">
      <div className="scheduler-cal__toolbar">
        <div className="scheduler-cal__nav">
          <button
            type="button"
            className="scheduler-btn scheduler-btn--ghost"
            onClick={() => onMonthChange(prevMonthParam)}
          >
            ← Prev
          </button>
          <button
            type="button"
            className="scheduler-btn scheduler-btn--ghost"
            onClick={() => onMonthChange(nextMonthParam)}
          >
            Next →
          </button>
          <button
            type="button"
            className="scheduler-btn scheduler-btn--muted"
            onClick={() => {
              const key = formatInTimeZone(new Date(), tz, "yyyy-MM");
              onMonthChange(key);
            }}
          >
            Today
          </button>
        </div>
        <h2 className="scheduler-cal__title">{title}</h2>
        <span className="scheduler-cal__meta">
          Month: {currentMonthParam} · {tz}
        </span>
      </div>

      <div className="scheduler-cal__machine-row">
        <label className="scheduler-cal__machine-label" htmlFor="scheduler-machine-select">
          Machine
        </label>
        <select
          id="scheduler-machine-select"
          className="scheduler-input scheduler-cal__machine-select"
          data-testid="scheduler-machine-select"
          value={selectedMachineId ?? ""}
          onChange={(e) => onSelectMachine(e.target.value)}
          disabled={machines.length === 0}
        >
          {machines.length === 0 ? (
            <option value="">No machines configured</option>
          ) : (
            machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} ({m.name})
              </option>
            ))
          )}
        </select>
        {selectedMachine && !routingRulesConfigured && pathForSelected == null && (
          <span className="scheduler-cal__machine-warn-inline">
            No productionPath mapping for this machine name — see machine-production-path.ts
          </span>
        )}
      </div>

      {machines.length > 0 && selectedMachineId && (
        <div className="scheduler-cal__single-wrap" data-testid="scheduler-calendar-machines">
          <CalendarMonthGrid year={year} month={month} jobsByDay={jobsByDay} />
        </div>
      )}

      <p className="scheduler-cal__footnote">
        Each job appears on its <strong>scheduled</strong> date if set, otherwise{" "}
        <strong>due</strong>, otherwise <strong>created</strong> (in {tz}). Labels use the PDF file
        name when available; otherwise the material key (hover for full detail).
      </p>
    </div>
  );
}
