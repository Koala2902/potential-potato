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

export async function fetchFileId(impositionId: string): Promise<string | null> {
    const response = await fetch(`${API_BASE_URL}/imposition/${impositionId}/file-id`);
    if (!response.ok) {
        if (response.status === 404) {
            return null;
        }
        throw new Error('Failed to fetch file_id');
    }
    const data = await response.json();
    return data.fileId;
}

