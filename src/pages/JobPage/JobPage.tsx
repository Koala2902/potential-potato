import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useViewportProfile } from '../../hooks/useViewportProfile';

import {
    isJobPageInProgressRow,
    JOB_OPERATION_LANE_ORDER,
    JOB_OPERATION_LANE_TITLES,
    laneForJob,
} from '../../lib/job-operation-lane';
import { fetchJobs, moveJobToOperationLane } from '../../services/api';
import type { JobOperationLane, JobStatusRow } from '../../types';
import './JobPage.css';

const DRAG_JOB_MIME = 'application/x-job-page-job-id';
const DRAG_GROUP_MIME = 'application/x-job-page-group-job-ids';
const LANE_ORDER = JOB_OPERATION_LANE_ORDER;
const LANE_TITLES = JOB_OPERATION_LANE_TITLES;

function sortByLatestFinishedDesc(a: JobStatusRow, b: JobStatusRow): number {
    const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return tb - ta;
}

function jobMatchesSearch(job: JobStatusRow, rawQuery: string): boolean {
    const q = rawQuery.trim().toLowerCase();
    if (!q) return true;
    if (job.job_id.toLowerCase().includes(q)) return true;
    if (job.status.toLowerCase().includes(q)) return true;
    if (job.latest_completed_operation_id?.toLowerCase().includes(q)) return true;
    if (job.runlist_id?.toLowerCase().includes(q)) return true;
    return job.version_tags.some((t) => t.toLowerCase().includes(q));
}

