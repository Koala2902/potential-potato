import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Separate connection pool for jobmanager database
export const jobmanagerPool = new Pool({
    host: process.env.DB_HOST || '10.1.1.76',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: 'jobmanager',
    user: process.env.DB_USER || 'user',
    password: process.env.DB_PASSWORD || 'password',
});

jobmanagerPool.on('error', (err) => {
    console.error('Unexpected error on idle jobmanager client', err);
});

export default jobmanagerPool;

