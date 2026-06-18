import { useEffect, useMemo, useState } from 'react';
import {
    Bar,
    BarChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';

import {
    AnalyticsOperationDurations,
    fetchAnalyticsOperationDurations,
} from '../../services/api';
import type { AnalyticsRange } from './AnalyticsPage';
import { formatDurationSeconds } from './format';

interface Props {
    range: AnalyticsRange;
}

const OPERATIONS: { id: string; label: string }[] = [
    { id: 'op001', label: 'op001 · Print' },
    { id: 'op002', label: 'op002 · Digital cut' },
    { id: 'op003', label: 'op003 · Slitter' },
    { id: 'op004', label: 'op004 · Finished' },
];

export default function OperationDurationHistogram({ range }: Props) {
    const [operationId, setOperationId] = useState<string>('op001');
    const [data, setData] = useState<AnalyticsOperationDurations | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        fetchAnalyticsOperationDurations(operationId, range)
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
    }, [operationId, range.from, range.to]);

    const chartData = useMemo(() => {
        if (!data?.bins?.length) return [];
        return data.bins.map((bin) => ({
            label: formatDurationSeconds(bin.rangeStart),
            rangeStart: bin.rangeStart,
            rangeEnd: bin.rangeEnd,
            count: bin.count,
        }));
    }, [data]);

    return (
        <div className="analytics-histogram-wrapper">
            <div className="analytics-histogram-controls">
                <label className="analytics-histogram-select">
                    Operation
                    <select
                        value={operationId}
                        onChange={(e) => setOperationId(e.target.value)}
                    >
                        {OPERATIONS.map((op) => (
                            <option key={op.id} value={op.id}>
                                {op.label}
                            </option>
                        ))}
                    </select>
                </label>
                <div className="analytics-histogram-stats">
                    <span>
                        n: <strong>{data?.n.toLocaleString() ?? '—'}</strong>
                    </span>
                    <span>
                        p50: <strong>{formatDurationSeconds(data?.p50)}</strong>
                    </span>
                    <span>
                        p90: <strong>{formatDurationSeconds(data?.p90)}</strong>
                    </span>
                    <span>
                        mean: <strong>{formatDurationSeconds(data?.mean)}</strong>
                    </span>
                </div>
            </div>

            {error ? (
                <div className="analytics-error">Failed to load: {error}</div>
            ) : !loading && (!data || data.n === 0) ? (
                <div className="analytics-empty">
                    No completed {operationId} operations in this range.
                </div>
            ) : (
                <div className="analytics-chart-canvas">
                    <ResponsiveContainer width="100%" height={220}>
                        <BarChart
                            data={chartData}
                            margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                        >
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
                            <XAxis
                                dataKey="label"
                                tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
                                stroke="var(--text-tertiary)"
                                interval="preserveStartEnd"
                            />
                            <YAxis
                                allowDecimals={false}
                                tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                                stroke="var(--text-tertiary)"
                            />
                            <Tooltip
                                cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                                contentStyle={{
                                    background: 'var(--bg-secondary)',
                                    border: '1px solid var(--border-color)',
                                    borderRadius: 6,
                                    color: 'var(--text-primary)',
                                    fontSize: 12,
                                }}
                                labelStyle={{ color: 'var(--text-secondary)' }}
                                formatter={(value: unknown, _name: unknown, ctx: any) => {
                                    const payload = ctx?.payload as
                                        | { rangeStart?: number; rangeEnd?: number }
                                        | undefined;
                                    const rs = payload?.rangeStart ?? 0;
                                    const re = payload?.rangeEnd ?? 0;
                                    return [
                                        `${value} job${value === 1 ? '' : 's'}`,
                                        `${formatDurationSeconds(rs)} – ${formatDurationSeconds(re)}`,
                                    ];
                                }}
                            />
                            <Bar dataKey="count" fill="#6366f1" radius={[2, 2, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            )}
        </div>
    );
}
