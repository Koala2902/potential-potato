import { useEffect, useMemo, useState } from 'react';

import {
    AnalyticsDenominatorKind,
    AnalyticsDenominatorSummary,
    AnalyticsMachinePerformanceResponse,
    AnalyticsMachinePerformanceRow,
    AnalyticsWorkDays,
    fetchAnalyticsMachinePerformance,
} from '../../services/api';
import type { AnalyticsRange } from './AnalyticsPage';
import { formatDurationSeconds, formatPercent } from './format';

interface Props {
    range: AnalyticsRange;
}

const DEFAULT_SHIFT_HOURS = 7;

function denominatorLabel(d: AnalyticsDenominatorSummary | null): string {
    if (!d) return '';
    if (d.kind === 'calendar') return '24/7 calendar';
    const days =
        d.workDays === 'weekdays'
            ? `${d.workDaysInRange.toLocaleString()} weekdays`
            : `${d.workDaysInRange.toLocaleString()} days`;
    return `${d.shiftHoursPerDay}h × ${days}`;
}

export default function MachinePerformanceTable({ range }: Props) {
    const [kind, setKind] = useState<AnalyticsDenominatorKind>('shift');
    const [shiftHours, setShiftHours] = useState<number>(DEFAULT_SHIFT_HOURS);
    const [workDays, setWorkDays] = useState<AnalyticsWorkDays>('weekdays');

    const [data, setData] = useState<AnalyticsMachinePerformanceResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        fetchAnalyticsMachinePerformance(range, {
            kind,
            shiftHoursPerDay: shiftHours,
            workDays,
        })
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
    }, [range.from, range.to, kind, shiftHours, workDays]);

    const rows: AnalyticsMachinePerformanceRow[] = data?.rows ?? [];
    const denom = data?.denominator ?? null;

    const maxUtil = useMemo(
        () => Math.max(0.1, ...rows.map((r) => r.utilizationPct)),
        [rows]
    );

    const denomDescription = denominatorLabel(denom);

    return (
        <div className="analytics-mperf">
            <div className="analytics-mperf__controls">
                <div className="analytics-mperf__toggle" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={kind === 'shift'}
                        className={`analytics-mperf__toggle-btn ${
                            kind === 'shift' ? 'active' : ''
                        }`}
                        onClick={() => setKind('shift')}
                    >
                        Shift
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={kind === 'calendar'}
                        className={`analytics-mperf__toggle-btn ${
                            kind === 'calendar' ? 'active' : ''
                        }`}
                        onClick={() => setKind('calendar')}
                    >
                        24/7
                    </button>
                </div>

                {kind === 'shift' && (
                    <div className="analytics-mperf__shift-fields">
                        <label className="analytics-mperf__field">
                            Hours / day
                            <input
                                type="number"
                                min={1}
                                max={24}
                                step={0.5}
                                value={shiftHours}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    if (Number.isFinite(v) && v > 0 && v <= 24) {
                                        setShiftHours(v);
                                    }
                                }}
                            />
                        </label>
                        <label className="analytics-mperf__checkbox">
                            <input
                                type="checkbox"
                                checked={workDays === 'weekdays'}
                                onChange={(e) =>
                                    setWorkDays(e.target.checked ? 'weekdays' : 'all')
                                }
                            />
                            Weekdays only
                        </label>
                    </div>
                )}

                <div className="analytics-mperf__denom-label" title="Denominator used for utilisation %">
                    Denominator: <strong>{denomDescription || '—'}</strong>
                </div>
            </div>

            {error ? (
                <div className="analytics-error">Failed to load machine performance: {error}</div>
            ) : !loading && rows.length === 0 ? (
                <div className="analytics-empty">
                    No machine activity recorded in this range.
                </div>
            ) : (
                <div className="analytics-table-wrapper">
                    <table className="analytics-table">
                        <thead>
                            <tr>
                                <th>Machine</th>
                                <th className="analytics-table__right">Utilisation</th>
                                <th className="analytics-table__right">Busy time</th>
                                <th className="analytics-table__right">Jobs / hr</th>
                                <th className="analytics-table__right">Median op</th>
                                <th className="analytics-table__right">Op rows</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => {
                                const widthPct = (row.utilizationPct / maxUtil) * 100;
                                const over100 = row.utilizationPct > 100;
                                return (
                                    <tr key={row.machineId}>
                                        <td>
                                            <div className="analytics-table__machine-name">
                                                {row.machineName}
                                            </div>
                                        </td>
                                        <td className="analytics-table__right">
                                            <div className="analytics-table__util-cell">
                                                <span
                                                    className={
                                                        over100
                                                            ? 'analytics-table__warning'
                                                            : undefined
                                                    }
                                                >
                                                    {formatPercent(row.utilizationPct)}
                                                </span>
                                                <div className="analytics-table__util-bar">
                                                    <div
                                                        className="analytics-table__util-bar-fill"
                                                        style={{
                                                            width: `${Math.min(100, widthPct)}%`,
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        </td>
                                        <td className="analytics-table__right">
                                            {formatDurationSeconds(row.busySeconds)}
                                        </td>
                                        <td className="analytics-table__right">
                                            {row.jobsPerHour.toFixed(2)}
                                        </td>
                                        <td className="analytics-table__right">
                                            {formatDurationSeconds(row.medianDurationSeconds)}
                                        </td>
                                        <td className="analytics-table__right">
                                            {row.opRows.toLocaleString()}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
