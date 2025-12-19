import { Router } from 'express';
import { executeQuery } from '../config/database.js';

const router = Router();

// POST /api/scans - Create a new scan
router.post('/', async (req, res) => {
  try {
    const { codeText, machineId, operations } = req.body;

    if (!codeText) {
      res.status(400).json({
        success: false,
        error: 'codeText is required',
      });
      return;
    }

    // Insert scan record
    const query = `
      INSERT INTO scans (code_text, machine_id, operations, scanned_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING *
    `;

    const result = await executeQuery(query, [
      codeText,
      machineId || null,
      operations ? JSON.stringify(operations) : null,
    ]);

    res.json({
      success: true,
      data: {
        scan: result[0],
      },
      message: 'Scan recorded successfully',
    });
  } catch (error) {
    console.error('Error creating scan:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create scan',
    });
  }
});

export default router;

