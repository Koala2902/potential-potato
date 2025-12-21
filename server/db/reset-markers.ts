import { jobmanagerPool } from './jobmanager-connection.js';

async function resetMarkers() {
    const client = await jobmanagerPool.connect();
    try {
        // Reset both markers to 0
        await client.query(
            `UPDATE processing_markers 
             SET last_processed_id = 0, 
                 last_processed_at = NOW(), 
                 updated_at = NOW() 
             WHERE marker_type IN ('print_os', 'scanned_codes')`
        );
        
        console.log('✅ Reset all markers to 0');
        
        // Verify
        const result = await client.query(
            'SELECT marker_type, last_processed_id FROM processing_markers ORDER BY marker_type'
        );
        
        console.log('\nCurrent markers:');
        result.rows.forEach(row => {
            console.log(`  ${row.marker_type}: ${row.last_processed_id}`);
        });
    } finally {
        client.release();
        await jobmanagerPool.end();
    }
}

resetMarkers()
    .then(() => {
        console.log('\n✅ Marker reset completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Error:', error);
        process.exit(1);
    });

