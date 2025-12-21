# Job Status Update System - Implementation Plan

## Overview
This system will automatically update job statuses based on two data sources:
1. **Scanner Data** (`scanned_codes` table) - Manual scans from overhead scanners on machinery
2. **Print OS Data** (`print_os` table) - Automated API updates from the press/printer

---

## 1. Database Schema Requirements

### 1.1 Print OS Table (jobmanager database)
**Table: `"print OS"`** - ✅ **ALREADY EXISTS** (note: table name has a space, must be quoted)

**Actual Structure**:
- `id` (bigint SERIAL PRIMARY KEY) - Sequential ID
- `name` (text) - **This is the imposition_id** ✅
- `status` (text) - **'PRINTED' or 'ABORTED'** ✅
- `marker` (bigint) - **Sequential number from printer app - use this for tracking** ✅
- `job_name` (text) - Job name
- `item_id` (text) - Item identifier
- `job_complete_time` (timestamp) - When printing completed/aborted
- `copies` (integer) - Number of copies printed
- `payload` (JSONB) - Detailed printer data
- `created_at`, `updated_at` - Timestamps

**Key Points**:
- ✅ `name` field = `imposition_id` (confirmed)
- ✅ `marker` field = Sequential number from printer app (use for tracking)
- ✅ `status` = 'PRINTED' or 'ABORTED' (confirmed)
- ✅ Table has 6,337+ rows of data

**Action**: Use `marker` field to track which records we've processed. Store last processed marker in `processing_markers` table.

### 1.2 Scanned Codes Table (jobmanager database)
**Table: `scanned_codes`** - ✅ **ALREADY EXISTS**
- `scan_id` (SERIAL PRIMARY KEY) - Sequential ID, use as marker ✅
- `code_text` - Scanned barcode (format: job_id_version_tag) ✅
- `scanned_at` - Timestamp ✅
- `machine_id` - Which machine scanned it ✅
- `user_id` - Optional user ✅
- `operations` (JSONB) - Operations performed ✅
- `metadata` (JSONB) - Additional data ✅

**Action**: Verify structure matches, ensure `scan_id` is SERIAL (sequential).

### 1.3 Status Tracking Tables (logs database) - ✅ **ALREADY EXIST**

**Table: `job_operations`** - ✅ **EXISTS**
- `job_operation_id` (text PRIMARY KEY)
- `job_id` (text) - Job identifier ✅
- `version_tag` (text) - Version tag ✅
- `operation_id` (text) - Operation identifier (e.g., 'op001', 'op003', 'op006') ✅
- `sequence_order` (integer) - Order of operation
- `required` (boolean) - Whether operation is required

**Table: `imposition_operations`** - ✅ **EXISTS**
- `imposition_operation_id` (text PRIMARY KEY)
- `imposition_id` (text) - Imposition identifier ✅
- `operation_id` (text) - Operation identifier ✅
- `sequence_order` (integer) - Order of operation
- `required` (boolean) - Whether operation is required

**Action Required**: Add tracking columns to these tables:
```sql
-- Add to job_operations table
ALTER TABLE job_operations ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE job_operations ADD COLUMN IF NOT EXISTS completed_by VARCHAR; -- 'scanner' or 'print_os'
ALTER TABLE job_operations ADD COLUMN IF NOT EXISTS source_id BIGINT; -- scan_id or print_os.id
ALTER TABLE job_operations ADD COLUMN IF NOT EXISTS status VARCHAR; -- 'completed', 'aborted'
ALTER TABLE job_operations ADD COLUMN IF NOT EXISTS notes TEXT;

-- Add to imposition_operations table  
ALTER TABLE imposition_operations ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE imposition_operations ADD COLUMN IF NOT EXISTS completed_by VARCHAR; -- 'scanner' or 'print_os'
ALTER TABLE imposition_operations ADD COLUMN IF NOT EXISTS source_id BIGINT; -- scan_id or print_os.id
ALTER TABLE imposition_operations ADD COLUMN IF NOT EXISTS status VARCHAR; -- 'completed', 'aborted'
ALTER TABLE imposition_operations ADD COLUMN IF NOT EXISTS notes TEXT;

-- Add indexes for tracking
CREATE INDEX IF NOT EXISTS idx_job_operations_completed ON job_operations(completed_at);
CREATE INDEX IF NOT EXISTS idx_job_operations_source ON job_operations(completed_by, source_id);
CREATE INDEX IF NOT EXISTS idx_imposition_operations_completed ON imposition_operations(completed_at);
CREATE INDEX IF NOT EXISTS idx_imposition_operations_source ON imposition_operations(completed_by, source_id);
```

