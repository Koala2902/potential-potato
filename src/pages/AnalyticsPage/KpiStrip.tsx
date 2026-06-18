import { useEffect, useRef, useState } from 'react';
import {
    CheckCircle2,
    Layers,
    Printer,
    Activity,
    Factory,
    Timer,
} from 'lucide-react';

import {
    AnalyticsKpis,
    fetchAnalyticsKpis,
} from '../../services/api';
import type { AnalyticsRange } from './AnalyticsPage';
import { formatDurationSeconds, formatPercent } from './format';

interface Props {
    range: AnalyticsRange;
    businessDaysAllowance: number;
}

export default function KpiStrip({ range, businessDaysAllowance }: Props) {
    const [data, setData] = useState<AnalyticsKpis | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const rangeKey = `${range.from}|${range.to}`;
    const prevRangeKey = useRef(rangeKey);

    useEffect(() => {
        let cancelled = false;
        const rangeChanged = prevRangeKey.current !== rangeKey;
        prevRangeKey.current = rangeKey;
        if (rangeChanged) {
            setLoading(true);
        }
        setError(null);
        fetchAnalyticsKpis(range, { businessDaysAllowance })
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

    if (error) {
        return <div className="analytics-error">Failed to load KPIs: {error}</div>;
    }

    const items = [
        {
            icon: CheckCircle2,
            label: 'Jobs completed today',
            value: data ? data.jobsCompletedToday.toLocaleString() : '—',
            tone: 'success' as const,
        },
        {
            icon: Layers,
            label: 'Jobs completed this week',
            value: data ? data.jobsCompletedWeek.toLocaleString() : '—',
            tone: 'primary' as const,
        },
        {
            icon: Printer,
            label: 'Versions printed today',
            value: data ? data.versionsPrintedToday.toLocaleString() : '—',
            tone: 'primary' as const,
        },
        {
            icon: Timer,
            label: 'Avg cycle time (range)',
            value: data ? formatDurationSeconds(data.avgCycleSeconds) : '—',
            tone: 'neutral' as const,
        },
        {
            icon: Factory,
            label: 'Machines online',
            value: data ? data.machinesOnline.toLocaleString() : '—',
            tone: 'primary' as const,
        },
        {
            icon: Activity,
            label: 'On-time production',
            value: data ? formatPercent(data.onTimePercent) : '—',
            tone: 'success' as const,
        },
    ];

    return (
        <div className={`analytics-kpi-strip${loading ? ' analytics-kpi-strip--loading' : ''}`}>
            {items.map(({ icon: Icon, label, value, tone }) => (
                <div key={label} className={`analytics-kpi-card analytics-kpi-card--${tone}`}>
                    <div className="analytics-kpi-icon">
                        <Icon size={20} />
                    </div>
                    <div className="analytics-kpi-content">
                        <div className="analytics-kpi-label">{label}</div>
                        <div className="analytics-kpi-value">{value}</div>
                    </div>
                </div>
            ))}
        </div>
    );
}
