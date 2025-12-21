# Database Changes Summary

## Date: 2025-12-15

## Overview
Added tracking columns to existing operation tables and created a new processing markers table to support automatic job status updates from scanner and print OS data sources.

---

## Changes Made

### LOGS Database

#### 1. `job_operations` Table
**Added Columns:**
- `completed_at` (TIMESTAMP) - When operation was completed
- `completed_by` (VARCHAR) - Source: 'scanner' or 'print_os'
- `source_id` (BIGINT) - Reference to scan_id or print_os.id
- `status` (VARCHAR) - 'completed' or 'aborted'
- `notes` (TEXT) - Optional notes

**Added Indexes:**
- `idx_job_operations_completed` - Index on `completed_at` (partial index, WHERE completed_at IS NOT NULL)
- `idx_job_operations_source` - Index on `completed_by, source_id` (partial index, WHERE completed_by IS NOT NULL)

#### 2. `imposition_operations` Table
**Added Columns:**
- `completed_at` (TIMESTAMP) - When operation was completed
- `completed_by` (VARCHAR) - Source: 'scanner' or 'print_os'
- `source_id` (BIGINT) - Reference to scan_id or print_os.id
- `status` (VARCHAR) - 'completed' or 'aborted'
- `notes` (TEXT) - Optional notes

**Added Indexes:**
- `idx_imposition_operations_completed` - Index on `completed_at` (partial index, WHERE completed_at IS NOT NULL)
- `idx_imposition_operations_source` - Index on `completed_by, source_id` (partial index, WHERE completed_by IS NOT NULL)

---

### JOBMANAGER Database

#### 3. `jobs` Table
**Added Columns:**
- `operations` (JSONB) - Stores operation completion status as JSON
  - Default: `'{}'::jsonb`
  - Structure: `{ "print": true/false, "coating": true/false, "kiss_cut": true/false, "backscore": true/false, "slitter": true/false }`

**Added Indexes:**
- `idx_jobs_operations_gin` - GIN index on `operations` field (partial index, WHERE operations IS NOT NULL)

#### 4. `processing_markers` Table (NEW)
**Created Table:**
```sql
CREATE TABLE processing_markers (
    marker_id SERIAL PRIMARY KEY,
    marker_type VARCHAR NOT NULL UNIQUE,      -- 'print_os' or 'scanned_codes'
    last_processed_id BIGINT NOT NULL,        -- Last processed marker or scan_id
    last_processed_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

**Added Indexes:**
- `idx_processing_markers_type` - Index on `marker_type`

**Initialized Data:**
- `marker_type = 'print_os'`, `last_processed_id = 0`
- `marker_type = 'scanned_codes'`, `last_processed_id = 0`

---

## Migration Files

### Migration Script
- **Location**: `server/db/migrations/001-add-tracking-columns.sql`
- **Description**: SQL migration script with all changes

### Migration Runner
- **Location**: `server/db/run-migration.ts`
- **Usage**: `npx tsx server/db/run-migration.ts`
- **Description**: Executes the migration script

### Schema Verification
- **Location**: `server/db/verify-schema.ts`
- **Usage**: `npx tsx server/db/verify-schema.ts`
- **Description**: Verifies all required columns, tables, and indexes exist

---

## Verification Results

✅ **All checks passed** - Schema is up to date!

**Verified:**
- ✅ All columns added successfully
- ✅ All indexes created successfully
- ✅ `processing_markers` table created and initialized
- ✅ Markers initialized with default values

---

## Usage

### Run Migration
```bash
npx tsx server/db/run-migration.ts
```

### Verify Schema
```bash
npx tsx server/db/verify-schema.ts
```

### Check Status
The verification script will show:
- ✅ Green checkmarks for existing columns/tables/indexes
- ❌ Red X marks for missing items
- List of all issues if verification fails

---

## Notes

1. **Idempotent**: All migrations use `IF NOT EXISTS` clauses, so they can be run multiple times safely
2. **Partial Indexes**: Indexes on completion tracking use partial indexes (WHERE IS NOT NULL) for better performance
3. **Backward Compatible**: Existing data is not affected - new columns are nullable
4. **Default Values**: 
   - `operations` field defaults to empty JSON object `{}`
   - Markers initialize to `0` (start from beginning)

---

## Next Steps

After migration:
1. ✅ Verify schema with verification script
2. Implement processing functions to update these tables
3. Set up background processing jobs
4. Test with sample data

