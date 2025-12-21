import { ProductionQueueItem, ImpositionDetails } from '../types';

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
    return response.json();
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

export interface Operation {
    operation_id: string;
    operation_name: string;
    description?: string;
    created_at?: string;
}

export async function fetchOperations(_machineId?: string | null): Promise<Operation[]> {
    // machineId parameter is ignored - all operations are returned
    const url = `${API_BASE_URL}/operations`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error('Failed to fetch operations');
    }
    return response.json();
}

export async function processScan(
    scanInput: string,
    machineId?: string | null,
    operations?: string[] | null
): Promise<{ runlistId: string; queue: ProductionQueueItem[] }> {
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
    material?: string;
    finishing?: string;
    hasPrint?: boolean;
    hasCoating?: boolean;
    hasKissCut?: boolean;
    hasBackscore?: boolean;
    hasSlitter?: boolean;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
}

export async function fetchJobs(filters?: JobFilterOptions): Promise<any[]> {
    const params = new URLSearchParams();
    
    if (filters?.status) params.append('status', filters.status);
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

