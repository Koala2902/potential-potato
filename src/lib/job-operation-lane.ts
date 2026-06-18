import type { JobOperationLane } from '../types';

export {
    IN_PROGRESS_LANE_FUNNEL_ORDER,
    JOB_STATUS_VIEW_IN_PROGRESS_WHERE_SQL,
    JOB_STATUS_VIEW_LANE_SQL,
} from './job-operation-lane-sql';

export const JOB_OPERATION_LANE_ORDER: JobOperationLane[] = ['op001', 'op002', 'op003', 'op004'];

export const JOB_OPERATION_LANE_TITLES: Record<JobOperationLane, string> = {
    op001: 'Printed',
    op002: 'Digital Cut',
    op003: 'Slitter',
    op004: 'Production Finished',
};

/**
 * Operation lane for a job row — mirrors JobPage column placement.
 * Uses latest_completed_operation_id first, then falls back to pipeline status.
 */
export function laneForJob(job: {
    latest_completed_operation_id: string | null;
    status: string;
}): JobOperationLane {
    const statusLane = (() => {
        switch (job.status) {
            case 'production_finished':
                return 'op004' as const;
            case 'slitter':
                return 'op003' as const;
            case 'digital_cut':
                return 'op002' as const;
            default:
                return 'op001' as const;
        }
    })();

    const op = (job.latest_completed_operation_id || '').toLowerCase();
    const opLane: JobOperationLane =
        op === 'op004'
            ? 'op004'
            : op === 'op003' || op === 'op006'
              ? 'op003'
              : op === 'op002' || op === 'op005'
                ? 'op002'
                : 'op001';

    const laneRank: Record<JobOperationLane, number> = {
        op001: 1,
        op002: 2,
        op003: 3,
        op004: 4,
    };
    // Prefer the furthest-progressed lane between derived status and latest op timestamp.
    return laneRank[statusLane] >= laneRank[opLane] ? statusLane : opLane;
}

/** Same rules as JobPage in-progress fetch (excludeStatus + client filter). */
export function isJobPageInProgressRow(job: {
    status: string;
    latest_completed_operation_id: string | null;
    updated_at: string | null;
}): boolean {
    if (job.status === 'production_finished') return false;
    if (!job.latest_completed_operation_id) return false;
    if (!job.updated_at) return false;
    return true;
}

