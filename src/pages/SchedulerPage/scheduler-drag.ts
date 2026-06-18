import { formatProductionTimeShort } from '../../lib/scheduler/format-production-time';
import type { CalendarJobItem } from './types';

export const DRAG_JOB_MIME = 'application/x-scheduler-job-id';

export function calendarJobTooltip(j: CalendarJobItem): string {
    const est = formatProductionTimeShort(j.estimatedMinutesForMachine);
    return [
        j.fileName ? `File: ${j.fileName}` : null,
        `Material: ${j.material}`,
        j.finishing,
        j.productionPath,
        `${j.pdfQty} copies`,
        j.source,
        `Date: ${j.dateBasis}`,
        est === '—' ? 'Est. on this machine: n/a' : `Est. on this machine: ${est}`,
    ]
        .filter((line): line is string => line != null && line !== '')
        .join(' · ');
}

export function jobPillLabel(j: CalendarJobItem, maxLen = 18): string {
    const raw = j.fileName?.trim() ? j.fileName.trim() : j.material;
    const s = raw.replace(/_/g, ' ');
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen)}…`;
}

export function dateKeyFromPointer(clientX: number, clientY: number): string | null {
    const el = document.elementFromPoint(clientX, clientY);
    const day = el?.closest('[data-date-key]');
    return day?.getAttribute('data-date-key') ?? null;
}
