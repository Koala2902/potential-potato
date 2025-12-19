import pool from './db/connection.js';

async function checkData() {
  try {
    const client = await pool.connect();
    
    // Check imposition_file_relations
    const ifrCount = await client.query('SELECT COUNT(*) as count FROM imposition_file_relations');
    console.log(`📊 imposition_file_relations: ${ifrCount.rows[0].count} rows`);
    if (parseInt(ifrCount.rows[0].count) > 0) {
      const sample = await client.query('SELECT * FROM imposition_file_relations LIMIT 3');
      console.log('Sample:', JSON.stringify(sample.rows, null, 2));
    }
    
    // Check step_repeat_impositions
    const sriCount = await client.query('SELECT COUNT(*) as count FROM step_repeat_impositions');
    console.log(`\n📊 step_repeat_impositions: ${sriCount.rows[0].count} rows`);
    if (parseInt(sriCount.rows[0].count) > 0) {
      const sample = await client.query('SELECT * FROM step_repeat_impositions LIMIT 3');
      console.log('Sample:', JSON.stringify(sample.rows, null, 2));
    }
    
    // Check jobs table
    const jobsCount = await client.query('SELECT COUNT(*) as count FROM jobs');
    console.log(`\n📊 jobs: ${jobsCount.rows[0].count} rows`);
    
    // Check runlists
    const runlistsCount = await client.query('SELECT COUNT(*) as count FROM runlists');
    console.log(`📊 runlists: ${runlistsCount.rows[0].count} rows`);
    
    // Check runlist_impositions
    const riCount = await client.query('SELECT COUNT(*) as count FROM runlist_impositions');
    console.log(`📊 runlist_impositions: ${riCount.rows[0].count} rows`);
    
    client.release();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkData();

