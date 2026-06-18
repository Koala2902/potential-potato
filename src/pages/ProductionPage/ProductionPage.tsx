import { fromZonedTime } from 'date-fns-tz';
import { Factory, CheckCircle2, Clock, Gauge, PauseCircle, WifiOff, X, Zap, type LucideIcon } from 'lucide-react';
import { useState, useEffect, useRef, startTransition } from 'react';
import { useViewportProfile } from '../../hooks/useViewportProfile';
import { fetchProductionStatus, fetchMachines, ProductionStatus, ProductionJob, Machine } from '../../services/api';
import './ProductionPage.css';
import './ProductionPageTouch.css';

export default function ProductionPage() {
    const viewportProfile = useViewportProfile();
    const isTouch = viewportProfile === 'touch';
    const [historyMachineId, setHistoryMachineId] = useState<string | null>(null);
    const [productionStatus, setProductionStatus] = useState<ProductionStatus[]>([]);
    const [machines, setMachines] = useState<Machine[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const hasLoadedOnceRef = useRef(false);
    const lastPayloadRef = useRef<string | null>(null);

    const [clockMs, setClockMs] = useState(() => Date.now());

    useEffect(() => {
        loadData();
        // Refresh every 15 seconds (production-status includes Printbeat + enrich)
        const interval = setInterval(loadData, 15000);
        const clock = setInterval(() => setClockMs(Date.now()), 30000);
        return () => {
            clearInterval(interval);
            clearInterval(clock);
        };
    }, []);

    const loadData = async () => {
        try {
            // Only full-page loading on first load; interval refresh keeps prior UI visible
            if (!hasLoadedOnceRef.current) {
                setLoading(true);
            }
            setError(null);
            const [statusData, machinesData] = await Promise.all([
                fetchProductionStatus(),
                fetchMachines(),
            ]);
            
            // Sort machines: Indigo → Digicon → Digital Cut (Bladerunner) → Slitter — use display names (machine_id is UUID).
            const SORT_ORDER_GROUPS = [
                ['INDIGO', '6900'],
                ['DIGICON'],
                ['BLADERUNNER', 'DIGITAL CUT', 'DIGITAL_CUT'],
                ['SLITTER', 'SLITTER_LINE'],
            ] as const;
            const ranked = (machineStatus: ProductionStatus): number => {
                const name =
                    machinesData.find((x) => x.machine_id === machineStatus.machine_id)?.machine_name ?? '';
                const hay = `${machineStatus.machine_id} ${name}`.toUpperCase();
                for (let i = 0; i < SORT_ORDER_GROUPS.length; i++) {
                    if (SORT_ORDER_GROUPS[i].some((tok) => hay.includes(tok))) return i;
                }
                return SORT_ORDER_GROUPS.length;
            };

            const sortedStatus = [...statusData].sort((a, b) => {
                const aRank = ranked(a);
                const bRank = ranked(b);
                if (aRank !== bRank) return aRank - bRank;
                const an =
                    machinesData.find((x) => x.machine_id === a.machine_id)?.machine_name ?? a.machine_id;
                const bn =
                    machinesData.find((x) => x.machine_id === b.machine_id)?.machine_name ?? b.machine_id;
                return an.localeCompare(bn);
            });

            const isBackgroundRefresh = hasLoadedOnceRef.current;
            const payloadKey = JSON.stringify({ status: sortedStatus, machines: machinesData });
            if (isBackgroundRefresh && lastPayloadRef.current === payloadKey) {
                return;
            }
            lastPayloadRef.current = payloadKey;

            const commit = () => {
                setProductionStatus(sortedStatus);
                setMachines(machinesData);
                hasLoadedOnceRef.current = true;
            };
            if (isBackgroundRefresh) {
                startTransition(commit);
            } else {
                commit();
            }
        } catch (err: any) {
            setError(err.message || 'Failed to load production data');
            console.error('Error loading production data:', err);
        } finally {
            setLoading(false);
        }
    };

    const getMachineName = (machineId: string): string => {
        const machine = machines.find(m => m.machine_id === machineId);
        return machine?.machine_name || machineId;
    };

    const BUSINESS_TIMEZONE = 'Australia/Sydney';

    const formatTimeAgo = (dateString: string): string => {
        if (!dateString) return 'N/A';

        const parseApiInstant = (s: string): Date => {
            const t = s.trim();
            if (!t) return new Date(NaN);
            if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
                return new Date(t);
            }
            // op001 / Print OS naive wall clock is Sydney local (matches GET /api/production-status SQL).
            const spaceForm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;
            const isoNaive = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;
            if (spaceForm.test(t) || isoNaive.test(t)) {
                const normalized = t.includes('T') ? t.replace('T', ' ') : t;
                return fromZonedTime(normalized, BUSINESS_TIMEZONE);
            }
            return new Date(t);
        };

        const date = parseApiInstant(dateString);
        // Check if date is valid
        if (isNaN(date.getTime())) {
            console.warn('Invalid date string:', dateString);
            return 'Invalid date';
        }
        
        const now = clockMs;
        const diffMs = now - date.getTime();

        // Still slightly ahead of this browser (vs server cap). Do not show a literal "future" clock time.
        if (diffMs < 0) {
            return -diffMs < 90_000 ? 'Just now' : '—';
        }
        
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffSecs < 10) return 'Just now';
        if (diffSecs < 60) return `${diffSecs}s ago`;
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        return `${diffDays}d ago`;
    };

    const formatJobRelativeTime = (job: ProductionJob): string => {
        const iso = job.last_completed_at?.trim();
        if (iso) {
            const fromInstant = formatTimeAgo(iso);
            if (fromInstant !== 'N/A' && fromInstant !== 'Invalid date') {
                return fromInstant;
            }
        }

        const ta = job.time_ago?.trim();
        if (ta) return ta;

        const raw = job.seconds_ago;
        const s = typeof raw === 'string' ? Number(raw) : raw;
        if (typeof s === 'number' && Number.isFinite(s)) {
            if (s < 0) return '—';
            if (s < 10) return 'Just now';
            if (s < 60) return `${s}s ago`;
            const minutes = Math.floor(s / 60);
            if (minutes < 60) return `${minutes}m ago`;
            const hours = Math.floor(s / 3600);
            if (hours < 24) return `${hours}h ago`;
            const days = Math.floor(s / 86400);
            return `${days}d ago`;
        }
        return iso ? formatTimeAgo(iso) : '—';
    };

    const formatDuration = (seconds: number): string => {
        if (!Number.isFinite(seconds)) return '—';
        if (seconds === 0) return '0s';
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (remainingSeconds === 0) return `${minutes}m`;
        return `${minutes}m ${remainingSeconds}s`;
    };

    const hasFiniteDuration = (v: number | string | null | undefined): boolean => {
        if (v == null || v === '') return false;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n);
    };

    const formatLiveMeters = (m: number | null | undefined): string => {
        if (m == null || !Number.isFinite(m)) return '—';
        const abs = Math.abs(m);
        const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
        return m.toFixed(digits);
    };

    /** Matches live telemetry when the press/cutter is unreachable (incl. common typo DISCONECTED). */
    const isPrintbeatPressDisconnected = (pressState: string | null | undefined): boolean => {
        const s = pressState?.trim().toLowerCase() ?? '';
        return (
            s.includes('disconnect') ||
            s.includes('disconect') ||
            /\boffline\b/.test(s)
        );
    };

    /** Press is actively printing / in production (Printbeat), independent of JOD `processing`. */
    const isPrintbeatPressBusy = (
        pressState: string | null | undefined,
        metersPerHour: number | null | undefined
    ): boolean => {
        if (isPrintbeatPressDisconnected(pressState)) return false;
        if (metersPerHour != null && Number.isFinite(metersPerHour) && metersPerHour > 0.5) {
            return true;
        }
        const s = pressState?.trim().toLowerCase() ?? '';
        if (!s) return false;
        if (/\b(idle|standby|ready|stopped|wait(ing)?|paused?|offline|sleep|maint|service)\b/.test(s)) {
            if (!/\b(print|production|impress|imprinting|running)\b/.test(s)) return false;
        }
        if (/\b(print|printing|production|impress|imprinting|running)\b/.test(s)) return true;
        if (s.includes('production')) return true;
        return false;
    };

    const humanizePressState = (raw: string): string => {
        const t = raw.trim();
        if (!t) return t;
        const parts = t.split(/[\s_]+/).filter(Boolean);
        return parts
            .map((w) => {
                if (w.length > 1 && w === w.toUpperCase()) {
                    return w.charAt(0) + w.slice(1).toLowerCase();
                }
                return w;
            })
            .join(' ');
    };

    const ProgressRing = ({ progress, size = 40 }: { progress: number; size?: number }) => {
        const radius = (size - 8) / 2;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (progress / 100) * circumference;
        const strokeWidth = 4;

        return (
            <div className="progress-ring-container" style={{ width: size, height: size }}>
                <svg width={size} height={size} className="progress-ring">
                    <circle
                        className="progress-ring-background"
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        strokeWidth={strokeWidth}
                    />
                    <circle
                        className="progress-ring-foreground"
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        strokeWidth={strokeWidth}
                        strokeDasharray={circumference}
                        strokeDashoffset={offset}
                        transform={`rotate(-90 ${size / 2} ${size / 2})`}
                    />
                </svg>
                <div className="progress-ring-text">{progress}%</div>
            </div>
        );
    };

    if (loading) {
        return (
            <div className="production-page">
                <div className="production-header">
                    <div className="production-title">
                        <Factory size={24} />
                        <h2>Production Overview</h2>
                    </div>
                </div>
                <div className="loading-state">Loading production data...</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="production-page">
                <div className="production-header">
                    <div className="production-title">
                        <Factory size={24} />
                        <h2>Production Overview</h2>
                    </div>
                </div>
                <div className="error-state">Error: {error}</div>
            </div>
        );
    }

    const touchMachines = productionStatus.slice(0, 4);
    const historyMachine = historyMachineId
        ? productionStatus.find((m) => m.machine_id === historyMachineId)
        : null;

    if (isTouch) {
        return (
            <div className="production-page production-page--touch">
                <div className="production-touch-grid">
                    {touchMachines.map((machineStatus) => {
                        const machineName = getMachineName(machineStatus.machine_id);
                        const hasProcessing = machineStatus.processing.length > 0;
                        const printbeatLive = machineStatus.printbeat_live;
                        const pressDisconnected =
                            printbeatLive != null &&
                            isPrintbeatPressDisconnected(printbeatLive.press_state);
                        const printbeatBusy =
                            printbeatLive != null &&
                            !pressDisconnected &&
                            (hasProcessing ||
                                isPrintbeatPressBusy(
                                    printbeatLive.press_state,
                                    printbeatLive.meters_per_hour
                                ));
                        let statusLabel: string;
                        let statusModifier: 'active' | 'idle' | 'disconnected';
                        if (printbeatLive != null) {
                            if (pressDisconnected) {
                                statusLabel = 'Disconnected';
                                statusModifier = 'disconnected';
                            } else {
                                const ps = printbeatLive.press_state?.trim();
                                if (ps) {
                                    statusLabel = humanizePressState(ps);
                                    statusModifier = printbeatBusy ? 'active' : 'idle';
                                } else if (printbeatBusy) {
                                    statusLabel = 'Printing';
                                    statusModifier = 'active';
                                } else {
                                    statusLabel = hasProcessing ? 'Active' : 'Idle';
                                    statusModifier = hasProcessing ? 'active' : 'idle';
                                }
                            }
                        } else {
                            statusLabel = hasProcessing ? 'Active' : 'Idle';
                            statusModifier = hasProcessing ? 'active' : 'idle';
                        }
                        return (
                            <button
                                key={machineStatus.machine_id}
                                type="button"
                                className={`production-touch-card production-touch-card--${statusModifier}`}
                                onClick={() => setHistoryMachineId(machineStatus.machine_id)}
                            >
                                <span className="production-touch-card__name">{machineName}</span>
                                <span className="production-touch-card__status">{statusLabel}</span>
                            </button>
                        );
                    })}
                </div>
                {historyMachine ? (
                    <div
                        className="production-touch-history-overlay"
                        role="presentation"
                        onClick={() => setHistoryMachineId(null)}
                    >
                        <div
                            className="production-touch-history"
                            role="dialog"
                            aria-label="Job history"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="production-touch-history__head">
                                <h3>{getMachineName(historyMachine.machine_id)}</h3>
                                <button
                                    type="button"
                                    className="production-touch-history__close"
                                    onClick={() => setHistoryMachineId(null)}
                                    aria-label="Close"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                            {historyMachine.processing.length > 0 ? (
                                <section className="production-touch-history__section">
                                    <h4>Processing</h4>
                                    <ul>
                                        {historyMachine.processing.map((job) => (
                                            <li key={job.job_id}>
                                                <strong>{job.job_id}</strong>
                                                <span>{formatJobRelativeTime(job)}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            ) : null}
                            <section className="production-touch-history__section">
                                <h4>Recent completed</h4>
                                {historyMachine.completed.length === 0 ? (
                                    <p className="production-touch-history__empty">No recent jobs</p>
                                ) : (
                                    <ul>
                                        {historyMachine.completed.map((job) => (
                                            <li key={job.job_id}>
                                                <strong>{job.job_id}</strong>
                                                <span>{formatJobRelativeTime(job)}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                        </div>
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <div className="production-page">
            <div className="production-header">
                <div className="production-title">
                    <Factory size={24} />
                    <h2>Production Overview</h2>
                </div>
            </div>

            <div className="production-machines-grid">
                {productionStatus.map((machineStatus) => {
                    const machineName = getMachineName(machineStatus.machine_id);
                    const completedCount = machineStatus.completed.length;
                    const hasProcessing = machineStatus.processing.length > 0;
                    const printbeatLive = machineStatus.printbeat_live;
                    const dcGauge = machineStatus.digital_cut_gauge;
                    const slGauge = machineStatus.slitter_gauge;
                    // Digital cut: runlist gauge (imposition `lm` roll length) over Printbeat tile.
                    // Slitter shows completed job count; slitter_gauge still suppresses empty-state when a scan exists.
                    const showDigitalCutGaugeTile = dcGauge !== undefined && dcGauge !== null;
                    const showRunlistGauge = showDigitalCutGaugeTile;
                    const showPrintbeatTile =
                        printbeatLive !== undefined && !showRunlistGauge;
                    const rlGauge = showDigitalCutGaugeTile ? dcGauge : undefined;
                    const hasSlitterRunlistContext =
                        slGauge != null &&
                        !!(
                            slGauge.latest_runlist_id ||
                            slGauge.composite_job_id ||
                            slGauge.scanned_at
                        );
                    const pressDisconnected =
                        printbeatLive != null &&
                        isPrintbeatPressDisconnected(printbeatLive.press_state);
                    const printbeatBusy =
                        printbeatLive != null &&
                        !pressDisconnected &&
                        (hasProcessing ||
                            isPrintbeatPressBusy(
                                printbeatLive.press_state,
                                printbeatLive.meters_per_hour
                            ));

                    let statusLabel: string;
                    let statusIcon: LucideIcon;
                    let statusIconModifier: 'active' | 'idle' | 'disconnected';

                    if (printbeatLive != null) {
                        if (pressDisconnected) {
                            statusLabel = 'Disconnected';
                            statusIcon = WifiOff;
                            statusIconModifier = 'disconnected';
                        } else {
                            const ps = printbeatLive.press_state?.trim();
                            if (ps) {
                                statusLabel = humanizePressState(ps);
                                statusIconModifier = printbeatBusy ? 'active' : 'idle';
                                statusIcon = printbeatBusy ? Zap : PauseCircle;
                            } else if (printbeatBusy) {
                                statusLabel = 'Printing';
                                statusIcon = Zap;
                                statusIconModifier = 'active';
                            } else {
                                statusLabel = hasProcessing ? 'Active' : 'Idle';
                                statusIcon = hasProcessing ? Zap : PauseCircle;
                                statusIconModifier = hasProcessing ? 'active' : 'idle';
                            }
                        }
                    } else {
                        statusLabel = hasProcessing ? 'Active' : 'Idle';
                        statusIcon = hasProcessing ? Zap : PauseCircle;
                        statusIconModifier = hasProcessing ? 'active' : 'idle';
                    }
                    const StatusGlyph = statusIcon;
                    const statusTitle =
                        printbeatLive != null && printbeatLive.press_state?.trim() && !pressDisconnected
                            ? printbeatLive.press_state.trim()
                            : undefined;

                    const hideNoActivityDueToRunlistGauge =
                        (rlGauge != null &&
                            !!(
                                rlGauge.latest_runlist_id ||
                                rlGauge.composite_job_id ||
                                rlGauge.scanned_at
                            )) ||
                        hasSlitterRunlistContext;

                    return (
                        <div key={machineStatus.machine_id} className="machine-production-card">
                            <div className="machine-card-header">
                                <div className="machine-card-title">
                                    <div className="machine-card-name">{machineName}</div>
                                    <div className="machine-card-code">{machineStatus.machine_id}</div>
                                </div>
                            </div>

                            <div className="machine-stats-grid">
                                <div className="machine-stat-item">
                                    {showPrintbeatTile ? (
                                        <>
                                            <div className="machine-stat-icon printbeat">
                                                <Gauge size={18} />
                                            </div>
                                            <div className="machine-stat-content">
                                                {printbeatLive == null ? (
                                                    <>
                                                        <div className="machine-stat-value">—</div>
                                                        <div className="machine-stat-label">No Printbeat row (stale press?)</div>
                                                    </>
                                                ) : (
                                                    <>
                                                        <div className="machine-stat-value machine-stat-value--stacked">
                                                            <span>
                                                                {printbeatLive.meters_per_hour != null &&
                                                                Number.isFinite(printbeatLive.meters_per_hour)
                                                                    ? `${Math.round(printbeatLive.meters_per_hour)} m/h`
                                                                    : '—'}
                                                            </span>
                                                            <span className="machine-stat-value-secondary">
                                                                {printbeatLive.meters != null &&
                                                                Number.isFinite(printbeatLive.meters)
                                                                    ? `${formatLiveMeters(printbeatLive.meters)} m`
                                                                    : '—'}
                                                            </span>
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                        </>
                                    ) : showRunlistGauge ? (
                                        <>
                                            <div className="machine-stat-icon printbeat digital-cut-gauge">
                                                <Gauge size={18} />
                                            </div>
                                            <div className="machine-stat-content">
                                                <div className="machine-stat-value machine-stat-value--stacked">
                                                    <span>
                                                        {rlGauge?.meters_per_hour != null &&
                                                        Number.isFinite(rlGauge.meters_per_hour)
                                                            ? `${Math.round(rlGauge.meters_per_hour)} m/h`
                                                            : '—'}
                                                    </span>
                                                    <span className="machine-stat-value-secondary">
                                                        {typeof rlGauge?.roll_length_metres === 'number' &&
                                                        Number.isFinite(rlGauge.roll_length_metres)
                                                            ? `${formatLiveMeters(rlGauge.roll_length_metres)} m est. roll`
                                                            : '—'}
                                                    </span>
                                                </div>
                                                <div
                                                    className="machine-stat-label machine-stat-label--press-state machine-stat-label--multiline"
                                                    title={
                                                        [
                                                            rlGauge?.latest_runlist_id,
                                                            rlGauge?.composite_job_id,
                                                            rlGauge?.pipeline_status ?? undefined,
                                                        ]
                                                            .filter(Boolean)
                                                            .join(' · ') || undefined
                                                    }
                                                >
                                                    {(() => {
                                                        const parts = [
                                                            rlGauge?.latest_runlist_id
                                                                ? rlGauge.latest_runlist_id.length > 28
                                                                    ? rlGauge.latest_runlist_id.slice(0, 28) +
                                                                      '…'
                                                                    : rlGauge.latest_runlist_id
                                                                : null,
                                                            rlGauge?.composite_job_id,
                                                            rlGauge?.pipeline_status
                                                                ? rlGauge.pipeline_status.replace(/_/g, ' ')
                                                                : null,
                                                        ].filter(Boolean) as string[];
                                                        if (!parts.length) return 'Digital cut · latest runlist scan';
                                                        return parts.join(' · ');
                                                    })()}
                                                    {rlGauge?.scanned_at ? (
                                                        <span className="machine-stat-sublabel">
                                                            {' '}
                                                            · scan {formatTimeAgo(rlGauge.scanned_at)}
                                                        </span>
                                                    ) : null}
                                                </div>
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div className="machine-stat-icon completed">
                                                <CheckCircle2 size={18} />
                                            </div>
                                            <div className="machine-stat-content">
                                                <div className="machine-stat-value">{completedCount}</div>
                                                <div className="machine-stat-label">Completed</div>
                                            </div>
                                        </>
                                    )}
                                </div>

                                <div className="machine-stat-item">
                                    <div className={`machine-stat-icon status ${statusIconModifier}`}>
                                        <StatusGlyph size={18} />
                                    </div>
                                    <div className="machine-stat-content">
                                        <div className="machine-stat-value machine-stat-value--status" title={statusTitle}>
                                            {statusLabel}
                                        </div>
                                        <div className="machine-stat-label">Status</div>
                                    </div>
                                </div>
                            </div>

                            {/* Currently Processing */}
                            {hasProcessing && (
                                <div className="machine-processing-section">
                                    <div className="section-header">
                                        <Clock size={14} className="section-icon processing" />
                                        <span>Currently Processing</span>
                                    </div>
                                    {machineStatus.processing.map((job) => (
                                        <div key={job.job_id} className="job-item processing">
                                            <div className="job-info">
                                                <div className="job-id">{job.job_id}</div>
                                                <div className="job-meta">
                                                    <span>{formatJobRelativeTime(job)}</span>
                                                    {hasFiniteDuration(job.duration_seconds) && (
                                                        <span>
                                                            •{' '}
                                                            {formatDuration(Number(job.duration_seconds))}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            {job.total_versions > job.processed_versions && (
                                                <ProgressRing progress={job.progress} size={36} />
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Recent Completed */}
                            {machineStatus.completed.length > 0 && (
                                <div className="machine-recent-activity">
                                    <div className="recent-activity-header">Recent Activity</div>
                                    <div className="recent-activity-list">
                                        {machineStatus.completed.map((job) => (
                                            <div key={job.job_id} className="recent-activity-item completed">
                                                <div className="recent-activity-job-info">
                                                    <div className="recent-activity-job-code">{job.job_id}</div>
                                                    <div className="recent-activity-time">
                                                        {formatJobRelativeTime(job)}
                                                        {hasFiniteDuration(job.duration_seconds) && (
                                                            <>
                                                                {' '}
                                                                • {formatDuration(Number(job.duration_seconds))}
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="recent-activity-status">
                                                    <CheckCircle2 size={14} className="status-icon completed" />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {machineStatus.completed.length === 0 &&
                                !hasProcessing &&
                                !hideNoActivityDueToRunlistGauge && (
                                    <div className="no-activity">No recent activity</div>
                                )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
