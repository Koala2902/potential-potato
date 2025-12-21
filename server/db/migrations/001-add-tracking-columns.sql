-- Migration: Add tracking columns to operation tables
-- Date: 2025-12-15
-- Description: Add columns to track operation completion status from scanner and print OS

-- ============================================================================
-- LOGS DATABASE
-- ============================================================================

-- Add tracking columns to job_operations table
ALTER TABLE job_operations 
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS completed_by VARCHAR, -- 'scanner' or 'print_os'
ADD COLUMN IF NOT EXISTS source_id BIGINT,     -- scan_id or print_os.id
ADD COLUMN IF NOT EXISTS status VARCHAR,        -- 'completed' or 'aborted'
ADD COLUMN IF NOT EXISTS notes TEXT;

-- Add tracking columns to imposition_operations table
ALTER TABLE imposition_operations 
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS completed_by VARCHAR, -- 'scanner' or 'print_os'
ADD COLUMN IF NOT EXISTS source_id BIGINT,     -- scan_id or print_os.id
ADD COLUMN IF NOT EXISTS status VARCHAR,        -- 'completed' or 'aborted'
ADD COLUMN IF NOT EXISTS notes TEXT;

-- Add indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_job_operations_completed 
ON job_operations(completed_at) 
WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_job_operations_source 
ON job_operations(completed_by, source_id) 
WHERE completed_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_imposition_operations_completed 
ON imposition_operations(completed_at) 
WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_imposition_operations_source 
ON imposition_operations(completed_by, source_id) 
WHERE completed_by IS NOT NULL;

-- ============================================================================
-- JOBMANAGER DATABASE
-- ============================================================================

-- Add operations JSONB field to jobs table (if not exists)
ALTER TABLE jobs 
ADD COLUMN IF NOT EXISTS operations JSONB DEFAULT '{}'::jsonb;

-- Create index on operations field for efficient querying
CREATE INDEX IF NOT EXISTS idx_jobs_operations_gin 
ON jobs USING gin(operations) 
WHERE operations IS NOT NULL;

-- Create processing_markers table to track last processed records
CREATE TABLE IF NOT EXISTS processing_markers (
    marker_id SERIAL PRIMARY KEY,
    marker_type VARCHAR NOT NULL UNIQUE,      -- 'print_os' or 'scanned_codes'
    last_processed_id BIGINT NOT NULL,        -- Last processed marker or scan_id
    last_processed_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create index on marker_type for fast lookups
CREATE INDEX IF NOT EXISTS idx_processing_markers_type 
ON processing_markers(marker_type);

-- Initialize markers if they don't exist
INSERT INTO processing_markers (marker_type, last_processed_id)
VALUES 
    ('print_os', 0),
    ('scanned_codes', 0)
ON CONFLICT (marker_type) DO NOTHING;

