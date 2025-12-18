import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getProductionQueue, getImpositionDetails, getFileId } from './db/queries.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

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

// Get file_id for an imposition_id
app.get('/api/imposition/:impositionId/file-id', async (req, res) => {
    try {
        const { impositionId } = req.params;
        const fileId = await getFileId(impositionId);
        res.json({ fileId });
    } catch (error) {
        console.error('Error fetching file_id:', error);
        res.status(500).json({ error: 'Failed to fetch file_id' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

