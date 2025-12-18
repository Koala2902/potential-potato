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

// Get imposition details including file_id from imposition_file_mapping
export async function getImpositionDetails(impositionId: string): Promise<ImpositionDetails | null> {
    const client = await pool.connect();
    try {
        // Get file_id from imposition_file_mapping and join with production_planner_paths
        // Also get imposition configuration details
        const result = await client.query(
            `
            SELECT 
                ifm.imposition_id,
                ifm.file_id,
                ifm.file_path,
                ifm.sequence_order as file_sequence_order,
                ppp.runlist_id,
                ppp.production_path,
                ppp.material,
                ppp.finishing,
                ppp.steps_count,
                ic.product_id,
                ic.pdf_quantity,
                ic.pages,
                ic.exact,
                ic.layout_across,
                ic.layout_around,
                ic.sheet_width,
                ic.sheet_height,
                ic.imposed_file_path,
                ic.created_at as imposition_created_at
            FROM imposition_file_mapping ifm
            LEFT JOIN production_planner_paths ppp ON ifm.imposition_id = ppp.imposition_id
            LEFT JOIN imposition_configurations ic ON ifm.imposition_id = ic.imposition_id
            WHERE ifm.imposition_id = $1
            ORDER BY ifm.sequence_order NULLS LAST
            LIMIT 1
        `,
            [impositionId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0];
    } finally {
        client.release();
    }
}

// Get file_id for an imposition_id
export async function getFileId(impositionId: string): Promise<string | null> {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `
            SELECT file_id
            FROM imposition_file_mapping
            WHERE imposition_id = $1
            LIMIT 1
        `,
            [impositionId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0].file_id;
    } finally {
        client.release();
    }
}

