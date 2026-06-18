import { fromZonedTime } from 'date-fns-tz';

/** op001 / Print OS `job_complete_time`: naive wall clock in Australia/Sydney (see migration 035 rationale). */
export const BUSINESS_TIMEZONE = 'Australia/Sydney';

/**
 * Naive Sydney wall-clock → UTC ISO (Print OS `job_complete_time`, op001 JOD writers).
 * Prefer SQL `(col AT TIME ZONE 'Australia/Sydney')` when querying; this covers raw strings and
 * node-pg Date values that already represent the correct instant (post-AT TIME ZONE).
 */
export function pgSydneyNaiveToIsoUtc(value: unknown): string | null {
    if (value == null) return null;
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s) return null;
        if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
            const d = new Date(s);
            return Number.isFinite(d.getTime()) ? d.toISOString() : null;
        }
        const normalized = s.includes('T') ? s : s.replace(' ', 'T');
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(normalized)) {
            const d = fromZonedTime(normalized.replace('T', ' '), BUSINESS_TIMEZONE);
            return Number.isFinite(d.getTime()) ? d.toISOString() : null;
        }
    }
    return pgTimestampToIsoUtc(value);
}

/**
 * Convert PostgreSQL / node-pg timestamp outputs to canonical UTC ISO-8601 for JSON APIs.
 * Avoids ambiguous parsing when strings lack a timezone (treat naive `...T...` as UTC).
 */
export function pgTimestampToIsoUtc(value: unknown): string | null {
    if (value == null) return null;
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value).toISOString();
    }
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s) return null;
        if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
            const d = new Date(s);
            return Number.isFinite(d.getTime()) ? d.toISOString() : null;
        }
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
            const d = new Date(`${s}Z`);
            return Number.isFinite(d.getTime()) ? d.toISOString() : null;
        }
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
            const d = new Date(`${s.replace(' ', 'T')}Z`);
            return Number.isFinite(d.getTime()) ? d.toISOString() : null;
        }
        const d = new Date(s);
        return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
    return null;
}
