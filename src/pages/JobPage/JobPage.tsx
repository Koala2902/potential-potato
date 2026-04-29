import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchJobs, moveJobToOperationLane } from '../../services/api';
import type { JobOperationLane, JobStatusRow } from '../../types';
import './JobPage.css';

const DRAG_JOB_MIME = 'application/x-job-page-job-id';
const LANE_ORDER: JobOperationLane[] = ['op001', 'op002', 'op003', 'op004'];
const LANE_TITLES: Record<JobOperationLane, string> = {
    op001: 'Printed',
    op002: 'Digital Cut',
    op003: 'Slitter',
    op004: 'Production Finished',
};

function laneForJob(job: JobStatusRow): JobOperationLane {
    const op = (job.latest_completed_operation_id || '').toLowerCase();
    if (op === 'op004') return 'op004';
    if (op === 'op003' || op === 'op006') return 'op003';
    if (op === 'op002' || op === 'op005') return 'op002';
    if (op === 'op001') return 'op001';

    switch (job.status) {
        case 'production_finished':
            return 'op004';
        case 'slitter':
            return 'op003';
        case 'digital_cut':
            return 'op002';
        default:
            return 'op001';
    }
}

function sortByLatestFinishedDesc(a: JobStatusRow, b: JobStatusRow): number {
    const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return tb - ta;
}

export default function JobPage() {
    const [jobs, setJobs] = useState<JobStatusRow[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [draggingJobId, setDraggingJobId] = useState<string | null>(null);
    const [dropTargetLane, setDropTargetLane] = useState<JobOperationLane | null>(null);
    const [updating, setUpdating] = useState<string | null>(null);
    const [finishedLimit, setFinishedLimit] = useState<25 | 50 | 100>(25);
    const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

    const loadJobs = useCallback(async () => {
        setError(null);
        try {
            const timeoutPromise = new Promise<JobStatusRow[]>((_, reject) => {
                setTimeout(() => reject(new Error('Loading jobs timed out. Please retry.')), 12000);
            });
            const rows = await Promise.race([
                Promise.all([
                    fetchJobs({
                        excludeStatus: 'production_finished',
                        limit: 200,
                        sort: 'none',
                        offset: 0,
                        includeRunlist: false,
                    }).then((rows) =>
                        rows.filter(
                            (row) => Boolean(row.updated_at) && Boolean(row.latest_completed_operation_id)
                        )
                    ),
                    fetchJobs({
                        status: 'production_finished',
                        limit: finishedLimit,
                        sort: 'none',
                        offset: 0,
                        includeRunlist: false,
                    }).then((rows) =>
                        rows.filter((row) => Boolean(row.latest_completed_operation_id))
                    ),
                ]).then(([inProgressRows, finishedRows]) => [...inProgressRows, ...finishedRows]),
                timeoutPromise,
            ]);
            const uniqueByJobId = new Map<string, JobStatusRow>();
            for (const row of rows) {
                if (!uniqueByJobId.has(row.job_id)) {
                    uniqueByJobId.set(row.job_id, row);
                }
            }
            setJobs(Array.from(uniqueByJobId.values()));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, [finishedLimit]);

    useEffect(() => {
        void loadJobs();
        const interval = setInterval(() => void loadJobs(), 30000);
        return () => clearInterval(interval);
    }, [loadJobs]);

    const jobsByLane = useMemo(() => {
        const grouped: Record<JobOperationLane, JobStatusRow[]> = {
            op001: [],
            op002: [],
            op003: [],
            op004: [],
        };
        for (const job of jobs) {
            grouped[laneForJob(job)].push(job);
        }
        for (const lane of LANE_ORDER) {
            grouped[lane].sort((a, b) => a.job_id.localeCompare(b.job_id));
        }
        return grouped;
    }, [jobs]);

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

    const onDropToLane = useCallback(
        async (lane: JobOperationLane, draggedJobId: string) => {
            setDropTargetLane(null);
            setDraggingJobId(null);
            setError(null);
            setUpdating(draggedJobId);
            try {
                await moveJobToOperationLane(draggedJobId, lane);
                await loadJobs();
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                setUpdating(null);
            }
        },
        [loadJobs]
    );

    return (
        <div className="job-page">
            {error && <div className="job-page__banner job-page__banner--error">{error}</div>}
            <div className="job-page__controls">
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
                                setDropTargetLane(lane);
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
                                }
                            }}
                        >
                            <header className="job-page__lane-header">
                                <h3>{LANE_TITLES[lane]}</h3>
                                <span>{jobsByLane[lane].length}</span>
                            </header>
                            <ul className="job-page__cards">
                                {groupedJobsByLanePrefix[lane].map((group) => (
                                    <li key={`${lane}-${group.prefix}`} className="job-page__group">
                                        <button
                                            type="button"
                                            className="job-page__group-header"
                                            onClick={() => {
                                                const key = `${lane}:${group.prefix}`;
                                                setCollapsedGroups((prev) => ({
                                                    ...prev,
                                                    [key]: !prev[key],
                                                }));
                                            }}
                                        >
                                            <span className="job-page__group-title">
                                                {collapsedGroups[`${lane}:${group.prefix}`] ? '▸' : '▾'}{' '}
                                                {group.prefix}
                                            </span>
                                            <span className="job-page__group-circle">
                                                {group.jobs.length}/{group.jobs.length}
                                            </span>
                                        </button>
                                        {!collapsedGroups[`${lane}:${group.prefix}`] && (
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
                                                    draggable={updating !== job.job_id}
                                                    onDragStart={(e) => {
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
                                                            {job.completed_versions}/{job.total_versions}
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
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            )}
        </div>
    );
}