**Note**: These tables track operations at both job level and imposition level, which is perfect for our use case!

### 1.4 Processing Markers Table (NEW - NEEDS TO BE CREATED)
**Table: `processing_markers`** (jobmanager database)
```sql
CREATE TABLE processing_markers (
    marker_id SERIAL PRIMARY KEY,
    marker_type VARCHAR NOT NULL UNIQUE,      -- 'print_os' or 'scanned_codes'
    last_processed_id INTEGER NOT NULL,       -- Last processed scan_id or print_os_id
    last_processed_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

**Action**: ✅ **CREATE THIS TABLE** - Needed for tracking processing progress.

---

## 2. Data Flow & Processing Logic

### 2.1 Print OS Processing Flow

```
"print OS" Table (new records)
    ↓
1. Get last processed marker from processing_markers table
   - marker_type = 'print_os'
   - last_processed_id = last marker value processed
    ↓
2. Query: SELECT * FROM "print OS" 
          WHERE marker > last_processed_id 
          ORDER BY marker ASC
    ↓
3. For each record:
   a. Get imposition_id from "print OS".name field ✅
   b. Query imposition_file_mapping (logs DB) to get all file_ids for this imposition_id
   c. Parse file_id to extract job_id (pattern: FILE_version_Labex_job_id_*)
   d. Group by job_id to determine:
      - Total files per job
      - Files printed per job (status = 'PRINTED')
      - Files aborted per job (status = 'ABORTED')
    ↓
4. Update job status:
   - If all files printed → mark job.operations.print = true
   - If some files printed → keep job.operations.print = false, add note
   - If all aborted → mark job.operations.print = false, add abort note
    ↓
5. Update imposition_operations table:
   - Find imposition_operation record for this imposition_id and operation_id='print'
   - Update: completed_at = NOW(), completed_by = 'print_os', source_id = print_os.id, status = 'completed' (if PRINTED) or 'aborted' (if ABORTED)
   - Then update corresponding job_operations records:
     * For each job_id found from file_ids
     * Find job_operation record for job_id, version_tag, and operation_id='print'
     * Update: completed_at = NOW(), completed_by = 'print_os', source_id = print_os.id, status = 'completed' or 'aborted'
    ↓
6. Update processing_markers.last_processed_id = MAX(marker) from processed records
```

### 2.2 Scanner Processing Flow

```
Scanned Codes Table (new records)
    ↓
1. Query: SELECT * FROM scanned_codes 
          WHERE scan_id > last_processed_scan_id
          ORDER BY scan_id ASC
    ↓
2. For each scan:
   a. Parse code_text to determine scan type:
      - Try to match runlist_id pattern first (check if exists in production_planner_paths)
      - If not found, try job_id_version_tag format
    ↓
3. Determine jobs to update:
   
   **Case A: Runlist Scan (runlist_id)** ⚠️ PRIMARY CASE
   - Get runlist_id from code_text (direct scan of runlist barcode)
   - Query production_planner_paths (logs DB) to get ALL impositions in runlist:
     ```sql
     SELECT DISTINCT imposition_id FROM production_planner_paths
     WHERE runlist_id = $1
     ```
   - For EACH imposition_id in the runlist:
     * Query imposition_file_mapping to get all file_ids for that imposition
     * Parse each file_id to extract job_id (pattern: FILE_version_Labex_job_id_*)
   - Collect ALL unique job_ids from ALL impositions in the runlist
   - Update ALL jobs in the runlist with operations from scan
   
   **Case B: Individual Job Scan (job_id_version_tag)**
   - Extract job_id from code_text (format: "job_id_version_tag")
   - Find runlist_id using existing findRunlistByScan() function
   - If runlist found, treat as runlist scan (update all jobs in runlist)
   - If no runlist found, update single job only
    ↓
