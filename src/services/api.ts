import type { JobSwitchInput } from '../lib/scheduler/validations/job';
import type {
    CreateMachineInput,
    CreateOperationBodyInput,
    PatchMachineInput,
    UpdateOperationBodyInput,
} from '../lib/scheduler/validations/config';
import type { SchedulerMode, SchedulerRoutingFlow } from '../lib/scheduler/machine-routing';
import { ProductionQueueItem, ImpositionDetails, ImpositionFileItem } from '../types';

const API_BASE_URL = '/api';

export async function fetchProductionQueue(): Promise<ProductionQueueItem[]> {
    const response = await fetch(`${API_BASE_URL}/production-queue`);
    if (!response.ok) {
        throw new Error('Failed to fetch production queue');
    }
    return response.json();
}

export async function fetchImpositionDetails(impositionId: string): Promise<ImpositionDetails | null> {
    const response = await fetch(`${API_BASE_URL}/imposition/${impositionId}`);
    if (!response.ok) {
        if (response.status === 404) {
            return null;
        }
        throw new Error('Failed to fetch imposition details');
    }
    const data = (await response.json()) as ImpositionDetails;
    if (Array.isArray(data.file_items)) {
        data.file_items = data.file_items.map((item): ImpositionFileItem => {
            const qtyNum = typeof item.qty === 'number' ? item.qty : Number(item.qty);
            const qty = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : null;
            return {
                file_id: String(item.file_id),
                qty,
            };
        });
    }
    return data;
}

export async function fetchFileIds(impositionId: string): Promise<string[]> {
    const response = await fetch(`${API_BASE_URL}/imposition/${impositionId}/file-ids`);
    if (!response.ok) {
        if (response.status === 404) {
            return [];
        }
        throw new Error('Failed to fetch file_ids');
    }
    const data = await response.json();
    return data.fileIds || [];
}

export interface Machine {
    machine_id: string;
    machine_name: string;
    machine_type: string;
    capabilities: string | null;
    hourly_rate_aud: number | null;
    max_web_width_mm: number | null;
    availability_status: string | null;
    maintenance_schedule: string | null;
    shift_hours: number | null;
}

export async function fetchMachines(): Promise<Machine[]> {
    const response = await fetch(`${API_BASE_URL}/machines`);
    if (!response.ok) {
        throw new Error('Failed to fetch machines');
    }
    return response.json();
}

export interface ProductionStatus {
    machine_id: string;
    completed: ProductionJob[];
    processing: ProductionJob[];
}

export interface ProductionJob {
    job_id: string;
    processed_versions: number;
    total_versions: number;
    last_completed_at: string;
    operation_id: string;
    duration_seconds: number | null;
    progress: number;
}

export async function fetchProductionStatus(): Promise<ProductionStatus[]> {
    const response = await fetch(`${API_BASE_URL}/production-status`);
    if (!response.ok) {
        throw new Error('Failed to fetch production status');
    }
    return response.json();
}

/** Catalog row from GET /api/operations (scheduler.Operation). */
export interface ScanCatalogOperation {
    scheduler_operation_id: string;
    planner_operation_id: string | null;
    operation_name: string;
    description?: string;
    created_at?: string;
}

export async function fetchOperations(
    machineId?: string | null
): Promise<ScanCatalogOperation[]> {
    const params = new URLSearchParams();
    if (machineId?.trim()) {
        params.set('machineId', machineId.trim());
    }
    const q = params.toString();
    const url = q ? `${API_BASE_URL}/operations?${q}` : `${API_BASE_URL}/operations`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error('Failed to fetch operations');
    }
    return response.json();
}

export interface MachineMode {
    mode_id: number;
    machine_id: string;
    label: string;
    operation_ids: string[];
    sort_order: number;
}

