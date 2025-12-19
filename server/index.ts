import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getProductionQueue, getImpositionDetails, getFileIds, findRunlistByScan, getProductionQueueByRunlist } from './db/queries.js';

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

// Find runlist by scan (format: job_id_version_tag, e.g., "4604_5889_1")
app.post('/api/scan', async (req, res) => {
    try {
        const { scan } = req.body;
        if (!scan || typeof scan !== 'string') {
            return res.status(400).json({ error: 'Scan input is required' });
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

