import { Request, Response } from 'express';
import { executeQuery } from '../config/database.js';

export class JobController {
  /**
   * GET /api/jobs - Get all jobs
   */
  async getAllJobs(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const company = req.query.company as string;
      const filter = req.query.filter as string;
      const excludeDispatched = req.query.excludeDispatched === '1' || req.query.excludeDispatched === 'true';

      const queryParams: any[] = [limit];
      let whereClause = 'j.job_id IS NOT NULL';

      if (company === 'labex') {
        queryParams.push(`%labex%`);
        whereClause += ` AND CAST(j.job_id AS TEXT) ILIKE $${queryParams.length}`;
      } else if (company === 'next-labels') {
        queryParams.push(`%labex%`);
        whereClause += ` AND CAST(j.job_id AS TEXT) NOT ILIKE $${queryParams.length}`;
      }

      if (filter) {
        queryParams.push(`%${filter}%`);
        whereClause += ` AND (CAST(j.job_id AS TEXT) ILIKE $${queryParams.length} OR COALESCE(j.job_number::text, '') ILIKE $${queryParams.length})`;
      }

      if (excludeDispatched) {
        whereClause += ` AND NOT (COALESCE(j.order_status, '') ILIKE 'dispatched' OR COALESCE(j.processed, false) = TRUE)`;
      }

      const query = `
        SELECT DISTINCT
          j.job_id,
          j.job_number,
          j.customer_name,
          j.order_date,
          j.due_date,
          j.order_status,
          j.processed
        FROM jobs j
        WHERE ${whereClause}
        ORDER BY j.due_date ASC NULLS LAST, j.order_date DESC
        LIMIT $1
      `;

      const jobs = await executeQuery(query, queryParams);
      res.json(jobs);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch jobs',
      });
    }
  }

  /**
   * GET /api/kanban-data - Get kanban board data
   */
  async getKanbanData(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const company = req.query.company as string;
      const filter = req.query.filter as string;
      const excludeDispatched = req.query.excludeDispatched === '1' || req.query.excludeDispatched === 'true';

      // Simplified kanban query - adapt based on your schema
      const queryParams: any[] = [limit];
      let whereClause = '1=1';

      if (company === 'labex') {
        queryParams.push(`%labex%`);
        whereClause += ` AND CAST(job_id AS TEXT) ILIKE $${queryParams.length}`;
      } else if (company === 'next-labels') {
        queryParams.push(`%labex%`);
        whereClause += ` AND CAST(job_id AS TEXT) NOT ILIKE $${queryParams.length}`;
      }

      if (filter) {
        queryParams.push(`%${filter}%`);
        whereClause += ` AND (CAST(job_id AS TEXT) ILIKE $${queryParams.length} OR COALESCE(job_number::text, '') ILIKE $${queryParams.length})`;
      }

      if (excludeDispatched) {
        whereClause += ` AND NOT (COALESCE(order_status, '') ILIKE 'dispatched' OR COALESCE(processed, false) = TRUE)`;
      }

      const query = `
        SELECT 
          job_id as id,
          customer_name,
          job_number as project_name,
          due_date,
          order_status as status,
          processed
        FROM jobs
        WHERE ${whereClause}
        ORDER BY due_date ASC NULLS LAST
        LIMIT $1
      `;

      const items = await executeQuery(query, queryParams);

      // Group into kanban columns
      const kanbanData = {
        columns: [
          {
            id: 'pending',
            title: 'Pending',
            items: items.filter((item: any) => !item.processed && (!item.status || item.status === 'pending')),
          },
          {
            id: 'in-progress',
            title: 'In Progress',
            items: items.filter((item: any) => item.processed && item.status !== 'completed'),
          },
          {
            id: 'completed',
            title: 'Completed',
            items: items.filter((item: any) => item.status === 'completed' || item.processed),
          },
        ],
      };

      res.json({
        success: true,
        data: kanbanData,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch kanban data',
      });
    }
  }

  /**
   * PUT /api/jobs/:jobId/status - Update job status
   */
  async updateJobStatus(req: Request, res: Response): Promise<void> {
    try {
      const { jobId } = req.params;
      const { processed, orderstatus } = req.body;

      if (!jobId || typeof processed !== 'boolean') {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }

      const query = `
        UPDATE jobs
        SET processed = $1, order_status = COALESCE($2, order_status)
        WHERE job_id = $3
        RETURNING *
      `;

      const result = await executeQuery(query, [processed, orderstatus, jobId]);

      if (result.length === 0) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      res.json({
        success: true,
        data: result[0],
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update job status',
      });
    }
  }
}