/** Preset operation bundles from `machine_modes` (empty → use per-operation checkboxes). */
export async function fetchMachineModes(machineId: string): Promise<MachineMode[]> {
    const params = new URLSearchParams({ machineId: machineId.trim() });
    const response = await fetch(`${API_BASE_URL}/machine-modes?${params}`);
    if (!response.ok) {
        throw new Error('Failed to fetch machine modes');
    }
    return response.json();
}

/** Modes from `Machine.constants.schedulerModes` (Ticket scan UI). */
export async function fetchSchedulerModes(machineId: string): Promise<SchedulerMode[]> {
    const params = new URLSearchParams({ machineId: machineId.trim() });
    const response = await fetch(`${API_BASE_URL}/scheduler-modes?${params}`);
    if (!response.ok) {
        throw new Error('Failed to fetch scheduler modes');
    }
    return response.json();
}

export async function processScan(
    scanInput: string,
    machineId?: string | null,
    operations?: string[] | null
): Promise<{ runlistId: string; queue: ProductionQueueItem[]; scannedImpositionId?: string }> {
    const response = await fetch(`${API_BASE_URL}/scan`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
            scan: scanInput,
            machineId: machineId || null,
            operations: operations || null,
        }),
    });
    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('No runlist found for this scan');
        }
        throw new Error('Failed to process scan');
    }
    return response.json();
}

export interface JobFilterOptions {
    status?: string;
    excludeStatus?: string;
    material?: string;
    finishing?: string;
    hasPrint?: boolean;
    hasCoating?: boolean;
    hasKissCut?: boolean;
    hasBackscore?: boolean;
    hasSlitter?: boolean;
    /** ISO timestamp — filters jobs whose latest scan (`latest_completed_at`) is on or after this */
    dateFrom?: string;
    /** ISO timestamp — filters jobs whose latest scan (`latest_completed_at`) is on or before this */
    dateTo?: string;
    limit?: number;
}

export async function fetchJobs(filters?: JobFilterOptions): Promise<any[]> {
    const params = new URLSearchParams();
    
    if (filters?.status) params.append('status', filters.status);
    if (filters?.excludeStatus) params.append('excludeStatus', filters.excludeStatus);
    if (filters?.material) params.append('material', filters.material);
    if (filters?.finishing) params.append('finishing', filters.finishing);
    if (filters?.hasPrint) params.append('hasPrint', 'true');
    if (filters?.hasCoating) params.append('hasCoating', 'true');
    if (filters?.hasKissCut) params.append('hasKissCut', 'true');
    if (filters?.hasBackscore) params.append('hasBackscore', 'true');
    if (filters?.hasSlitter) params.append('hasSlitter', 'true');
    if (filters?.dateFrom) params.append('dateFrom', filters.dateFrom);
    if (filters?.dateTo) params.append('dateTo', filters.dateTo);
    if (filters?.limit) params.append('limit', filters.limit.toString());

    const url = `${API_BASE_URL}/jobs${params.toString() ? `?${params.toString()}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error('Failed to fetch jobs');
    }
    return response.json();
}

/** Per-machine calendar row from `scheduler.JobMachineSchedule`. */
export interface JobMachineScheduleRow {
    id: string;
    jobId: string;
    machineId: string;
    scheduledDate: string;
}

/** Scheduler (Prisma) jobs — distinct from `/api/jobs` scan/status jobs. */
export interface SchedulerJob {
    id: string;
    source: string;
    connectorId: string | null;
    externalId: string | null;
    machineSchedules: JobMachineScheduleRow[];
    createdAt: string;
    pdfQty: number;
    material: string;
    fileName: string | null;
    printColour: string;
    finishing: string;
    productionPath: string;
    rollQty: number | null;
    rollDirection: string | null;
    coreSizes: string[];
    dueDate: string | null;
    labelWidthMm: number | null;
    labelHeightMm: number | null;
    labelGapMm: number | null;
    labelsAcross: number | null;
    overlaminateFilm: string | null;
    rollLengthMetres: number | null;
    forClient: boolean | null;
    isSlitted: boolean | null;
    timingSource: string | null;
    timingMinutes: number | null;
    timingBreakdown: unknown;
    copies: number | null;
    dieNumberDigital: number | null;
    plateHeightMm: number | null;
    switchDieInput: Record<string, unknown> | null;
    switchEstimateOutput: Record<string, unknown> | null;
    timeEstimationStatus: string | null;
    timeEstimationError: string | null;
    timeEstimationAt: string | null;
}

