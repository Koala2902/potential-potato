import pool from './db/connection.js';

async function checkTables() {
  console.log('Checking database tables...');
  console.log(`Database: ${process.env.DB_NAME || 'jobmanager'}`);
  console.log('');

  try {
    const client = await pool.connect();
    console.log('✅ Database connection successful!');
    
    // List all tables
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    
    console.log(`\n📊 Found ${tablesResult.rows.length} tables:`);
    tablesResult.rows.forEach((row, idx) => {
      console.log(`  ${idx + 1}. ${row.table_name}`);
    });
    
    // Check for production_planner_paths specifically
    const hasProductionPlanner = tablesResult.rows.some(
      row => row.table_name === 'production_planner_paths'
    );
    
    if (hasProductionPlanner) {
      console.log('\n✅ production_planner_paths table exists!');
      const countResult = await client.query('SELECT COUNT(*) as count FROM production_planner_paths');
      console.log(`   Rows: ${countResult.rows[0].count}`);
    } else {
      console.log('\n⚠️  production_planner_paths table does NOT exist');
      console.log('   This table is required for the production queue feature.');
    }
    
    // Check for other related tables
    const relatedTables = ['imposition_file_mapping', 'imposition_configurations', 'jobs'];
    console.log('\n📋 Checking for related tables:');
    relatedTables.forEach(tableName => {
      const exists = tablesResult.rows.some(row => row.table_name === tableName);
      console.log(`   ${exists ? '✅' : '❌'} ${tableName}`);
    });
    
    client.release();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkTables();

