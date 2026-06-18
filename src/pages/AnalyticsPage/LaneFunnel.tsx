import { useEffect, useState } from 'react';

import { JOB_OPERATION_LANE_TITLES } from '../../lib/job-operation-lane';
import {
    AnalyticsLaneFunnelRow,
    fetchAnalyticsLaneFunnel,
} from '../../services/api';
import type { JobOperationLane } from '../../types';

const LANE_COLOURS: Record<JobOperationLane, string> = {
    op001: '#6366f1',
    op002: '#0ea5e9',
    op003: '#10b981',
    op004: '#f59e0b',
};

export default function LaneFunnel() {
    const [rows, setRows] = useState<AnalyticsLaneFunnelRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        fetchAnalyticsLaneFunnel()
            .then((result) => {
                if (!cancelled) setRows(result);
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
    }, []);

    if (error) {
        return <div className="analytics-error">Failed to load lane funnel: {error}</div>;
    }
    if (!loading && rows.length === 0) {
        return <div className="analytics-empty">No jobs in any lane.</div>;
    }

    const maxCount = Math.max(1, ...rows.map((r) => r.count));
    const total = rows.reduce((acc, r) => acc + r.count, 0);

    return (
        <div className="analytics-lane-funnel">
            <div className="analytics-lane-funnel__total">
                <span className="analytics-lane-funnel__total-value">
                    {total.toLocaleString()}
                </span>
                <span className="analytics-lane-funnel__total-label">in-progress jobs</span>
            </div>
            <ul className="analytics-lane-list">
                {rows.map((row) => {
                    const lane = row.status as JobOperationLane;
                    const label = JOB_OPERATION_LANE_TITLES[lane] ?? row.status;
                    const colour = LANE_COLOURS[lane] ?? '#94a3b8';
                    const widthPct = (row.count / maxCount) * 100;
                    return (
                        <li key={row.status} className="analytics-lane-row">
                            <div className="analytics-lane-row__top">
                                <span className="analytics-lane-row__label">{label}</span>
                                <span className="analytics-lane-row__count">
                                    {row.count.toLocaleString()}
                                </span>
                            </div>
                            <div className="analytics-lane-row__bar">
                                <div
                                    className="analytics-lane-row__bar-fill"
                                    style={{
                                        width: `${widthPct}%`,
                                        background: colour,
                                    }}
                                />
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