export interface TimeEstimatorSettingsRow {
    id: string;
    key: string;
    label: string | null;
    flowProperties: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}

export interface SchedulerEstimateJobStep {
    machineId: string;
    machineName: string;
    machineDisplayName: string;
    effectiveSpeedMpm: number | null;
    minutes: number;
    skippedReason?: string;
}

export interface SchedulerEstimateJobBreakdown {
    jobId: string;
    productionPath: string;
    rollLengthMetres: number | null;
    routingRuleId: string | null;
    minutes: number;
    steps: SchedulerEstimateJobStep[];
}

export interface SchedulerEstimateResult {
    totalMinutes: number;
    totalDisplay: string;
    machinesUsed: string[];
    slitterThresholdTriggered: boolean;
    breakdown: unknown[];
    jobBreakdowns: SchedulerEstimateJobBreakdown[];
    batchContext: {
        totalJobsInBatch: number;
        sharedSetups: unknown[];
    };
}

export async function fetchSchedulerJobs(): Promise<SchedulerJob[]> {
    const response = await fetch(`${API_BASE_URL}/scheduler/jobs`);
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as {
            error?: unknown;
            detail?: unknown;
        };
        const server =
            (typeof j.detail === 'string' && j.detail) ||
            (typeof j.error === 'string' && j.error) ||
            response.statusText;
        throw new Error(
            `Failed to fetch scheduler jobs (${response.status})${server ? `: ${server}` : ''}`
        );
    }
    return response.json();
}

export async function patchSchedulerJobSchedule(
    jobId: string,
    body: { machineId: string; scheduledDate: string | null }
): Promise<SchedulerJob> {
    const response = await fetch(`${API_BASE_URL}/scheduler/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: unknown; detail?: unknown };
        const msg =
            (typeof j.detail === 'string' && j.detail) ||
            (typeof j.error === 'string' && j.error) ||
            response.statusText;
        throw new Error(msg || 'Failed to update job schedule');
    }
    return response.json();
}

export async function createSchedulerJob(body: JobSwitchInput): Promise<SchedulerJob> {
    const response = await fetch(`${API_BASE_URL}/scheduler/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const j = await response.json().catch(() => ({}));
        throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error ?? response.statusText));
    }
    return response.json();
}

export async function fetchTimeEstimatorSettings(): Promise<TimeEstimatorSettingsRow> {
    const response = await fetch(`${API_BASE_URL}/scheduler/settings/time-estimator`);
    if (!response.ok) {
        throw new Error('Failed to fetch time estimator settings');
    }
    return response.json();
}

