import { BarChart3 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import BusinessDaysControl from './BusinessDaysControl';
import KpiStrip from './KpiStrip';
import ThroughputChart from './ThroughputChart';
import MachinePerformanceTable from './MachinePerformanceTable';
import OperationDurationHistogram from './OperationDurationHistogram';
import LaneFunnel from './LaneFunnel';
import OnTimePanel from './OnTimePanel';

import './AnalyticsPage.css';

type PresetId = 'today' | '7d' | '30d' | '90d' | 'custom';

export interface AnalyticsRange {
    from: string;
    to: string;
}

const PRESET_LABELS: Record<Exclude<PresetId, 'custom'>, string> = {
    today: 'Today',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
};

/**
 * Compute an inclusive ISO range from a preset.
 *
 * `from` is snapped to **start of (today − (N−1)) in local time** so "Last N days" really
 * means N calendar days touched (today + the previous N−1). This avoids the off-by-one
 * a `now − N×24h` rolling window would produce mid-day. `to` is always "now".
 */
function rangeForPreset(preset: Exclude<PresetId, 'custom'>): AnalyticsRange {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    let from: Date;
    switch (preset) {
        case 'today':
            from = startOfToday;
            break;
        case '7d':
            from = new Date(startOfToday);
            from.setDate(from.getDate() - 6);
            break;
        case '30d':
            from = new Date(startOfToday);
            from.setDate(from.getDate() - 29);
            break;
        case '90d':
            from = new Date(startOfToday);
            from.setDate(from.getDate() - 89);
            break;
    }
    return { from: from.toISOString(), to: now.toISOString() };
}

/** "YYYY-MM-DD" in local tz for HTML date inputs. */
function isoToDateInputValue(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/** Date input "YYYY-MM-DD" → start-of-day ISO in local tz. */
function dateInputStartOfDayIso(value: string): string | null {
    if (!value) return null;
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Date input "YYYY-MM-DD" → end-of-day ISO in local tz. */
function dateInputEndOfDayIso(value: string): string | null {
    if (!value) return null;
    const d = new Date(`${value}T23:59:59.999`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const DEFAULT_BUSINESS_DAYS_ALLOWANCE = 5;
const BUSINESS_DAYS_DEBOUNCE_MS = 400;

function useDebouncedValue<T>(value: T, delayMs: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = window.setTimeout(() => setDebounced(value), delayMs);
        return () => window.clearTimeout(timer);
    }, [value, delayMs]);
    return debounced;
}

export default function AnalyticsPage() {
    const [preset, setPreset] = useState<PresetId>('7d');
    const [businessDaysAllowance, setBusinessDaysAllowance] = useState(
        DEFAULT_BUSINESS_DAYS_ALLOWANCE
    );
    const debouncedBusinessDays = useDebouncedValue(
        businessDaysAllowance,
        BUSINESS_DAYS_DEBOUNCE_MS
    );
    const [customFrom, setCustomFrom] = useState<string>(
        isoToDateInputValue(rangeForPreset('7d').from)
    );
    const [customTo, setCustomTo] = useState<string>(
        isoToDateInputValue(rangeForPreset('7d').to)
    );

    const range = useMemo<AnalyticsRange>(() => {
        if (preset === 'custom') {
            const fromIso = dateInputStartOfDayIso(customFrom);
            const toIso = dateInputEndOfDayIso(customTo);
            return {
                from: fromIso ?? rangeForPreset('7d').from,
                to: toIso ?? rangeForPreset('7d').to,
            };
        }
        return rangeForPreset(preset);
    }, [preset, customFrom, customTo]);

    return (
        <div className="analytics-page">
            <header className="analytics-header">
                <div className="analytics-title">
                    <BarChart3 size={28} />
                    <h2>Analytics</h2>
                </div>
                <div className="analytics-controls">
                    <div className="analytics-preset-group" role="tablist">
                        {(Object.keys(PRESET_LABELS) as Array<keyof typeof PRESET_LABELS>).map(
                            (id) => (
                                <button
                                    key={id}
                                    type="button"
                                    role="tab"
                                    aria-selected={preset === id}
                                    className={`analytics-preset-btn ${preset === id ? 'active' : ''}`}
                                    onClick={() => setPreset(id)}
                                >
                                    {PRESET_LABELS[id]}
                                </button>
                            )
                        )}
                        <button
                            type="button"
                            role="tab"
                            aria-selected={preset === 'custom'}
                            className={`analytics-preset-btn ${preset === 'custom' ? 'active' : ''}`}
                            onClick={() => setPreset('custom')}
                        >
                            Custom
                        </button>
                    </div>
                    {preset === 'custom' && (
                        <div className="analytics-custom-range">
                            <label>
                                From
                                <input
                                    type="date"
                                    value={customFrom}
                                    max={customTo || undefined}
                                    onChange={(e) => setCustomFrom(e.target.value)}
                                />
                            </label>
                            <label>
                                To
                                <input
                                    type="date"
                                    value={customTo}
                                    min={customFrom || undefined}
                                    onChange={(e) => setCustomTo(e.target.value)}
                                />
                            </label>
                        </div>
                    )}
                    <BusinessDaysControl
                        value={businessDaysAllowance}
                        onChange={setBusinessDaysAllowance}
                    />
                </div>
            </header>

            <KpiStrip range={range} businessDaysAllowance={debouncedBusinessDays} />

            <div className="analytics-grid">
                <section className="analytics-card analytics-card--wide">
                    <h3 className="analytics-card__title">Throughput</h3>
                    <p className="analytics-card__subtitle">
                        Completions per day by operation (Sydney calendar)
                    </p>
                    <ThroughputChart range={range} />
                </section>

                <section className="analytics-card">
                    <h3 className="analytics-card__title">Lane funnel</h3>
                    <p className="analytics-card__subtitle">
                        Same lanes as Job page (by latest operation, excludes finished)
                    </p>
                    <LaneFunnel />
                </section>

                <section className="analytics-card analytics-card--wide">
                    <h3 className="analytics-card__title">Per-machine performance</h3>
                    <p className="analytics-card__subtitle">
                        Utilisation, throughput and median duration within range
                    </p>
                    <MachinePerformanceTable range={range} />
                </section>

                <section className="analytics-card">
                    <h3 className="analytics-card__title">Operation duration</h3>
                    <p className="analytics-card__subtitle">
                        Histogram of measured operation durations
                    </p>
                    <OperationDurationHistogram range={range} />
                </section>

                <section className="analytics-card analytics-card--full">
                    <h3 className="analytics-card__title">On-time production</h3>
                    <p className="analytics-card__subtitle">
                        Jobs ordered in range (by created time); production complete when op004
                        finishes or slitter scans (op003/op006). On-time if finished within the
                        business-day allowance from order time. Shipping analytics coming later.
                    </p>
                    <OnTimePanel
                        range={range}
                        businessDaysAllowance={debouncedBusinessDays}
                    />
                </section>
            </div>
        </div>
    );
}
