import pool from './connection.js';

export interface ProductionQueueItem {
    runlist_id: string;
    imposition_count: number;
    impositions: ImpositionItem[];
}

export interface ImpositionItem {
    imposition_id: string;
    simplified_name: string;
}

export interface ImpositionDetails {
    imposition_id: string;
    file_id: string;
    [key: string]: any;
}

// Get production queue grouped by runlist_id
export async function getProductionQueue(): Promise<ProductionQueueItem[]> {
    const client = await pool.connect();
    try {
        // Query production_planner_paths table grouped by runlist_id
        // Only include rows where runlist_id is not NULL
        const result = await client.query(`
            SELECT 
                runlist_id,
                COUNT(DISTINCT imposition_id) as imposition_count,
                ARRAY_AGG(DISTINCT imposition_id ORDER BY imposition_id) as imposition_ids
            FROM production_planner_paths
            WHERE runlist_id IS NOT NULL
            GROUP BY runlist_id
            ORDER BY runlist_id
        `);

        const queue: ProductionQueueItem[] = result.rows.map((row) => {
            // Simplify imposition_id names (extract meaningful part)
            const impositions: ImpositionItem[] = (row.imposition_ids || []).map((id: string) => {
                // Extract a shorter, more readable name
                // Example: "Labex_b0a315b8e5_50x50_circle_synthetic_-polypropylene_labels_gloss_laminate_280_config_1"
                // -> "50x50 Circle Config 1"
                const parts = id.split('_');
                
                // Try to get meaningful parts: size, shape, config
                const sizeMatch = parts.find(p => /^\d+x\d+/.test(p));
                const shapeMatch = parts.find(p => ['circle', 'rectangle', 'square'].includes(p.toLowerCase()));
                // Find config - it might be "config" followed by a number, or "config_1" as one part
                const configIndex = parts.findIndex(p => p.toLowerCase() === 'config');
                const configNumber = configIndex >= 0 && configIndex < parts.length - 1 ? parts[configIndex + 1] : null;
                
                let simplified = id;
                if (sizeMatch && shapeMatch && configNumber) {
                    // Format: "50x50 Circle Config 1"
                    const shapeCapitalized = shapeMatch.charAt(0).toUpperCase() + shapeMatch.slice(1);
                    simplified = `${sizeMatch} ${shapeCapitalized} Config ${configNumber}`;
                } else if (sizeMatch && configNumber) {
                    // Format: "50x50 Config 1"
                    simplified = `${sizeMatch} Config ${configNumber}`;
                } else if (sizeMatch && shapeMatch) {
                    // Format: "50x50 Circle"
                    const shapeCapitalized = shapeMatch.charAt(0).toUpperCase() + shapeMatch.slice(1);
                    simplified = `${sizeMatch} ${shapeCapitalized}`;
                } else if (parts.length > 0) {
                    // Fallback: use last few meaningful parts, capitalize first letter
                    const lastParts = parts.slice(-3);
                    simplified = lastParts.map((p, i) => 
                        i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p
                    ).join(' ');
                }
                
                return {
                    imposition_id: id,
                    simplified_name: simplified,
                };
            });

            return {
                runlist_id: row.runlist_id,
                imposition_count: parseInt(row.imposition_count) || impositions.length,
                impositions,
            };
        });

        return queue;
    } finally {
        client.release();
    }
}

// Get imposition details including all file_ids from imposition_file_mapping
export async function getImpositionDetails(impositionId: string): Promise<ImpositionDetails | null> {
    const client = await pool.connect();
    try {
        // Get imposition configuration details including explanation
        const configResult = await client.query(
            `
            SELECT DISTINCT
                ic.explanation,
                ic.pdf_quantity,
                ic.exact,
                ic.layout_across,
                ic.sheet_width,
                ic.sheet_height
            FROM imposition_configurations ic
            WHERE ic.imposition_id = $1
            LIMIT 1
        `,
            [impositionId]
        );

        if (configResult.rows.length === 0) {
            return null;
        }

        // Get all file_ids for this imposition
        const fileIds = await getFileIds(impositionId);

        return {
            imposition_id: impositionId,
            file_ids: fileIds,
            ...configResult.rows[0],
        };
    } finally {
        client.release();
    }
}