4. Get operations from scanned_codes.operations JSONB field
   - Extract which operation(s) were completed
    ↓
5. Update operation status for all affected jobs:
   - For each job_id found (could be many if runlist scan):
     * For each operation in operations JSONB field:
       - Map operation name to operation_id (e.g., 'coating' → 'op003', 'kiss_cut' → 'op006')
       - Find job_operation record for job_id, version_tag, and operation_id
       - Update: completed_at = NOW(), completed_by = 'scanner', source_id = scan_id, status = 'completed'
       - If from runlist scan, also update imposition_operations:
         * For each imposition this job belongs to
         * Find imposition_operation record for imposition_id and operation_id
         * Update: completed_at = NOW(), completed_by = 'scanner', source_id = scan_id, status = 'completed'
       - Update job.operations[operation_name] = true (in jobmanager.jobs table)
    ↓
6. Update processing_markers.last_processed_id = MAX(scan_id)
```

---

## 3. File ID to Job ID Mapping Logic

### 3.1 File ID Pattern
- Format: `FILE_<version>_Labex_<job_id>_<additional_info>`
- Example: `FILE_1_Labex_4604_5889_80`
- Parse: version=1, job_id=4604_5889

### 3.2 Mapping Steps

**For Print OS**:
1. **Print OS → Imposition ID**: Get `imposition_id` from `"print OS".name` field
2. **Imposition ID → File IDs**: Query `imposition_file_mapping` table (logs DB)
   ```sql
   SELECT file_id FROM imposition_file_mapping 
   WHERE imposition_id = $1
   ```
3. **File ID → Job ID**: Parse `file_id` to extract `job_id`
   - Pattern: `FILE_<version>_Labex_<job_id>_*`
   - Extract job_id part

**For Scanner (Runlist Scan)**:
1. **Scanner → Runlist ID**: Parse `code_text` to get `runlist_id`
2. **Runlist ID → Imposition IDs**: Query `production_planner_paths` table (logs DB)
   ```sql
   SELECT DISTINCT imposition_id FROM production_planner_paths
   WHERE runlist_id = $1
   ```
3. **Imposition ID → File IDs**: Query `imposition_file_mapping` for each imposition
4. **File ID → Job IDs**: Parse all file_ids to extract all job_ids
5. **Result**: All unique job_ids from all impositions in the runlist

### 3.3 Job Completion Logic
For each job:
- **Total files**: Count distinct file_ids for that job_id across all impositions
- **Printed files**: Count file_ids that have been printed (status='printed')
- **Aborted files**: Count file_ids that were aborted (status='aborted')

**Status determination**:
- All files printed → `job.print = true`
- Some files printed → `job.print = 'partial'` (or keep false, add note)
- All aborted → `job.print = false`, add abort note

---

## 4. Marker System Implementation

### 4.1 Print OS Marker
- **Field**: `marker` (bigint) - Sequential number from printer app ✅
- **Storage**: `processing_markers` table (NEW - we create this)
  - `marker_type = 'print_os'`
  - `last_processed_id = MAX(marker)` from processed records
- **Query**: Only process records where `marker > last_processed_id`
- **Note**: We use the `marker` field from "print OS" table, NOT the `id` field

### 4.2 Scanner Marker
- **Field**: `scan_id` (sequential SERIAL)
- **Storage**: `processing_markers` table
  - `marker_type = 'scanned_codes'`
  - `last_processed_id = MAX(scan_id)` from processed records
- **Query**: Only process records where `scan_id > last_processed_id`

### 4.3 Marker Initialization
```sql
-- Initialize markers if they don't exist
INSERT INTO processing_markers (marker_type, last_processed_id)
VALUES 
    ('print_os', 0),
    ('scanned_codes', 0)
