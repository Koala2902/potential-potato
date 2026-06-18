import { useEffect, useMemo, useState } from 'react';
import {
    Bar,
    BarChart,
    CartesianGrid,
    Legend,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';

import {
    AnalyticsThroughputRow,
    fetchAnalyticsThroughput,
} from '../../services/api';
import type { AnalyticsRange } from './AnalyticsPage';

interface Props {
    range: AnalyticsRange;
}

const OP_COLOURS: Record<'op001' | 'op002' | 'op003' | 'op004', string> = {
    op001: '#6366f1',
    op002: '#0ea5e9',
    op003: '#10b981',
    op004: '#f59e0b',
};

const OP_LABELS: Record<'op001' | 'op002' | 'op003' | 'op004', string> = {
    op001: 'op001 · Print',
    op002: 'op002 · Digital cut',
    op003: 'op003 · Slitter',
    op004: 'op004 · Finished',
};

function shortenDay(value: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return value.slice(5);
}

export default function ThroughputChart({ range }: Props) {
    const [data, setData] = useState<AnalyticsThroughputRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        fetchAnalyticsThroughput(range)
            .then((rows) => {
                if (!cancelled) setData(rows);
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        // Refresh periodically — op001 lands via Print OS poll (~2 min), not on scan.
        const interval = setInterval(() => {
            fetchAnalyticsThroughput(range)
                .then((rows) => {
                    if (!cancelled) setData(rows);
                })
                .catch(() => {
                    /* keep prior data on background refresh failure */
                });
        }, 60_000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [range.from, range.to]);

    const totals = useMemo(() => {
        const acc = { op001: 0, op002: 0, op003: 0, op004: 0 };
        for (const row of data) {
            acc.op001 += row.op001;
            acc.op002 += row.op002;
            acc.op003 += row.op003;
            acc.op004 += row.op004;
        }
        return acc;
    }, [data]);

    if (error) {
        return <div className="analytics-error">Failed to load throughput: {error}</div>;
    }
    if (!loading && data.length === 0) {
        return <div className="analytics-empty">No completions recorded in this range.</div>;
    }

    return (
        <div className="analytics-chart-wrapper">
            <div className="analytics-chart-totals">
                {(Object.keys(OP_LABELS) as Array<keyof typeof OP_LABELS>).map((op) => (
                    <div key={op} className="analytics-chart-total">
                        <span
                            className="analytics-chart-total-swatch"
                            style={{ background: OP_COLOURS[op] }}
                        />
                        <span className="analytics-chart-total-label">{OP_LABELS[op]}</span>
                        <span className="analytics-chart-total-value">{totals[op].toLocaleString()}</span>
                    </div>
                ))}
            </div>
            <div className="analytics-chart-canvas">
                <ResponsiveContainer width="100%" height={280}>
                    <BarChart
                        data={data}
                        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                    >
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
                        <XAxis
                            dataKey="date"
                            tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                            tickFormatter={shortenDay}
                            stroke="var(--text-tertiary)"
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
                        />
                        <Legend
                            wrapperStyle={{ fontSize: 11, color: 'var(--text-secondary)' }}
                        />
                        <Bar dataKey="op001" stackId="ops" fill={OP_COLOURS.op001} name={OP_LABELS.op001} />
                        <Bar dataKey="op002" stackId="ops" fill={OP_COLOURS.op002} name={OP_LABELS.op002} />
                        <Bar dataKey="op003" stackId="ops" fill={OP_COLOURS.op003} name={OP_LABELS.op003} />
                        <Bar dataKey="op004" stackId="ops" fill={OP_COLOURS.op004} name={OP_LABELS.op004} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
