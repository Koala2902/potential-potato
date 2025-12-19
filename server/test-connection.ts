import pool from './db/connection.js';

async function testConnection() {
  console.log('Testing database connection...');
  console.log(`Host: ${process.env.DB_HOST || 'localhost'}`);
  console.log(`Database: ${process.env.DB_NAME || 'logs'}`);
  console.log('');

  try {
    const client = await pool.connect();
    console.log('✅ Database connection successful!');
    
    // Test if production_planner_paths table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'production_planner_paths'
      );
    `);
    
    if (tableCheck.rows[0].exists) {
      console.log('✅ production_planner_paths table exists');
      
      // Get row count
      const countResult = await client.query('SELECT COUNT(*) as count FROM production_planner_paths');
      console.log(`  Table has ${countResult.rows[0].count} rows`);
      
      // Check for runlist_id column
      const runlistCheck = await client.query(`
        SELECT COUNT(*) as count 
        FROM production_planner_paths 
        WHERE runlist_id IS NOT NULL
      `);
      console.log(`  Rows with runlist_id: ${runlistCheck.rows[0].count}`);
    } else {
      console.log('❌ production_planner_paths table does NOT exist');
    }
    
    client.release();
    process.exit(0);
  } catch (error) {
    console.error('❌ Database connection failed!');
    console.error('Error:', error);
    process.exit(1);
  }
}

testConnection();