ON CONFLICT (marker_type) DO NOTHING;
```

---

## 5. Status Update Logic

### 5.1 Job Operations Field
**Current Status**: Jobs table does NOT have an `operations` field ❌

**Action Required**: Add `operations` JSONB field to jobs table:
```sql
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS operations JSONB DEFAULT '{}'::jsonb;
```

**Structure**:
```json
{
  "print": true/false,
  "coating": true/false,
  "kiss_cut": true/false,
  "backscore": true/false,
  "slitter": true/false
}
```

### 5.2 Update Rules

**From Print OS**:
- When imposition printed → Set `job.operations.print = true`
- When imposition aborted → Set `job.operations.print = false` (or keep current)
- Record in `job_status_updates` with source_type='print_os'

**From Scanner**:
- Parse `operations` JSONB from scanned_codes
- For each operation marked → Set `job.operations[operation] = true`
- Record in `job_status_updates` with source_type='scanner'

### 5.3 Conflict Resolution
- **Print OS** takes precedence for print status
- **Scanner** takes precedence for manual operations (coating, kiss_cut, etc.)
- If both update same operation → Most recent timestamp wins

---

## 6. Implementation Steps

### Phase 1: Database Setup
1. ✅ **Verified** `"print OS"` table structure (already exists)
   - Confirmed: `name` = imposition_id ✅
   - Confirmed: `marker` = sequential number from printer app ✅
   - Confirmed: `status` = 'PRINTED' or 'ABORTED' ✅
2. ✅ **Verified** `job_operations` and `imposition_operations` tables exist (logs DB)
3. ✅ **Add tracking columns** to existing operation tables:
   - Add `completed_at`, `completed_by`, `source_id`, `status`, `notes` to both tables
4. ✅ **Create** `processing_markers` table (NEW - jobmanager DB)
   - Will store last processed `marker` value for print_os
   - Will store last processed `scan_id` value for scanned_codes
5. ✅ **Verified** `scanned_codes.scan_id` is sequential (bigint SERIAL) ✅
6. ✅ **Add** `operations` JSONB field to `jobs` table (jobmanager DB) if missing
7. ✅ **Initialize** markers in `processing_markers` table
   - Insert initial records: ('print_os', 0) and ('scanned_codes', 0)

### Phase 2: Core Functions
1. ✅ Create function: `getJobsFromImposition(imposition_id)`
   - Query imposition_file_mapping
   - Parse file_ids to extract job_ids
   - Return list of unique job_ids

2. ✅ Create function: `processPrintOSRecords()`
   - Get last processed marker from processing_markers table
   - Query "print OS" WHERE marker > last_processed_marker ORDER BY marker ASC
   - For each record:
     * Get imposition_id from `name` field
     * Query imposition_file_mapping (logs DB) to get file_ids
     * Parse file_ids to extract job_ids
     * Group by job_id, determine completion status
   - Update job.operations.print (add operations field if missing)
   - Record in job_status_updates
   - Update processing_markers.last_processed_id = MAX(marker)

3. ✅ Create function: `processScannedCodes()`
   - Get new scanned_codes (scan_id > marker)
   - Parse code_text to get job_id
   - Extract operations from operations JSONB
   - Update job.operations[operation]
   - Record in job_status_updates
   - Update marker

### Phase 3: API Endpoints
1. ✅ `POST /api/print-os` - Receive print OS updates from printer
2. ✅ `POST /api/process-status-updates` - Manual trigger for processing
3. ✅ `GET /api/job-status/:jobId` - Get status update history

### Phase 4: Background Processing
1. ✅ Create scheduled job (cron/interval) to run:
   - `processPrintOSRecords()` every 1-5 minutes
   - `processScannedCodes()` every 1-5 minutes

### Phase 5: Testing & Validation
1. ✅ Test Print OS processing with sample data
2. ✅ Test Scanner processing with sample scans
3. ✅ Test marker system (ensure no duplicates)
4. ✅ Test job status updates
5. ✅ Test conflict resolution

---

## 7. API Endpoints Specification

### 7.1 Receive Print OS Update
**Note**: The printer already sends data directly to the "print OS" table via API. 
We don't need to create this endpoint - the data is already being recorded.

**However**, we may want to add an endpoint to manually trigger processing:
```
POST /api/process-print-os
Body: {
    "force": false  // Optional: process all records regardless of marker
}
Response: {
    "processed_count": 5,
    "jobs_updated": 3,
    "last_marker": 12345
}
```

### 7.2 Process Status Updates (Manual Trigger)
```
POST /api/process-status-updates
Body: {
    "source": "both" | "print_os" | "scanner"
}
Response: {
    "print_os_processed": 5,
    "scanner_processed": 10,
    "jobs_updated": 8
}
```

### 7.3 Get Job Status History
```
GET /api/job-status/:jobId
Response: {
    "job_id": "4604_5889",
    "current_status": {
        "print": true,
        "coating": false,
        ...
    },
    "update_history": [
        {
            "update_id": 1,
            "operation_type": "print",
            "status": "completed",
            "source_type": "print_os",
            "updated_at": "2025-12-15T10:30:00Z"
        },
        ...
    ]
}
```

---

## 8. Edge Cases & Considerations

### 8.1 Multiple Files Per Job
- A job can have multiple file_ids across different impositions
- Need to track completion per file_id
- Job is "fully printed" only when ALL file_ids are printed

### 8.2 Partial Printing
- Some files printed, some not → How to handle?
- **Option A**: Keep `print = false`, add note about partial completion
- **Option B**: Add `print_status = 'partial'` field
- **Recommendation**: Option A + track in `job_status_updates` notes

### 8.3 Aborted Prints
- If all files aborted → `print = false`
- If some aborted → Keep current status, add abort note
- Record abort reason in `job_status_updates.notes`

### 8.4 Duplicate Processing Prevention
- Use markers to ensure each record processed only once
- Use transactions to ensure atomic updates
- Add unique constraint on (source_type, source_id) in job_status_updates

### 8.5 Missing Data
- If imposition_id not found in imposition_file_mapping → Log error, skip
- If file_id doesn't match pattern → Log warning, skip
- If job_id not found in jobs table → Log error, skip

---

## 9. Questions to Finalize

1. **Job Status Field Structure**:
   - Should we use JSONB `operations` field or separate boolean columns?
   - **Recommendation**: JSONB for flexibility

2. **Partial Print Status**:
   - How should we represent "partially printed"?
   - **Recommendation**: Keep `print = false`, add detailed notes

3. **Processing Frequency**:
   - How often should we process updates?
   - **Recommendation**: Every 1-2 minutes for real-time updates

4. **Error Handling**:
   - Should failed processing stop the batch or continue?
   - **Recommendation**: Continue, log errors, retry failed records

5. **Historical Data**:
   - How long to keep job_status_updates records?
   - **Recommendation**: Keep indefinitely for audit trail

6. **Print OS Table Location**: ✅ **CONFIRMED**
   - Table `"print OS"` is in `jobmanager` database ✅
   - Table name has a space, must be quoted in queries ✅

---

## 10. Next Steps

1. **Review this plan** - Confirm approach and answer questions above
2. **Create database migrations** - Set up tables
3. **Implement core functions** - Processing logic
4. **Create API endpoints** - For receiving and querying data
5. **Set up background processing** - Scheduled jobs
6. **Test end-to-end** - With sample data
7. **Deploy and monitor** - Production rollout

---

## Notes
- This plan assumes `scan_id` is sequential (SERIAL)
- Print OS table needs to be created
- Processing should be idempotent (safe to run multiple times)
- All database operations should use transactions

