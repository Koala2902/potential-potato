import { Router } from 'express';
import { JobController } from '../controllers/jobController.js';

const router = Router();
const jobController = new JobController();

router.get('/', (req, res) => jobController.getAllJobs(req, res));
router.get('/kanban-data', (req, res) => jobController.getKanbanData(req, res));
router.put('/:jobId/status', (req, res) => jobController.updateJobStatus(req, res));

export default router;

