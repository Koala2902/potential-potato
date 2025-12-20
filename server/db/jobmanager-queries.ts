import { jobmanagerPool } from './jobmanager-connection.js';

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

export interface ScannedCode {
    scan_id: number;
    code_text: string;
    scanned_at: Date;
    machine_id: string | null;
    user_id: string | null;
    operations: Record<string, any> | null;
    metadata: Record<string, any> | null;
}

// Get all machines
export async function getMachines(): Promise<Machine[]> {
    const client = await jobmanagerPool.connect();
    try {
        const result = await client.query(`
            SELECT 
                machine_id,
                machine_name,
                machine_type,
                capabilities,
                hourly_rate_aud,
                max_web_width_mm,
                availability_status,
                maintenance_schedule,
                shift_hours
            FROM machines
            WHERE availability_status != 'inactive' OR availability_status IS NULL
            ORDER BY machine_name
        `);
        return result.rows;
    } finally {
        client.release();
    }
}

export interface Operation {
    operation_id: string;
    operation_name: string;
    machine_id: string;
    operation_category: string;
    can_run_parallel: boolean;
    requires_operator: boolean;
    setup_time_base_minutes: number | null;
}

// Get available operations based on machine_id from operations table
export async function getAvailableOperations(machineId?: string | null): Promise<Operation[]> {
    if (!machineId) {
        return [];
    }

    const client = await jobmanagerPool.connect();
    try {
        const result = await client.query(`
            SELECT 
                operation_id,
                operation_name,
                machine_id,
                operation_category,
                can_run_parallel,
                requires_operator,
                setup_time_base_minutes
            FROM operations
            WHERE machine_id = $1
            ORDER BY operation_name
        `, [machineId]);
        
        return result.rows;
    } finally {
        client.release();
    }
}

// Legacy function for backward compatibility - maps operation_name to operation code
export function getOperationCode(operationName: string): string {
    const normalized = operationName.toLowerCase().trim();
    
    // Map operation names to codes
    if (normalized.includes('print')) return 'print';
    if (normalized.includes('coat')) return 'coating';
    if (normalized.includes('kiss') && normalized.includes('cut')) return 'kiss_cut';
    if (normalized.includes('backscore')) return 'backscore';
    if (normalized.includes('slit')) return 'slitter';
    
    // Default: return normalized version
    return normalized.replace(/\s+/g, '_');
}

// Record a scanned code
export async function recordScannedCode(
    codeText: string,
    machineId: string | null,
    userId: string | null,
    operations: Record<string, any> | null = null,
    metadata: Record<string, any> | null = null
): Promise<ScannedCode> {
    const client = await jobmanagerPool.connect();
    try {
        const result = await client.query(`
            INSERT INTO scanned_codes (
                code_text,
                scanned_at,
                machine_id,
                user_id,
                operations,
                metadata
            )
            VALUES ($1, NOW(), $2, $3, $4, $5)
            RETURNING *
        `, [codeText, machineId, userId, operations ? JSON.stringify(operations) : null, metadata ? JSON.stringify(metadata) : null]);

        return result.rows[0];
    } finally {
        client.release();
    }
}

// Get job by job_id or job_number
export async function getJobByIdentifier(identifier: string): Promise<any | null> {
    const client = await jobmanagerPool.connect();
    try {
        // Try job_id first
        let result = await client.query(`
            SELECT * FROM jobs WHERE job_id = $1 LIMIT 1
        `, [identifier]);

        if (result.rows.length === 0) {
            // Try job_number
            result = await client.query(`
                SELECT * FROM jobs WHERE job_number = $1 LIMIT 1
            `, [identifier]);
        }

        return result.rows.length > 0 ? result.rows[0] : null;
    } finally {
        client.release();
    }
}

