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

export async function processScan(scanInput: string): Promise<{ runlistId: string; queue: ProductionQueueItem[] }> {
    const response = await fetch(`${API_BASE_URL}/scan`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scan: scanInput }),
    });
    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('No runlist found for this scan');
        }
        throw new Error('Failed to process scan');
    }
    return response.json();
}

