import { Pool, type PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Database connection pool configuration
export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'jobmanager',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  statement_timeout: 30000,
  query_timeout: 30000,
});

// Helper function to get a client from the pool
export const getDbClient = async (): Promise<PoolClient> => {
  try {
    return await pool.connect();
  } catch (error) {
    console.error('Error connecting to database:', error);
    throw new Error('Failed to connect to database');
  }
};

// Helper function to execute a query with automatic connection management
export const executeQuery = async <T = any>(
  query: string, 
  params: any[] = []
): Promise<T[]> => {
  const client = await getDbClient();
  try {
    const result = await client.query(query, params);
    return result.rows;
  } finally {
    client.release();
  }
};

// Helper function to execute a query and return a single row
export const executeQuerySingle = async <T = any>(
  query: string, 
  params: any[] = []
): Promise<T | null> => {
  const rows = await executeQuery<T>(query, params);
  return rows.length > 0 ? (rows[0] ?? null) : null;
};

// Graceful shutdown handler
export const closeDatabase = async (): Promise<void> => {
  try {
    await pool.end();
    console.log('Database pool closed');
  } catch (error) {
    console.error('Error closing database pool:', error);
  }
};

// Handle process termination
process.on('SIGINT', closeDatabase);
process.on('SIGTERM', closeDatabase);
process.on('exit', closeDatabase);

