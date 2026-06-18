import type { JobSwitchInput } from '../lib/scheduler/validations/job';
import type {
    CreateMachineInput,
    CreateOperationBodyInput,
    PatchScannerDeviceInput,
    PatchMachineInput,
    UpdateOperationBodyInput,
} from '../lib/scheduler/validations/config';
import type { SchedulerMode, SchedulerRoutingFlow } from '../lib/scheduler/machine-routing';
import {
    ProductionQueueItem,
    ImpositionDetails,
    ImpositionFileItem,
    JobOperationLane,
    JobStatusRow,
} from '../types';

export interface ScanRunlistResponse {
    runlistId: string;
    queue: ProductionQueueItem[];
    scannedImpositionId?: string;
    recordedScans?: Array<{ scan_id: string; code_text: string; scanned_at: string }>;
}

export interface ScanMaterialStockResponse {
    scanKind: 'material_stock';
    materialId: string;
    /** Same shape as {@link StockMaterialRow} from GET /api/stock/materials. */
    material: Record<string, unknown>;
}

export type ProcessScanResult = ScanRunlistResponse | ScanMaterialStockResponse;

export function isMaterialStockScan(r: ProcessScanResult): r is ScanMaterialStockResponse {
    return 'scanKind' in r && (r as ScanMaterialStockResponse).scanKind === 'material_stock';
}

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

/** Live press/cutter telemetry (GET /api/production-status): Printbeat on Indigo, Bladerunner cutter live on digital_cutter. */
export interface ProductionStatusPrintbeatLive {
    press_state: string | null;
    meters_per_hour: number | null;
    meters: number | null;
    updated_at: string;
}

/** Shared shape: latest runlist scan + pipeline job + roll length (`lm` view then scheduler.Job) + m/h estimate. */
export interface ProductionRunlistLinearGauge {
    latest_runlist_id: string | null;
    scanned_at: string | null;
    composite_job_id: string | null;
    pipeline_status: string | null;
    roll_length_metres: number | null;
    meters_per_hour: number | null;
}

/** @deprecated alias of {@link ProductionRunlistLinearGauge} */
export type ProductionStatusDigitalCutGauge = ProductionRunlistLinearGauge;
export type ProductionStatusSlitterGauge = ProductionRunlistLinearGauge;

export interface ProductionStatus {
    machine_id: string;
    completed: ProductionJob[];
    processing: ProductionJob[];
    printbeat_live?: ProductionStatusPrintbeatLive | null;
    /** Digital cut: imposition `lm` roll length + m/h; shown on card instead of Printbeat tile when set. */
    digital_cut_gauge?: ProductionRunlistLinearGauge | null;
    slitter_gauge?: ProductionRunlistLinearGauge | null;
}

export interface ProductionJob {
    job_id: string;
    processed_versions: number;
    total_versions: number;
    last_completed_at: string;
    operation_id: string;
    duration_seconds: number | null;
    progress: number;
    /** Elapsed seconds since {@link last_completed_at} at JSON serialization (API server clock). */
    seconds_ago?: number | null;
    /** Pre-formatted relative label (preferred over client math). */
    time_ago?: string | null;
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
): Promise<ProcessScanResult> {
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
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 409) {
        const ids = Array.isArray(data.materialIds) ? data.materialIds.join(', ') : '';
        throw new Error(
            typeof data.error === 'string'
                ? `${data.error}${ids ? ` (${ids})` : ''}`
                : 'Ambiguous material barcode'
        );
    }
    if (!response.ok) {
        if (response.status === 404) {
            throw new Error(
                typeof data.error === 'string' ? data.error : 'No runlist found for this scan'
            );
        }
        throw new Error(typeof data.error === 'string' ? data.error : 'Failed to process scan');
    }
    return data as unknown as ProcessScanResult;
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
    offset?: number;
    markerLatestCompletedAt?: string;
    markerJobId?: string;
    sort?: 'latest' | 'none';
    includeRunlist?: boolean;
}

export async function fetchJobs(
    filters?: JobFilterOptions,
    init?: RequestInit
): Promise<JobStatusRow[]> {
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
    if (typeof filters?.offset === 'number') params.append('offset', filters.offset.toString());
    if (filters?.markerLatestCompletedAt) {
        params.append('markerLatestCompletedAt', filters.markerLatestCompletedAt);
    }
    if (filters?.markerJobId) params.append('markerJobId', filters.markerJobId);
    if (filters?.sort) params.append('sort', filters.sort);
    if (typeof filters?.includeRunlist === 'boolean') {
        params.append('includeRunlist', filters.includeRunlist ? 'true' : 'false');
    }

    const url = `${API_BASE_URL}/jobs${params.toString() ? `?${params.toString()}` : ''}`;
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error('Failed to fetch jobs');
    }
    return response.json();
}

