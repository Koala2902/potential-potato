import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getProductionQueue, getImpositionDetails, getFileIds, findRunlistByScan, getProductionQueueByRunlist } from './db/queries.js';
import { getMachines, getAvailableOperations, recordScannedCode } from './db/jobmanager-queries.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

console.log('Starting server...');
console.log(`Port: ${PORT}`);
console.log(`Database: ${process.env.DB_NAME || 'logs'}`);
console.log(`Host: ${process.env.DB_HOST || 'localhost'}`);

app.use(cors());
app.use(express.json());

// Get production queue grouped by runlist_id
app.get('/api/production-queue', async (req, res) => {
    try {
        const queue = await getProductionQueue();
        res.json(queue);
    } catch (error) {
        console.error('Error fetching production queue:', error);
        res.status(500).json({ error: 'Failed to fetch production queue' });
    }
});

// Get imposition details
app.get('/api/imposition/:impositionId', async (req, res) => {
    try {
        const { impositionId } = req.params;
        const details = await getImpositionDetails(impositionId);
        res.json(details);
    } catch (error) {
        console.error('Error fetching imposition details:', error);
        res.status(500).json({ error: 'Failed to fetch imposition details' });
    }
});

// Get all file_ids for an imposition_id
app.get('/api/imposition/:impositionId/file-ids', async (req, res) => {
    try {
        const { impositionId } = req.params;
        const fileIds = await getFileIds(impositionId);
        res.json({ fileIds });
    } catch (error) {
        console.error('Error fetching file_ids:', error);
        res.status(500).json({ error: 'Failed to fetch file_ids' });
    }
});

// Get machines from jobmanager database
app.get('/api/machines', async (req, res) => {
    try {
        const machines = await getMachines();
        res.json(machines);
    } catch (error) {
        console.error('Error fetching machines:', error);
        res.status(500).json({ error: 'Failed to fetch machines' });
    }
});

// Get available operations (filtered by machine_id)
app.get('/api/operations', async (req, res) => {
    try {
        const { machineId } = req.query;
        console.log('Fetching operations for machine_id:', machineId);
        const operations = await getAvailableOperations(machineId as string | undefined);
        console.log('Returning operations:', operations.length);
        res.json(operations);
    } catch (error) {
        console.error('Error fetching operations:', error);
        res.status(500).json({ error: 'Failed to fetch operations' });
    }
});

// Record a scanned code
app.post('/api/scanned-codes', async (req, res) => {
    try {
        const { codeText, machineId, userId, operations, metadata } = req.body;
        
        if (!codeText || typeof codeText !== 'string') {
            return res.status(400).json({ error: 'codeText is required' });
        }

        const scannedCode = await recordScannedCode(
            codeText,
            machineId || null,
            userId || null,
            operations || null,
            metadata || null
        );
        
        res.json(scannedCode);
    } catch (error) {
        console.error('Error recording scanned code:', error);
        res.status(500).json({ error: 'Failed to record scanned code' });
    }
});

// Find runlist by scan (format: job_id_version_tag, e.g., "4604_5889_1")
// Also records the scan to scanned_codes if machineId and operations are provided
app.post('/api/scan', async (req, res) => {
    try {
        const { scan, machineId, operations, userId } = req.body;
        
        if (!scan || typeof scan !== 'string') {
            return res.status(400).json({ error: 'Scan input is required' });
        }

        // Record scan to scanned_codes if machineId and operations are provided
        if (machineId && operations && Array.isArray(operations) && operations.length > 0) {
            try {
                await recordScannedCode(
                    scan,
                    machineId,
                    userId || null,
                    { operations },
                    { timestamp: new Date().toISOString() }
                );
            } catch (recordError) {
                console.error('Error recording scan (continuing anyway):', recordError);
                // Continue even if recording fails
            }
        }

        const runlistId = await findRunlistByScan(scan);
        if (!runlistId) {
            return res.status(404).json({ error: 'No runlist found for this scan' });
        }

        // Get production queue filtered by this runlist
        const queue = await getProductionQueueByRunlist(runlistId);
        res.json({ runlistId, queue });
    } catch (error) {
        console.error('Error processing scan:', error);
        res.status(500).json({ error: 'Failed to process scan' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

