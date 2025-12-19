import pg from 'pg';

const { Pool } = pg;

async function compareDatabases() {
  const config = {
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'postgres',
  };

  console.log('🔍 Comparing two databases...\n');
  console.log('Configuration:');
  console.log(`  Host: ${config.host}`);
  console.log(`  Port: ${config.port}`);
  console.log(`  User: ${config.user}\n`);

  // Test jobmanager database
  console.log('═══════════════════════════════════════');
  console.log('📊 DATABASE: jobmanager');
  console.log('═══════════════════════════════════════');
  
  const jobmanagerPool = new Pool({ ...config, database: 'jobmanager' });
  try {
    const client = await jobmanagerPool.connect();
    
    // Get table count
    const tablesResult = await client.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    console.log(`✅ Connected! Tables: ${tablesResult.rows[0].count}`);
    
    // Check for key tables
    const keyTables = ['production_planner_paths', 'runlists', 'runlist_impositions', 'jobs', 'imposition_file_mapping', 'imposition_configurations'];
    console.log('\n📋 Key tables status:');
    for (const tableName of keyTables) {
      const exists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name = $1
        )
      `, [tableName]);
      const hasData = exists.rows[0].exists ? await client.query(`SELECT COUNT(*) as count FROM ${tableName}`) : null;
      const count = hasData ? parseInt(hasData.rows[0].count) : 0;
      console.log(`   ${exists.rows[0].exists ? '✅' : '❌'} ${tableName}: ${exists.rows[0].exists ? `${count} rows` : 'does not exist'}`);
    }
    
    client.release();
    await jobmanagerPool.end();
  } catch (error) {
    console.error('❌ Error connecting to jobmanager:', (error as Error).message);
  }

  console.log('\n');

  // Test logs database
  console.log('═══════════════════════════════════════');
  console.log('📊 DATABASE: logs');
  console.log('═══════════════════════════════════════');
  
  const logsPool = new Pool({ ...config, database: 'logs' });
  try {
    const client = await logsPool.connect();
    
    // Get table count
    const tablesResult = await client.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    console.log(`✅ Connected! Tables: ${tablesResult.rows[0].count}`);
    
    // Check for key tables
    const keyTables = ['production_planner_paths', 'runlists', 'runlist_impositions', 'jobs', 'imposition_file_mapping', 'imposition_configurations'];
    console.log('\n📋 Key tables status:');
    for (const tableName of keyTables) {
      const exists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name = $1
        )
      `, [tableName]);
      const hasData = exists.rows[0].exists ? await client.query(`SELECT COUNT(*) as count FROM ${tableName}`) : null;
      const count = hasData ? parseInt(hasData.rows[0].count) : 0;
      console.log(`   ${exists.rows[0].exists ? '✅' : '❌'} ${tableName}: ${exists.rows[0].exists ? `${count} rows` : 'does not exist'}`);
    }
    
    client.release();
    await logsPool.end();
  } catch (error) {
    console.error('❌ Error connecting to logs:', (error as Error).message);
  }

  console.log('\n═══════════════════════════════════════');
  console.log('📝 Summary:');
  console.log('═══════════════════════════════════════');
  console.log('Check which database has the tables your application needs.');
  console.log('Update DB_NAME in .env file accordingly.');
}

compareDatabases();