export async function moveJobToOperationLane(
    jobId: string,
    operationId: JobOperationLane
): Promise<{
    success: boolean;
    jobId: string;
    operationId: JobOperationLane;
    scannedCodesCreated: number;
}> {
    const response = await fetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/move-operation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId }),
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const msg =
            (typeof payload?.error === 'string' && payload.error) ||
            (typeof payload?.message === 'string' && payload.message) ||
            'Failed to move job operation';
        throw new Error(msg);
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

export interface ScannerDevice {
    deviceId: string;
    label: string | null;
    hostname: string | null;
    enabled: boolean;
    machineId: string | null;
    modeId: string | null;
    operationId: string | null;
    notes: string | null;
    lastSeenAt: string | null;
    lastSeenIp: string | null;
    lastScanAt: string | null;
    createdAt: string;
    updatedAt: string;
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

export async function fetchScannerDevices(): Promise<ScannerDevice[]> {
    const response = await fetch(`${API_BASE_URL}/scheduler/config/scanner-devices`);
    if (!response.ok) {
        throw new Error('Failed to fetch scanner devices');
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

export async function patchScannerDevice(
    deviceId: string,
    body: PatchScannerDeviceInput
): Promise<ScannerDevice> {
    const response = await fetch(`${API_BASE_URL}/scheduler/config/scanner-devices/${encodeURIComponent(deviceId)}`, {
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

// ───────────────────────────────────────────────────────────────────────────────
// Analytics endpoints (GET /api/analytics/*)
//
// All endpoints accept optional `from` / `to` ISO timestamps; backend defaults
// to last 30 days. The op001 vs op002+ timezone split in `job_operation_duration`
// is normalised server-side before any aggregation.
// ───────────────────────────────────────────────────────────────────────────────

export interface AnalyticsDateRange {
    /** ISO timestamp; omit for backend default (now - 30d). */
    from?: string;
    /** ISO timestamp; omit for backend default (now). */
    to?: string;
}

function rangeToQueryString(range?: AnalyticsDateRange): string {
    if (!range) return '';
    const params = new URLSearchParams();
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    const q = params.toString();
    return q ? `?${q}` : '';
}

/** Weekdays allowed from order time before production is considered late. */
export interface AnalyticsOnTimeOptions {
    businessDaysAllowance?: number;
}

function onTimeQueryString(
    range?: AnalyticsDateRange,
    options?: AnalyticsOnTimeOptions
): string {
    const params = new URLSearchParams();
    if (range?.from) params.set('from', range.from);
    if (range?.to) params.set('to', range.to);
    if (options?.businessDaysAllowance != null) {
        params.set('businessDays', String(options.businessDaysAllowance));
    }
    const q = params.toString();
    return q ? `?${q}` : '';
}

export interface AnalyticsKpis {
    jobsCompletedToday: number;
    jobsCompletedWeek: number;
    versionsPrintedToday: number;
    avgCycleSeconds: number | null;
    machinesOnline: number;
    /** On-time production % (not shipping) for jobs ordered in range. */
    onTimePercent: number | null;
}

export async function fetchAnalyticsKpis(
    range?: AnalyticsDateRange,
    onTimeOptions?: AnalyticsOnTimeOptions
): Promise<AnalyticsKpis> {
    const response = await fetch(
        `${API_BASE_URL}/analytics/kpis${onTimeQueryString(range, onTimeOptions)}`
    );
    if (!response.ok) {
        throw new Error('Failed to fetch analytics KPIs');
    }
    return response.json();
}

export interface AnalyticsThroughputRow {
    /** YYYY-MM-DD in Australia/Sydney calendar */
    date: string;
    op001: number;
    op002: number;
    op003: number;
    op004: number;
}

export async function fetchAnalyticsThroughput(
    range?: AnalyticsDateRange
): Promise<AnalyticsThroughputRow[]> {
    const response = await fetch(
        `${API_BASE_URL}/analytics/throughput${rangeToQueryString(range)}`
    );
    if (!response.ok) {
        throw new Error('Failed to fetch analytics throughput');
    }
    return response.json();
}

export type AnalyticsDenominatorKind = 'calendar' | 'shift';
export type AnalyticsWorkDays = 'all' | 'weekdays';

export interface AnalyticsDenominatorOptions {
    kind: AnalyticsDenominatorKind;
    /** Hours per work day (only used when kind === 'shift'). */
    shiftHoursPerDay?: number;
    /** Which calendar days count as work days (only used when kind === 'shift'). */
    workDays?: AnalyticsWorkDays;
}

export interface AnalyticsDenominatorSummary {
    kind: AnalyticsDenominatorKind;
    shiftHoursPerDay: number;
    workDays: AnalyticsWorkDays;
    /** Total seconds in the chosen denominator window (used for utilisation %). */
    seconds: number;
    /** Calendar days matching `workDays` within the range; 0 when kind === 'calendar'. */
    workDaysInRange: number;
    /** Raw `to - from` seconds, regardless of denominator. */
    calendarSeconds: number;
}

export interface AnalyticsMachinePerformanceRow {
    machineId: string;
    machineName: string;
    busySeconds: number;
    denominatorSeconds: number;
    calendarSeconds: number;
    utilizationPct: number;
    jobsPerHour: number;
    medianDurationSeconds: number | null;
    opRows: number;
}

export interface AnalyticsMachinePerformanceResponse {
    denominator: AnalyticsDenominatorSummary;
    rows: AnalyticsMachinePerformanceRow[];
}

export async function fetchAnalyticsMachinePerformance(
    range?: AnalyticsDateRange,
    denominator?: AnalyticsDenominatorOptions
): Promise<AnalyticsMachinePerformanceResponse> {
    const params = new URLSearchParams();
    if (range?.from) params.set('from', range.from);
    if (range?.to) params.set('to', range.to);
    if (denominator?.kind) params.set('denominator', denominator.kind);
    if (denominator?.shiftHoursPerDay != null) {
        params.set('shiftHoursPerDay', String(denominator.shiftHoursPerDay));
    }
    if (denominator?.workDays) params.set('workDays', denominator.workDays);
    const q = params.toString();
    const url = `${API_BASE_URL}/analytics/machine-performance${q ? `?${q}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error('Failed to fetch analytics machine performance');
    }
    return response.json();
}

export interface AnalyticsDurationBin {
    rangeStart: number;
    rangeEnd: number;
    count: number;
}

export interface AnalyticsOperationDurations {
    operationId: string;
    n: number;
    mean: number | null;
    p50: number | null;
    p90: number | null;
    min: number | null;
    max: number | null;
    bins: AnalyticsDurationBin[];
}

export async function fetchAnalyticsOperationDurations(
    operationId: string,
    range?: AnalyticsDateRange
): Promise<AnalyticsOperationDurations> {
    const params = new URLSearchParams();
    if (operationId) params.set('operationId', operationId);
    if (range?.from) params.set('from', range.from);
    if (range?.to) params.set('to', range.to);
    const q = params.toString();
    const url = `${API_BASE_URL}/analytics/operation-durations${q ? `?${q}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error('Failed to fetch analytics operation durations');
    }
    return response.json();
}

export interface AnalyticsLaneFunnelRow {
    status: string;
    count: number;
}

export async function fetchAnalyticsLaneFunnel(): Promise<AnalyticsLaneFunnelRow[]> {
    const response = await fetch(`${API_BASE_URL}/analytics/lane-funnel`);
    if (!response.ok) {
        throw new Error('Failed to fetch analytics lane funnel');
    }
    return response.json();
}

export interface AnalyticsOnTimeJob {
    jobId: string;
    /** Logs pipeline job id (`{jobNumber}_{line}`). */
    externalId: string;
    /** When the order was placed (`public.jobs.created_at`). */
    orderAt: string;
    /** Customer due date from jobmanager (`due_date`), for reference. */
    dueDate: string | null;
    /** End of order date + business-days allowance window. */
    allowedUntil: string;
    /** Earliest op004 (production finished) or op003/op006 (slitter) completion. */
    productionDoneAt: string;
    /** Hours past deadline; 0 when on time. */
    hoursLate: number;
    material: string | null;
    status: 'on_time' | 'late';
}

/** @deprecated Use AnalyticsOnTimeJob */
export type AnalyticsLateJob = AnalyticsOnTimeJob;

/** On-time production metrics (production completion vs order date + business days; not shipping). */
export interface AnalyticsOnTime {
    businessDaysAllowance: number;
    totalDue: number;
    onTime: number;
    late: number;
    onTimePercent: number | null;
    jobs: AnalyticsOnTimeJob[];
}

/** Fetch on-time **production** metrics for jobs ordered in the range. */
export async function fetchAnalyticsOnTime(
    range?: AnalyticsDateRange,
    options?: AnalyticsOnTimeOptions
): Promise<AnalyticsOnTime> {
    const response = await fetch(
        `${API_BASE_URL}/analytics/on-time${onTimeQueryString(range, options)}`
    );
    if (!response.ok) {
        throw new Error('Failed to fetch analytics on-time data');
    }
    return response.json();
}

// ───────────────────────────────────────────────────────────────────────────────
// Stock / jobmanager materials (GET /api/stock/*)
// ───────────────────────────────────────────────────────────────────────────────

export interface StockMetaResponse {
    allowlistedTables: string[];
    jobmanagerUrlConfigured: boolean;
}

export async function fetchStockMeta(): Promise<StockMetaResponse> {
    const response = await fetch(`${API_BASE_URL}/stock/meta`);
    if (!response.ok) {
        throw new Error('Failed to fetch stock meta');
    }
    return response.json();
}

export interface StockMaterialGroupRow {
    group_id: string;
    group_name: string;
    group_description: string | null;
    group_color: string | null;
    sort_order: number | null;
    /** Present for `fetchStockMaterialGroupsForCatalog` — materials matching catalog filters. */
    material_count?: number;
}

export interface StockMaterialsQuery {
    q?: string;
    /** When true (default), hide rows with is_active = false. */
    activeOnly?: boolean;
    /** Filter catalog: NL Material, NP Material, or all (omit / all). */
    company?: 'NL Material' | 'NP Material' | 'all';
    /** Filter: materials in any of these group ids (comma-separated on the wire). */
    groupIds?: string[];
    /** @deprecated Use `groupIds` — first id only when set alone. */
    groupId?: string;
}

export interface StockMaterialGroupRef {
    group_id: string;
    group_name: string;
    group_color: string | null;
}

export async function fetchStockMaterialGroups(): Promise<StockMaterialGroupRow[]> {
    const response = await fetch(`${API_BASE_URL}/stock/material-groups`);
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || 'Failed to fetch material groups');
    }
    return response.json();
}

export type StockMaterialGroupCreateBody = {
    group_name: string;
    group_id?: string | null;
    group_description?: string | null;
    group_color?: string | null;
    sort_order?: number | null;
};

export async function createStockMaterialGroup(
    body: StockMaterialGroupCreateBody
): Promise<StockMaterialGroupRow> {
    const response = await fetch(`${API_BASE_URL}/stock/material-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || 'Failed to create material group');
    }
    return response.json();
}

/** Groups that appear on at least one material under the same filters as the catalog table (not the full `material_groups` table). */
export async function fetchStockMaterialGroupsForCatalog(
    query: Pick<StockMaterialsQuery, 'q' | 'activeOnly' | 'company'>
): Promise<StockMaterialGroupRow[]> {
    const params = new URLSearchParams();
    params.set('catalog', 'true');
    if (query.q) params.set('q', query.q);
    if (query.activeOnly === false) params.set('activeOnly', 'false');
    if (query.company && query.company !== 'all') {
        params.set('company', query.company);
    }
    const qs = params.toString();
    const response = await fetch(`${API_BASE_URL}/stock/material-groups?${qs}`);
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || 'Failed to fetch catalog material groups');
    }
    return response.json();
}

export interface StockMaterialRow {
    material_id: string;
    material_code: string | null;
    material_name: string | null;
    substrate_type: string | null;
    adhesive_type: string | null;
    handling: string | null;
    weight_gsm: number | null;
    width_mm: string | number | null;
    length_mm: string | number | null;
    coating: string | null;
    grain_direction: string | null;
    glossy_level: string | null;
    conductive: boolean | null;
    white_material: boolean | null;
    pricing_unit: string | null;
    substrate_group: string | null;
    /** All groups for this material (from `material_group_memberships`). */
    substrate_groups?: StockMaterialGroupRef[];
    stock: string | number | null;
    reorder_level: string | number | null;
    lead_time_days: number | null;
    cost_aud: string | number | null;
    aliases: string | null;
    is_active: boolean | null;
    internal_barcode: string | null;
    vendor_barcode: string | null;
    alternate_barcode: string | null;
    /** NL Material (legacy), NP Material (CSV import), or null before backfill. */
    company: string | null;
    /** Warehouse / shelf / bin label (nullable). */
    location: string | null;
    substrate_group_name: string | null;
    substrate_group_color: string | null;
    low_stock: boolean;
}

export async function fetchStockMaterials(query?: StockMaterialsQuery): Promise<StockMaterialRow[]> {
    const params = new URLSearchParams();
    if (query?.q) params.set('q', query.q);
    if (query?.activeOnly === false) params.set('activeOnly', 'false');
    if (query?.company && query.company !== 'all') {
        params.set('company', query.company);
    }
    const filterGroupIds =
        query?.groupIds?.filter((id) => id.trim()).map((id) => id.trim()) ??
        (query?.groupId?.trim() ? [query.groupId.trim()] : []);
    if (filterGroupIds.length > 0) {
        params.set('groupIds', filterGroupIds.join(','));
    }
    const qs = params.toString();
    const response = await fetch(`${API_BASE_URL}/stock/materials${qs ? `?${qs}` : ''}`);
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || 'Failed to fetch materials');
    }
    return response.json();
}

export interface StockSupplierPricingRow {
    pricing_id: string;
    material_id: string | null;
    supplier_id: string | null;
    supplier_material_code: string | null;
    supplier_material_name: string | null;
    cost_per_unit: string | number;
    pricing_unit: string;
    minimum_order_quantity: string | number | null;
    lead_time_days: number | null;
    is_preferred_supplier: boolean | null;
    is_active: boolean | null;
    effective_date: string | null;
    expires_date: string | null;
    notes: string | null;
    created_at: string | null;
    updated_at: string | null;
}

export async function fetchStockSupplierPricing(materialId: string): Promise<StockSupplierPricingRow[]> {
    const params = new URLSearchParams();
    params.set('materialId', materialId);
    const response = await fetch(`${API_BASE_URL}/stock/supplier-pricing?${params.toString()}`);
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || 'Failed to fetch supplier pricing');
    }
    return response.json();
}

export async function fetchStockMaterialById(materialId: string): Promise<StockMaterialRow> {
    const response = await fetch(
        `${API_BASE_URL}/stock/materials/${encodeURIComponent(materialId)}`
    );
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || 'Failed to fetch material');
    }
    return response.json();
}

export type StockMaterialBarcodeLookup =
    | { status: 'ok'; material: StockMaterialRow }
    | { status: 'not_found' }
    | { status: 'ambiguous'; materialIds: string[] }
    | { status: 'error'; message: string };

/** GET /api/stock/material-by-barcode — 200 / 404 / 409 / other. */
export async function fetchStockMaterialByBarcode(rawCode: string): Promise<StockMaterialBarcodeLookup> {
    const code = rawCode.trim();
    if (!code) {
        return { status: 'not_found' };
    }
    const params = new URLSearchParams({ code });
    const response = await fetch(`${API_BASE_URL}/stock/material-by-barcode?${params.toString()}`);
    if (response.ok) {
        const j = (await response.json()) as { material?: StockMaterialRow };
        if (!j.material?.material_id) {
            return { status: 'error', message: 'Invalid response from barcode lookup' };
        }
        return { status: 'ok', material: j.material };
    }
    if (response.status === 404) {
        return { status: 'not_found' };
    }
    if (response.status === 409) {
        const j = (await response.json().catch(() => ({}))) as { materialIds?: string[] };
        return {
            status: 'ambiguous',
            materialIds: Array.isArray(j.materialIds) ? j.materialIds : [],
        };
    }
    const j = (await response.json().catch(() => ({}))) as { error?: string };
    return { status: 'error', message: j.error || 'Failed to resolve barcode' };
}

/** Partial body for PATCH /api/stock/materials/:id — only include fields to change. */
export type StockMaterialPatch = Partial<
    Pick<
        StockMaterialRow,
        | 'internal_barcode'
        | 'vendor_barcode'
        | 'alternate_barcode'
        | 'material_code'
        | 'material_name'
        | 'substrate_type'
        | 'adhesive_type'
        | 'handling'
        | 'weight_gsm'
        | 'width_mm'
        | 'length_mm'
        | 'coating'
        | 'grain_direction'
        | 'glossy_level'
        | 'conductive'
        | 'white_material'
        | 'cost_aud'
        | 'pricing_unit'
        | 'substrate_group'
        | 'lead_time_days'
        | 'aliases'
        | 'location'
        | 'is_active'
        | 'stock'
        | 'reorder_level'
    >
> & {
    /** Replace all group memberships with these `group_id` values. */
    substrate_groups?: string[];
};

/** Body for POST /api/stock/materials — `material_code` required; server assigns `material_id` unless provided. */
export type StockMaterialCreateBody = {
    material_code: string;
    material_name?: string | null;
    company?: 'NL Material' | 'NP Material';
    material_id?: string | null;
} & Partial<StockMaterialPatch>;

export async function createStockMaterial(body: StockMaterialCreateBody): Promise<StockMaterialRow> {
    const response = await fetch(`${API_BASE_URL}/stock/materials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string; unknownKeys?: string[] };
        const extra =
            Array.isArray(j.unknownKeys) && j.unknownKeys.length > 0 ? ` (${j.unknownKeys.join(', ')})` : '';
        throw new Error((j.error || 'Failed to create material') + extra);
    }
    return response.json();
}

export async function updateStockMaterial(
    materialId: string,
    patch: StockMaterialPatch
): Promise<StockMaterialRow> {
    const response = await fetch(
        `${API_BASE_URL}/stock/materials/${encodeURIComponent(materialId)}`,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        }
    );
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string; unknownKeys?: string[] };
        const extra =
            Array.isArray(j.unknownKeys) && j.unknownKeys.length > 0
                ? ` (${j.unknownKeys.join(', ')})`
                : '';
        throw new Error((j.error || 'Failed to update material') + extra);
    }
    return response.json();
}