export default function JobPage() {
    const viewportProfile = useViewportProfile();
    const isTouch = viewportProfile === 'touch';

    const [jobs, setJobs] = useState<JobStatusRow[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [draggingJobId, setDraggingJobId] = useState<string | null>(null);
    const [draggingGroupKey, setDraggingGroupKey] = useState<string | null>(null);
    const [dropTargetLane, setDropTargetLane] = useState<JobOperationLane | null>(null);
    const [updating, setUpdating] = useState<string | null>(null);
    const [updatingGroupKey, setUpdatingGroupKey] = useState<string | null>(null);
    const [finishedLimit, setFinishedLimit] = useState<25 | 50 | 100>(25);
    const [searchQuery, setSearchQuery] = useState('');
    const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

    const loadJobsSeqRef = useRef(0);
    const loadJobsAbortRef = useRef<AbortController | null>(null);

    const loadJobs = useCallback(async () => {
        loadJobsAbortRef.current?.abort();
        const ac = new AbortController();
        loadJobsAbortRef.current = ac;
        const seq = ++loadJobsSeqRef.current;
        const fetchOpts = { signal: ac.signal };

        setError(null);
        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Loading jobs timed out. Please retry.')), 12000);
            });
            const rows = await Promise.race([
                Promise.all([
                    fetchJobs(
                        {
                            excludeStatus: 'production_finished',
                            limit: 200,
                            sort: 'none',
                            offset: 0,
                            includeRunlist: false,
                        },
                        fetchOpts
                    ).then((r) => r.filter(isJobPageInProgressRow)),
                    fetchJobs(
                        {
                            status: 'production_finished',
                            limit: finishedLimit,
                            sort: 'none',
                            offset: 0,
                            includeRunlist: false,
                        },
                        fetchOpts
                    ).then((r) => r.filter((row) => Boolean(row.latest_completed_operation_id))),
                ]).then(([inProgressRows, finishedRows]) => [...inProgressRows, ...finishedRows]),
                timeoutPromise,
            ]);
            if (seq !== loadJobsSeqRef.current) {
                return;
            }
            const uniqueByJobId = new Map<string, JobStatusRow>();
            for (const row of rows) {
                if (!uniqueByJobId.has(row.job_id)) {
                    uniqueByJobId.set(row.job_id, row);
                }
            }
            setJobs(Array.from(uniqueByJobId.values()));
        } catch (e) {
            ac.abort();
            if (seq !== loadJobsSeqRef.current) {
                return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            const aborted =
                (typeof e === 'object' &&
                    e !== null &&
                    'name' in e &&
                    (e as { name: string }).name === 'AbortError') ||
                msg === 'The user aborted a request.';
            if (aborted) {
                return;
            }
            setError(msg);
        } finally {
            if (seq === loadJobsSeqRef.current) {
                setLoading(false);
            }
        }
    }, [finishedLimit]);

    useEffect(() => {
        void loadJobs();
        const interval = setInterval(() => void loadJobs(), 15000);
        const onFocus = () => void loadJobs();
        const onVisibility = () => {
            if (document.visibilityState === 'visible') {
                void loadJobs();
            }
        };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            clearInterval(interval);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisibility);
            loadJobsAbortRef.current?.abort();
        };
    }, [loadJobs]);

    const filteredJobs = useMemo(
        () => jobs.filter((job) => jobMatchesSearch(job, searchQuery)),
        [jobs, searchQuery]
    );

    const prefixTotals = useMemo(() => {
        const totals: Record<string, number> = {};
        for (const job of filteredJobs) {
            const prefix = job.job_id.split('_')[0] || job.job_id;
            totals[prefix] = (totals[prefix] ?? 0) + 1;
        }
        return totals;
    }, [filteredJobs]);

    const jobsByLane = useMemo(() => {
        const grouped: Record<JobOperationLane, JobStatusRow[]> = {
            op001: [],
            op002: [],
            op003: [],
            op004: [],
        };
        for (const job of filteredJobs) {
            grouped[laneForJob(job)].push(job);
        }
        for (const lane of LANE_ORDER) {
            grouped[lane].sort((a, b) => a.job_id.localeCompare(b.job_id));
        }
        return grouped;
    }, [filteredJobs]);

    const groupedJobsByLanePrefix = useMemo(() => {
        const result: Record<JobOperationLane, Array<{ prefix: string; jobs: JobStatusRow[] }>> = {
            op001: [],
            op002: [],
            op003: [],
            op004: [],
        };

        for (const lane of LANE_ORDER) {
            const byPrefix = new Map<string, JobStatusRow[]>();
            for (const job of jobsByLane[lane]) {
                const prefix = job.job_id.split('_')[0] || job.job_id;
                const list = byPrefix.get(prefix) ?? [];
                list.push(job);
                byPrefix.set(prefix, list);
            }
            result[lane] = Array.from(byPrefix.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([prefix, laneJobs]) => ({
                    prefix,
                    jobs:
                        lane === 'op004'
                            ? laneJobs.sort(sortByLatestFinishedDesc)
                            : laneJobs.sort((a, b) => a.job_id.localeCompare(b.job_id)),
                }));
        }

        return result;
    }, [jobsByLane]);

    useEffect(() => {
        setCollapsedGroups((prev) => {
            const next = { ...prev };
            for (const lane of LANE_ORDER) {
                for (const group of groupedJobsByLanePrefix[lane]) {
                    const key = `${lane}:${group.prefix}`;
                    if (!(key in next)) {
                        next[key] = true;
                    }
                }
            }
            return next;
        });
    }, [groupedJobsByLanePrefix]);

    const applyJobsToLane = useCallback(
        async (lane: JobOperationLane, jobIds: string[]) => {
            setDropTargetLane(null);
            setDraggingJobId(null);
            setDraggingGroupKey(null);
            setError(null);

            const idsToMove = jobIds.filter((id) => {
                const job = jobs.find((j) => j.job_id === id);
                return job && laneForJob(job) !== lane;
            });
            if (idsToMove.length === 0) {
                return;
            }

            try {
                await Promise.all(idsToMove.map((id) => moveJobToOperationLane(id, lane)));
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                return;
            }
            await loadJobs();
        },
        [jobs, loadJobs]
    );

    const onDropToLane = useCallback(
        async (lane: JobOperationLane, draggedJobId: string) => {
            setUpdating(draggedJobId);
            try {
                await applyJobsToLane(lane, [draggedJobId]);
            } finally {
                setUpdating(null);
            }
        },
        [applyJobsToLane]
    );

    const onDropGroupToLane = useCallback(
        async (lane: JobOperationLane, groupKey: string, jobIds: string[]) => {
            setUpdatingGroupKey(groupKey);
            try {
                await applyJobsToLane(lane, jobIds);
            } finally {
                setUpdatingGroupKey(null);
            }
        },
        [applyJobsToLane]
    );

    return (
        <div className="job-page">
            {error && <div className="job-page__banner job-page__banner--error">{error}</div>}
            <div className={`job-page__controls${isTouch ? ' job-page__controls--touch' : ''}`}>
                <input
                    type="search"
                    id="job-page-search"
                    className="job-page__search"
                    placeholder="Search by job ID, status, operation, runlist, tag…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    aria-label="Search jobs"
                    autoComplete="off"
                />
                {!isTouch ? (
                    <div className="job-page__controls-trailing">
                        <label htmlFor="job-page-finished-limit">Finished jobs:</label>
                        <select
                            id="job-page-finished-limit"
                            value={finishedLimit}
                            onChange={(e) => setFinishedLimit(Number(e.target.value) as 25 | 50 | 100)}
                        >
                            <option value={25}>Last 25</option>
                            <option value={50}>Last 50</option>
                            <option value={100}>Last 100</option>
                        </select>
                    </div>
                ) : null}
            </div>
            {loading ? (
                <div className="job-page__loading">Loading jobs...</div>
            ) : (
                <div className="job-page__board">
                    {LANE_ORDER.map((lane) => (
                        <section
                            key={lane}
                            className={
                                'job-page__lane' +
                                (dropTargetLane === lane ? ' job-page__lane--drop-target' : '')
                            }
                            onDragOver={(e) => {
                                e.preventDefault();
                                e.dataTransfer.dropEffect = 'move';
                                setDropTargetLane((curr) => (curr === lane ? curr : lane));
                            }}
                            onDragLeave={(e) => {
                                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                                setDropTargetLane((curr) => (curr === lane ? null : curr));
                            }}
                            onDrop={(e) => {
                                e.preventDefault();
                                const jobId =
                                    e.dataTransfer.getData(DRAG_JOB_MIME) ||
                                    e.dataTransfer.getData('text/plain');
                                if (jobId) {
                                    void onDropToLane(lane, jobId);
                                    return;
                                }
                                const groupRaw = e.dataTransfer.getData(DRAG_GROUP_MIME);
                                if (groupRaw) {
                                    try {
                                        const parsed = JSON.parse(groupRaw) as unknown;
                                        if (
                                            Array.isArray(parsed) &&
                                            parsed.every((id) => typeof id === 'string') &&
                                            parsed.length > 0
                                        ) {
                                            const groupKey = e.dataTransfer.getData(
                                                'application/x-job-page-group-key'
                                            );
                                            void onDropGroupToLane(lane, groupKey, parsed);
                                        }
                                    } catch {
                                        /* invalid payload */
                                    }
                                    return;
                                }
                            }}
                        >
                            <header className="job-page__lane-header">
                                <h3>{LANE_TITLES[lane]}</h3>
                                <span>{jobsByLane[lane].length}</span>
                            </header>
                            <ul className="job-page__cards">
                                {groupedJobsByLanePrefix[lane].map((group) => {
                                    const groupKey = `${lane}:${group.prefix}`;
                                    const isGroupCollapsed = collapsedGroups[groupKey] ?? true;
                                    const prefixTotal = prefixTotals[group.prefix] ?? group.jobs.length;
                                    const lanePrefixCount = group.jobs.length;
                                    const usePrefixLaneProgress = prefixTotal > 1;
                                    const groupBusy =
                                        updatingGroupKey === groupKey ||
                                        group.jobs.some((j) => updating === j.job_id);
                                    return (
                                    <li
                                        key={groupKey}
                                        className={
                                            'job-page__group' +
                                            (draggingGroupKey === groupKey
                                                ? ' job-page__group--dragging'
                                                : '')
                                        }
                                        draggable={!groupBusy && isGroupCollapsed}
                                        onDragStart={(e) => {
                                            if (!isGroupCollapsed) {
                                                e.preventDefault();
                                                return;
                                            }
                                            if (
                                                (e.target as HTMLElement).closest(
                                                    '.job-page__group-collapse'
                                                )
                                            ) {
                                                e.preventDefault();
                                                return;
                                            }
                                            setDraggingGroupKey(groupKey);
                                            e.dataTransfer.setData(
                                                DRAG_GROUP_MIME,
                                                JSON.stringify(group.jobs.map((j) => j.job_id))
                                            );
                                            e.dataTransfer.setData(
                                                'application/x-job-page-group-key',
                                                groupKey
                                            );
                                            e.dataTransfer.effectAllowed = 'move';
                                        }}
                                        onDragEnd={() => {
                                            setDraggingGroupKey(null);
                                            setDropTargetLane(null);
                                        }}
                                    >
                                        <div className="job-page__group-header">
                                            <button
                                                type="button"
                                                className="job-page__group-collapse"
                                                draggable={false}
                                                onClick={() => {
                                                    setCollapsedGroups((prev) => ({
                                                        ...prev,
                                                        [groupKey]: !prev[groupKey],
                                                    }));
                                                }}
                                                aria-expanded={!isGroupCollapsed}
                                                aria-label={
                                                    isGroupCollapsed
                                                        ? `Expand ${group.prefix}`
                                                        : `Collapse ${group.prefix}`
                                                }
                                            >
                                                {isGroupCollapsed ? '▸' : '▾'}
                                            </button>
                                            <span className="job-page__group-title">{group.prefix}</span>
                                            <span className="job-page__group-circle">
                                                {usePrefixLaneProgress
                                                    ? `${lanePrefixCount}/${prefixTotal}`
                                                    : `${group.jobs.length}/${group.jobs.length}`}
                                            </span>
                                        </div>
                                        {!isGroupCollapsed && (
                                            <ul className="job-page__group-jobs">
                                            {group.jobs.map((job) => (
                                                <li
                                                    key={job.job_id}
                                                    className={
                                                        'job-page__card' +
                                                        (draggingJobId === job.job_id
                                                            ? ' job-page__card--dragging'
                                                            : '')
                                                    }
                                                    draggable={
                                                        !groupBusy &&
                                                        !isGroupCollapsed &&
                                                        updating !== job.job_id
                                                    }
                                                    onDragStart={(e) => {
                                                        e.stopPropagation();
                                                        setDraggingJobId(job.job_id);
                                                        e.dataTransfer.setData(DRAG_JOB_MIME, job.job_id);
                                                        e.dataTransfer.setData('text/plain', job.job_id);
                                                        e.dataTransfer.effectAllowed = 'move';
                                                    }}
                                                    onDragEnd={() => {
                                                        setDraggingJobId(null);
                                                        setDropTargetLane(null);
                                                    }}
                                                >
                                                    <div className="job-page__row">
                                                        <div className="job-page__job-id">{job.job_id}</div>
                                                        <div className="job-page__versions">
                                                            {usePrefixLaneProgress
                                                                ? `${lanePrefixCount}/${prefixTotal}`
                                                                : `${job.completed_versions}/${job.total_versions}`}
                                                        </div>
                                                    </div>
                                                    <div className="job-page__meta">
                                                        <span>{job.latest_completed_operation_id || 'none'}</span>
                                                    </div>
                                                </li>
                                            ))}
                                            </ul>
                                        )}
                                    </li>
                                    );
                                })}
                            </ul>
                        </section>
                    ))}
                </div>
            )}
        </div>
    );
}