// Get all file_ids for an imposition_id
export async function getFileIds(impositionId: string): Promise<string[]> {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `
            SELECT file_id
            FROM imposition_file_mapping
            WHERE imposition_id = $1
            ORDER BY sequence_order NULLS LAST, file_id
        `,
            [impositionId]
        );

        return result.rows.map(row => row.file_id);
    } finally {
        client.release();
    }
}

// Find runlist_id by scan (format: job_id_version_tag, e.g., "4604_5889_1")
// Matches against file_id pattern: FILE_version_Labex_job_id_*
export async function findRunlistByScan(scanInput: string): Promise<string | null> {
    const client = await pool.connect();
    try {
        // Parse scan input: format is "job_id_version_tag" (e.g., "4604_5889_1")
        // Split by underscore to get parts
        const parts = scanInput.split('_');
        
        if (parts.length < 3) {
            // Try to extract version (last part) and job_id (first parts)
            // For format like "4604_5889_1", we want version=1, job_id="4604_5889"
            return null;
        }
        
        // Last part is version_tag
        const version = parts[parts.length - 1];
        // All parts except last are job_id
        const jobIdParts = parts.slice(0, -1);
        const jobId = jobIdParts.join('_');
        
        // Match file_id pattern: FILE_<version>_Labex_<job_id>_*
        // Example: FILE_1_Labex_4604_5889_...
        const pattern = `FILE_${version}_Labex_${jobId}_%`;
        
        const result = await client.query(
            `
            SELECT DISTINCT ppp.runlist_id
            FROM imposition_file_mapping ifm
            INNER JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
            WHERE ifm.file_id LIKE $1
            AND ppp.runlist_id IS NOT NULL
            LIMIT 1
        `,
            [pattern]
        );

        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0].runlist_id;
    } finally {
        client.release();
    }
}

// Get production queue filtered by runlist_id
export async function getProductionQueueByRunlist(runlistId: string): Promise<ProductionQueueItem[]> {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `
            SELECT 
                runlist_id,
                COUNT(DISTINCT imposition_id) as imposition_count,
                ARRAY_AGG(DISTINCT imposition_id ORDER BY imposition_id) as imposition_ids
            FROM production_planner_paths
            WHERE runlist_id = $1
            GROUP BY runlist_id
            ORDER BY runlist_id
        `,
            [runlistId]
        );

        const queue: ProductionQueueItem[] = result.rows.map((row) => {
            const impositions: ImpositionItem[] = (row.imposition_ids || []).map((id: string) => {
                const parts = id.split('_');
                const sizeMatch = parts.find(p => /^\d+x\d+/.test(p));
                const shapeMatch = parts.find(p => ['circle', 'rectangle', 'square'].includes(p.toLowerCase()));
                const configIndex = parts.findIndex(p => p.toLowerCase() === 'config');
                const configNumber = configIndex >= 0 && configIndex < parts.length - 1 ? parts[configIndex + 1] : null;
                
                let simplified = id;
                if (sizeMatch && shapeMatch && configNumber) {
                    const shapeCapitalized = shapeMatch.charAt(0).toUpperCase() + shapeMatch.slice(1);
                    simplified = `${sizeMatch} ${shapeCapitalized} Config ${configNumber}`;
                } else if (sizeMatch && configNumber) {
                    simplified = `${sizeMatch} Config ${configNumber}`;
                } else if (sizeMatch && shapeMatch) {
                    const shapeCapitalized = shapeMatch.charAt(0).toUpperCase() + shapeMatch.slice(1);
                    simplified = `${sizeMatch} ${shapeCapitalized}`;
                } else if (parts.length > 0) {
                    const lastParts = parts.slice(-3);
                    simplified = lastParts.map((p, i) => 
                        i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p
                    ).join(' ');
                }
                
                return {
                    imposition_id: id,
                    simplified_name: simplified,
                };
            });

            return {
                runlist_id: row.runlist_id,
                imposition_count: parseInt(row.imposition_count) || impositions.length,
                impositions,
            };
        });

        return queue;
    } finally {
        client.release();
    }
}

