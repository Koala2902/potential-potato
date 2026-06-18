import { Fragment, useEffect, useMemo, useState } from 'react';

import {
    AnalyticsOnTime,
    AnalyticsOnTimeJob,
    fetchAnalyticsOnTime,
} from '../../services/api';
import type { AnalyticsRange } from './AnalyticsPage';
import { formatDurationSeconds, formatHours, formatPercent } from './format';

interface Props {
    range: AnalyticsRange;
    businessDaysAllowance: number;
}

type JobFilter = 'all' | 'on_time' | 'late';

interface OrderGroup {
    orderNumber: string;
    jobs: AnalyticsOnTimeJob[];
    lateCount: number;
    maxHoursLate: number;
    orderAt: string;
    dueDate: string | null;
}

function orderNumberFromExternalId(externalId: string): string {
    const idx = externalId.indexOf('_');
    return idx === -1 ? externalId : externalId.slice(0, idx);
}

function lineFromExternalId(externalId: string): string {
    const idx = externalId.indexOf('_');
    return idx === -1 ? '—' : externalId.slice(idx + 1);
}

function groupJobsByOrderNumber(jobs: AnalyticsOnTimeJob[]): OrderGroup[] {
    const byOrder = new Map<string, AnalyticsOnTimeJob[]>();
    for (const job of jobs) {
        const orderNumber = orderNumberFromExternalId(job.externalId);
        const list = byOrder.get(orderNumber) ?? [];
        list.push(job);
        byOrder.set(orderNumber, list);
    }

    const groups: OrderGroup[] = [];
    for (const [orderNumber, orderJobs] of byOrder) {
        const sortedJobs = [...orderJobs].sort((a, b) =>
            a.externalId.localeCompare(b.externalId)
        );
        const lateJobs = sortedJobs.filter((j) => j.status === 'late');
        groups.push({
            orderNumber,
            jobs: sortedJobs,
            lateCount: lateJobs.length,
            maxHoursLate: lateJobs.reduce((max, j) => Math.max(max, j.hoursLate), 0),
            orderAt: sortedJobs[0]?.orderAt ?? '',
            dueDate: sortedJobs[0]?.dueDate ?? null,
        });
    }

    groups.sort((a, b) => {
        const aLate = a.lateCount > 0;
        const bLate = b.lateCount > 0;
        if (aLate !== bLate) {
            return aLate ? -1 : 1;
        }
        if (aLate && bLate) {
            return b.maxHoursLate - a.maxHoursLate;
        }
        return b.orderAt.localeCompare(a.orderAt);
    });

    return groups;
}

function formatDate(iso: string): string {
    try {
        const d = new Date(iso);
        return d.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return iso;
    }
}

function formatDateOnly(iso: string | null): string {
    if (!iso) return '—';
    try {
        const d = new Date(iso.includes('T') ? iso : `${iso}T12:00:00`);
        return d.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
        });
    } catch {
        return iso;
    }
}

/** Elapsed time from order placed to production completion. */
function formatProductionDuration(orderAt: string, productionDoneAt: string): string {
    try {
        const orderStart = new Date(orderAt);
        const done = new Date(productionDoneAt);
        const seconds = (done.getTime() - orderStart.getTime()) / 1000;
        if (!Number.isFinite(seconds) || seconds < 0) return '—';
        return formatDurationSeconds(seconds);
    } catch {
        return '—';
    }
}