/** DELETE /api/stock/materials/:id — removes related rows (pricing, conversions, profiles, movement log when present), then the material. */
export async function deleteStockMaterial(materialId: string): Promise<void> {
    const response = await fetch(
        `${API_BASE_URL}/stock/materials/${encodeURIComponent(materialId)}`,
        { method: 'DELETE' }
    );
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || 'Failed to delete material');
    }
}

export interface StockAdjustResponse {
    material: StockMaterialRow;
    requested_delta: number;
    applied_delta: number;
    clamped: boolean;
}

/** POST /api/stock/materials/:id/adjust — atomic delta; negative = take out (clamped at 0 stock). */
export async function adjustStockMaterial(materialId: string, delta: number): Promise<StockAdjustResponse> {
    const response = await fetch(
        `${API_BASE_URL}/stock/materials/${encodeURIComponent(materialId)}/adjust`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delta }),
        }
    );
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || 'Failed to adjust stock');
    }
    return response.json();
}

/** GET /api/stock/materials/:id/movements — receive / take-out history from POST …/adjust. */
export interface StockMaterialMovementRow {
    movement_id: string;
    material_id: string;
    requested_delta: string;
    applied_delta: string;
    stock_before: string;
    stock_after: string;
    created_at: string;
}

export interface StockMaterialMovementsResponse {
    movements: StockMaterialMovementRow[];
    limit: number;
    offset: number;
}

