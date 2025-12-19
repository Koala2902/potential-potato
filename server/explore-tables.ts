import pool from './db/connection.js';

async function exploreTables() {
  try {
    const client = await pool.connect();
    
    // Find tables with imposition or file
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND (table_name LIKE '%imposition%' OR table_name LIKE '%file%')
      ORDER BY table_name
    `);
    
    console.log('📋 Tables with "imposition" or "file" in name:');
    tablesResult.rows.forEach(row => {
      console.log(`   - ${row.table_name}`);
    });
    
    // Check runlist_impositions data
    const runlistData = await client.query('SELECT * FROM runlist_impositions LIMIT 5');
    console.log('\n📦 Sample data from runlist_impositions:');
    console.log(JSON.stringify(runlistData.rows, null, 2));
    
    // Check if there's any data
    const countResult = await client.query('SELECT COUNT(*) as count FROM runlist_impositions');
    console.log(`\n📊 Total rows in runlist_impositions: ${countResult.rows[0].count}`);
    
    // Check runlists data
    const runlistsData = await client.query('SELECT * FROM runlists LIMIT 5');
    console.log('\n📦 Sample data from runlists:');
    console.log(JSON.stringify(runlistsData.rows, null, 2));
    
    client.release();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

exploreTables();