export default function OnTimePanel({ range, businessDaysAllowance }: Props) {
    const [data, setData] = useState<AnalyticsOnTime | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [jobFilter, setJobFilter] = useState<JobFilter>('all');

    const rangeKey = `${range.from}|${range.to}`;

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        fetchAnalyticsOnTime(range, { businessDaysAllowance })
            .then((result) => {
                if (!cancelled) setData(result);
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [rangeKey, range, businessDaysAllowance]);

    const filteredJobs = useMemo(() => {
        if (!data) return [];
        if (jobFilter === 'all') return data.jobs;
        return data.jobs.filter((job) => job.status === jobFilter);
    }, [data, jobFilter]);

    const orderGroups = useMemo(
        () => groupJobsByOrderNumber(filteredJobs),
        [filteredJobs]
    );

    if (error) {
        return (
            <div className="analytics-error">
                Failed to load on-time production data: {error}
            </div>
        );
    }
    if (!loading && (!data || data.totalDue === 0)) {
        return (
            <div className="analytics-empty">
                No jobs ordered in this range have finished production yet.
            </div>
        );
    }

    const listCapNote =
        data && data.jobs.length < data.totalDue
            ? ` (showing ${data.jobs.length} of ${data.totalDue})`
            : '';

    return (
        <div className="analytics-ontime">
            <div className="analytics-ontime__summary">
                <div className="analytics-ontime__metric analytics-ontime__metric--success">
                    <div className="analytics-ontime__metric-value">
                        {formatPercent(data?.onTimePercent ?? null)}
                    </div>
                    <div className="analytics-ontime__metric-label">On-time production</div>
                </div>
                <div className="analytics-ontime__metric">
                    <div className="analytics-ontime__metric-value">
                        {data ? data.totalDue.toLocaleString() : '—'}
                    </div>
                    <div className="analytics-ontime__metric-label">
                        Completed jobs (ordered in range)
                    </div>
                </div>
                <div className="analytics-ontime__metric analytics-ontime__metric--warning">
                    <div className="analytics-ontime__metric-value">
                        {data ? data.late.toLocaleString() : '—'}
                    </div>
                    <div className="analytics-ontime__metric-label">Late</div>
                </div>
            </div>

            {data && data.jobs.length > 0 && (
                <div className="analytics-ontime__table-wrapper">
                    <div className="analytics-ontime__table-header">
                        <h4 className="analytics-ontime__table-title">
                            Production orders{listCapNote}
                        </h4>
                        <div className="analytics-preset-group" role="tablist">
                            {(
                                [
                                    { id: 'all' as const, label: 'All' },
                                    { id: 'on_time' as const, label: 'On-time' },
                                    { id: 'late' as const, label: 'Late' },
                                ] as const
                            ).map(({ id, label }) => (
                                <button
                                    key={id}
                                    type="button"
                                    role="tab"
                                    aria-selected={jobFilter === id}
                                    className={`analytics-preset-btn ${jobFilter === id ? 'active' : ''}`}
                                    onClick={() => setJobFilter(id)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>
                    {filteredJobs.length === 0 ? (
                        <div className="analytics-empty">
                            No {jobFilter === 'on_time' ? 'on-time' : 'late'} jobs in this list.
                        </div>
                    ) : (
                        <div className="analytics-table-wrapper">
                            <table className="analytics-table analytics-table--grouped">
                                <thead>
                                    <tr>
                                        <th>Line</th>
                                        <th>Order time</th>
                                        <th>Allowed until</th>
                                        <th>Production done</th>
                                        <th className="analytics-table__right">Duration</th>
                                        <th>Status</th>
                                        <th className="analytics-table__right">Late by</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {orderGroups.map((group) => (
                                        <Fragment key={group.orderNumber}>
                                            <tr
                                                className="analytics-ontime__group-row"
                                            >
                                                <td colSpan={7}>
                                                    <div className="analytics-ontime__group-header">
                                                        <code className="analytics-mono">
                                                            Order {group.orderNumber}
                                                        </code>
                                                        <span className="analytics-ontime__group-meta">
                                                            {group.jobs.length}{' '}
                                                            {group.jobs.length === 1
                                                                ? 'line'
                                                                : 'lines'}
                                                            {group.lateCount > 0
                                                                ? ` · ${group.lateCount} late`
                                                                : ''}
                                                        </span>
                                                        {group.dueDate ? (
                                                            <span className="analytics-ontime__group-dates">
                                                                Due {formatDateOnly(group.dueDate)}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                </td>
                                            </tr>
                                            {group.jobs.map((job) => (
                                                <tr
                                                    key={`${job.jobId}-${job.productionDoneAt}`}
                                                    className="analytics-ontime__line-row"
                                                >
                                                    <td>
                                                        <code className="analytics-mono">
                                                            {lineFromExternalId(job.externalId)}
                                                        </code>
                                                    </td>
                                                    <td className="analytics-table__muted">
                                                        {formatDate(job.orderAt)}
                                                    </td>
                                                    <td className="analytics-table__muted">
                                                        {formatDate(job.allowedUntil)}
                                                    </td>
                                                    <td className="analytics-table__muted">
                                                        {formatDate(job.productionDoneAt)}
                                                    </td>
                                                    <td className="analytics-table__right analytics-table__muted">
                                                        {formatProductionDuration(
                                                            job.orderAt,
                                                            job.productionDoneAt
                                                        )}
                                                    </td>
                                                    <td>
                                                        <span
                                                            className={
                                                                job.status === 'late'
                                                                    ? 'analytics-ontime__status analytics-ontime__status--late'
                                                                    : 'analytics-ontime__status analytics-ontime__status--on-time'
                                                            }
                                                        >
                                                            {job.status === 'late'
                                                                ? 'Late'
                                                                : 'On-time'}
                                                        </span>
                                                    </td>
                                                    <td
                                                        className={`analytics-table__right${
                                                            job.status === 'late'
                                                                ? ' analytics-table__warning'
                                                                : ''
                                                        }`}
                                                    >
                                                        {job.status === 'late'
                                                            ? formatHours(job.hoursLate)
                                                            : '—'}
                                                    </td>
                                                </tr>
                                            ))}
                                        </Fragment>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
