import pool from './db/connection.js';

async function checkSchema() {
  try {
    const client = await pool.connect();
    
    console.log('📊 Checking table structures...\n');
    
    // Check production_queue
    const prodQueueCols = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'production_queue'
      ORDER BY ordinal_position
    `);
    
    console.log('📋 production_queue columns:');
    prodQueueCols.rows.forEach(col => {
      console.log(`   - ${col.column_name}: ${col.data_type}`);
    });
    
    // Check runlists
    const runlistsCols = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'runlists'
      ORDER BY ordinal_position
    `);
    
    console.log('\n📋 runlists columns:');
    runlistsCols.rows.forEach(col => {
      console.log(`   - ${col.column_name}: ${col.data_type}`);
    });
    
    // Check runlist_impositions
    const runlistImposCols = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'runlist_impositions'
      ORDER BY ordinal_position
    `);
    
    console.log('\n📋 runlist_impositions columns:');
    runlistImposCols.rows.forEach(col => {
      console.log(`   - ${col.column_name}: ${col.data_type}`);
    });
    
    // Sample data from production_queue
    const sampleData = await client.query('SELECT * FROM production_queue LIMIT 3');
    console.log('\n📦 Sample data from production_queue:');
    console.log(JSON.stringify(sampleData.rows, null, 2));
    
    client.release();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkSchema();

