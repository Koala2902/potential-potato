import { addDays, subDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getAppTimeZone } from '../../lib/scheduler/app-timezone';
import { formatProductionTimeShort } from '../../lib/scheduler/format-production-time';
import type { CalendarMachineStripItem } from './CalendarGrid';
import { calendarJobTooltip, dateKeyFromPointer, jobPillLabel } from './scheduler-drag';
import type { CalendarJobItem } from './types';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function mondayOfWeekContaining(date: Date, tz: string): string {
    const isoDow = Number(formatInTimeZone(date, tz, 'i'));
    const monday = subDays(date, isoDow - 1);
    return formatInTimeZone(monday, tz, 'yyyy-MM-dd');
}

export function shiftWeek(weekStartYmd: string, deltaWeeks: number, tz: string): string {
    const anchor = fromZonedTime(`${weekStartYmd}T12:00:00`, tz);
    return formatInTimeZone(addDays(anchor, deltaWeeks * 7), tz, 'yyyy-MM-dd');
}

function weekDateKeys(weekStartYmd: string, tz: string): string[] {
    const anchor = fromZonedTime(`${weekStartYmd}T12:00:00`, tz);
    return Array.from({ length: 7 }, (_, i) => formatInTimeZone(addDays(anchor, i), tz, 'yyyy-MM-dd'));
}

type Props = {
    weekStartYmd: string;
    jobsByDay: Record<string, CalendarJobItem[]>;
    machines: CalendarMachineStripItem[];
    selectedMachineId: string | null;
    onSelectMachine: (machineId: string) => void;
    onWeekChange: (weekStartYmd: string) => void;
    onScheduleJobMove?: (jobId: string, dateKey: string) => void | Promise<void>;
};

export default function CalendarWeekGrid({
    weekStartYmd,
    jobsByDay,
    machines,
    selectedMachineId,
    onSelectMachine,
    onWeekChange,
    onScheduleJobMove,
}: Props) {
    const tz = getAppTimeZone();
    const keys = useMemo(() => weekDateKeys(weekStartYmd, tz), [weekStartYmd, tz]);
    const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null;
    const canDrag = Boolean(onScheduleJobMove);

    const [draggingJobId, setDraggingJobId] = useState<string | null>(null);
    const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
    const pointerDragJobIdRef = useRef<string | null>(null);

    const weekLabel = useMemo(() => {
        const start = fromZonedTime(`${keys[0]}T12:00:00`, tz);
        const end = fromZonedTime(`${keys[6]}T12:00:00`, tz);
        return `${formatInTimeZone(start, tz, 'd MMM')} – ${formatInTimeZone(end, tz, 'd MMM yyyy')}`;
    }, [keys, tz]);

    const finishPointerDrag = useCallback(() => {
        pointerDragJobIdRef.current = null;
        setDraggingJobId(null);
        setDropTargetKey(null);
    }, []);

    const startPointerDrag = useCallback(
        (jobId: string) => {
            if (!canDrag) return;
            pointerDragJobIdRef.current = jobId;
            setDraggingJobId(jobId);
        },
        [canDrag]
    );

    useEffect(() => {
        const jobId = pointerDragJobIdRef.current;
        if (!jobId) return;

        const onMove = (e: PointerEvent) => {
            setDropTargetKey(dateKeyFromPointer(e.clientX, e.clientY));
        };

        const onEnd = (e: PointerEvent) => {
            const activeJobId = pointerDragJobIdRef.current;
            if (!activeJobId) return;
            const dateKey = dateKeyFromPointer(e.clientX, e.clientY);
            if (dateKey && onScheduleJobMove) {
                void onScheduleJobMove(activeJobId, dateKey);
            }
            finishPointerDrag();
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onEnd);
        document.addEventListener('pointercancel', onEnd);
        return () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onEnd);
            document.removeEventListener('pointercancel', onEnd);
        };
    }, [draggingJobId, onScheduleJobMove, finishPointerDrag]);

    return (
        <div className="scheduler-week">
            <div className="scheduler-week__toolbar">
                <div className="scheduler-week__machine">
                    <select
                        id="scheduler-touch-machine"
                        className="scheduler-input scheduler-week__machine-select"
                        value={selectedMachineId ?? ''}
                        onChange={(e) => onSelectMachine(e.target.value)}
                        disabled={machines.length === 0}
                        aria-label="Machine"
                    >
                        {machines.length === 0 ? (
                            <option value="">No machines</option>
                        ) : (
                            machines.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.displayName}
                                </option>
                            ))
                        )}
                    </select>
                </div>
                <div className="scheduler-week__nav">
                    <button
                        type="button"
                        className="scheduler-btn scheduler-btn--ghost"
                        aria-label="Previous week"
                        onClick={() => onWeekChange(shiftWeek(weekStartYmd, -1, tz))}
                    >
                        ←
                    </button>
                    <span className="scheduler-week__range">{weekLabel}</span>
                    <button
                        type="button"
                        className="scheduler-btn scheduler-btn--ghost"
                        aria-label="Next week"
                        onClick={() => onWeekChange(shiftWeek(weekStartYmd, 1, tz))}
                    >
                        →
                    </button>
                </div>
            </div>

            {canDrag ? (
                <p className="scheduler-week__hint">Drag a job to another day to reschedule.</p>
            ) : null}

            {selectedMachine ? (
                <div className={`scheduler-week__grid${draggingJobId ? ' scheduler-week__grid--dragging' : ''}`}>
                    {keys.map((dateKey, i) => {
                        const dayJobs = jobsByDay[dateKey] ?? [];
                        const dayNum = formatInTimeZone(
                            fromZonedTime(`${dateKey}T12:00:00`, tz),
                            tz,
                            'd'
                        );
                        const isToday = dateKey === formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
                        const isDropTarget = canDrag && dropTargetKey === dateKey;

                        return (
                            <div
                                key={dateKey}
                                data-date-key={dateKey}
                                className={
                                    'scheduler-week__day' +
                                    (isToday ? ' scheduler-week__day--today' : '') +
                                    (isDropTarget ? ' scheduler-week__day--drop-target' : '')
                                }
                            >
                                <div className="scheduler-week__day-head">
                                    <span className="scheduler-week__weekday">{WEEKDAYS[i]}</span>
                                    <span className="scheduler-week__daynum">{dayNum}</span>
                                </div>
                                <ul className="scheduler-week__jobs">
                                    {dayJobs.map((j) => (
                                        <li
                                            key={j.id}
                                            title={calendarJobTooltip(j)}
                                            className={
                                                'scheduler-week__job' +
                                                (draggingJobId === j.id ? ' scheduler-week__job--dragging' : '')
                                            }
                                            onPointerDown={
                                                canDrag
                                                    ? (e) => {
                                                          if (e.button !== 0) return;
                                                          e.preventDefault();
                                                          startPointerDrag(j.id);
                                                      }
                                                    : undefined
                                            }
                                        >
                                            <span className="scheduler-week__job-time">
                                                {formatProductionTimeShort(j.estimatedMinutesForMachine)}
                                            </span>
                                            <span className="scheduler-week__job-label">{jobPillLabel(j)}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
}
