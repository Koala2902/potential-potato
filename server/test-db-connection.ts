import { pool } from './config/database.js';

async function testConnection() {
  console.log('Testing database connection...');
  console.log('Configuration:');
  console.log(`  Host: ${process.env.DB_HOST || 'localhost'}`);
  console.log(`  Port: ${process.env.DB_PORT || 5432}`);
  console.log(`  Database: ${process.env.DB_NAME || 'jobmanager'}`);
  console.log(`  User: ${process.env.DB_USER || 'postgres'}`);
  console.log('');

  try {
    const client = await pool.connect();
    console.log('✅ Database connection successful!');
    
    // Test a simple query
    const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
    console.log('✅ Query test successful!');
    console.log(`  Current time: ${result.rows[0].current_time}`);
    console.log(`  PostgreSQL version: ${result.rows[0].pg_version.split(' ')[0]} ${result.rows[0].pg_version.split(' ')[1]}`);
    
    // Check if jobs table exists
    try {
      const tableCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'jobs'
        );
      `);
      
      if (tableCheck.rows[0].exists) {
        console.log('✅ Jobs table exists');
        
        // Get row count
        const countResult = await client.query('SELECT COUNT(*) as count FROM jobs');
        console.log(`  Jobs table has ${countResult.rows[0].count} rows`);
      } else {
        console.log('⚠️  Jobs table does not exist');
      }
    } catch (err) {
      console.log('⚠️  Could not check for jobs table:', (err as Error).message);
    }
    
    client.release();
    console.log('');
    console.log('✅ All tests passed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Database connection failed!');
    console.error('Error details:', error);
    
    if (error instanceof Error) {
      console.error('');
      console.error('Common issues:');
      console.error('  1. PostgreSQL is not running');
      console.error('  2. Wrong database credentials in .env file');
      console.error('  3. Database does not exist');
      console.error('  4. Network/firewall issues');
      console.error('');
      console.error('Error message:', error.message);
    }
    
    process.exit(1);
  }
}

testConnection();