export async function estimateSchedulerJobs(jobIds: string[]): Promise<SchedulerEstimateResult> {
    const response = await fetch(`${API_BASE_URL}/scheduler/estimate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds }),
    });
    if (!response.ok) {
        const j = await response.json().catch(() => ({}));
        throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error ?? response.statusText));
    }
    return response.json();
}

export interface SchedulerBatchRule {
    id: string;
    operationId: string;
    scope: string;
    groupByFields: string[];
    appliesOnce: boolean;
    thresholdValue: number | null;
    routeToMachine: string | null;
    conditionExpr: string | null;
}

export interface SchedulerOperationParam {
    id: string;
    operationId: string;
    key: string;
    value: unknown;
    valueType: string;
    label: string;
    unit: string | null;
    isConfigurable: boolean;
    sortOrder: number;
}

export interface SchedulerOperation {
    id: string;
    machineId: string;
    name: string;
    type: string;
    sortOrder: number;
    enabled: boolean;
    calcFnKey: string | null;
    notes: string | null;
    params: SchedulerOperationParam[];
    batchRule: SchedulerBatchRule | null;
}

export interface SchedulerMachine {
    id: string;
    name: string;
    displayName: string;
    enabled: boolean;
    sortOrder: number;
    constants: Record<string, unknown>;
    operations: SchedulerOperation[];
}

export interface SchedulerDiagnostics {
    database: string;
    schedulerMachineCount: number;
    /** Rows in `scheduler."Operation"` (not `public`). */
    schedulerOperationCount: number;
    publicMachineCount: number | null;
}

export async function fetchSchedulerDiagnostics(): Promise<SchedulerDiagnostics> {
    const response = await fetch(`${API_BASE_URL}/scheduler/config/diagnostics`);
    if (!response.ok) {
        throw new Error('Failed to fetch scheduler diagnostics');
    }
    return response.json();
}

export async function fetchSchedulerMachines(): Promise<SchedulerMachine[]> {
    const response = await fetch(`${API_BASE_URL}/scheduler/config/machines`);
    if (!response.ok) {
        throw new Error('Failed to fetch scheduler machines');
    }
    return response.json();
}

export async function createSchedulerMachine(body: CreateMachineInput): Promise<SchedulerMachine> {
    const response = await fetch(`${API_BASE_URL}/scheduler/config/machines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const j = await response.json().catch(() => ({}));
        throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error ?? response.statusText));
    }
    return response.json();
}

export async function createSchedulerOperation(
    machineId: string,
    body: CreateOperationBodyInput
): Promise<SchedulerOperation> {
    const response = await fetch(
        `${API_BASE_URL}/scheduler/config/machines/${machineId}/operations`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }
    );
    if (!response.ok) {
        const j = await response.json().catch(() => ({}));
        throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error ?? response.statusText));
    }
    return response.json();
}

export async function updateSchedulerOperation(
    machineId: string,
    operationId: string,
    body: UpdateOperationBodyInput
): Promise<SchedulerOperation> {
    const response = await fetch(
        `${API_BASE_URL}/scheduler/config/machines/${machineId}/operations/${operationId}`,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }
    );
    if (!response.ok) {
        const j = await response.json().catch(() => ({}));
        throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error ?? response.statusText));
    }
    return response.json();
}

export async function patchSchedulerMachine(
    machineId: string,
    body: PatchMachineInput
): Promise<SchedulerMachine> {
    const response = await fetch(`${API_BASE_URL}/scheduler/config/machines/${machineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const j = await response.json().catch(() => ({}));
        throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error ?? response.statusText));
    }
    return response.json();
}

export async function deleteSchedulerOperation(
    machineId: string,
    operationId: string
): Promise<void> {
    const response = await fetch(
        `${API_BASE_URL}/scheduler/config/machines/${machineId}/operations/${operationId}`,
        { method: 'DELETE' }
    );
    if (!response.ok) {
        const j = await response.json().catch(() => ({}));
        throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error ?? response.statusText));
    }
}

export async function fetchSchedulerRouting(): Promise<TimeEstimatorSettingsRow> {
    const response = await fetch(`${API_BASE_URL}/scheduler/settings/routing`);
    if (!response.ok) {
        throw new Error('Failed to fetch routing settings');
    }
    return response.json();
}

export async function putSchedulerRouting(
    flow: SchedulerRoutingFlow
): Promise<TimeEstimatorSettingsRow> {
    const response = await fetch(`${API_BASE_URL}/scheduler/settings/routing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flow),
    });
    if (!response.ok) {
        const j = await response.json().catch(() => ({}));
        throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error ?? response.statusText));
    }
    return response.json();
}

export async function assignToMachine(
    type: 'imposition' | 'runlist',
    id: string,
    machineId: string
): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/assign-to-machine`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            type,
            id,
            machineId,
        }),
    });
    if (!response.ok) {
        throw new Error('Failed to assign to machine');
    }
}