export async function fetchStockMaterialMovements(
    materialId: string,
    opts?: { limit?: number; offset?: number }
): Promise<StockMaterialMovementsResponse> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    const qs = params.toString();
    const response = await fetch(
        `${API_BASE_URL}/stock/materials/${encodeURIComponent(materialId)}/movements${qs ? `?${qs}` : ''}`
    );
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || 'Failed to load stock movements');
    }
    return response.json();
}

export type StockReorderCandidateRow = StockMaterialRow & {
    supplier_minimum_order_quantity?: string | number | null;
    supplier_cost_per_unit?: string | number | null;
    suggested_order_qty_before_moq?: string | number | null;
    suggested_order_qty?: string | number | null;
};

export interface StockReorderCandidatesQuery {
    activeOnly?: boolean;
    company?: 'NL Material' | 'NP Material' | 'all';
    /** Multiplier on reorder_level for target (default 1 = bring up to reorder_level). */
    targetFactor?: number;
}

export async function fetchStockReorderCandidates(
    query?: StockReorderCandidatesQuery
): Promise<StockReorderCandidateRow[]> {
    const params = new URLSearchParams();
    if (query?.activeOnly === false) params.set('activeOnly', 'false');
    if (query?.company && query.company !== 'all') {
        params.set('company', query.company);
    }
    if (query?.targetFactor != null && Number.isFinite(query.targetFactor) && query.targetFactor > 0) {
        params.set('targetFactor', String(query.targetFactor));
    }
    const qs = params.toString();
    const response = await fetch(`${API_BASE_URL}/stock/reorder-candidates${qs ? `?${qs}` : ''}`);
    if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || 'Failed to load reorder candidates');
    }
    return response.json();
}

