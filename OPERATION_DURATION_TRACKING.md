# Operation Duration Tracking

## Overview
This system tracks operation time by grouping scans into **batches** and calculating duration between the START batch and END batch. The logic works like a debounce function:

- **First batch** (scans within 20-30 seconds) = **START** of operation
- **Gap** (no scans for a period)
- **Second batch** (2-10 scans within 20-30 seconds) = **END** of operation
- **Duration** = Time between START batch and END batch

This is per job - each job has its own scan batches.

## Approach: Hybrid Solution

We've implemented a **hybrid approach** that combines:
1. **PostgreSQL View/Function** - For real-time calculation from `scanned_codes`
2. **Stored Values** - For performance and historical tracking in `job_operations` table

### Why This Approach?

**PostgreSQL View/Function Benefits:**
- ✅ Always accurate - calculates from source data (`scanned_codes`)
- ✅ No data duplication
- ✅ Works even if processing script hasn't run yet
- ✅ Can recalculate for historical data

**Stored Values Benefits:**
- ✅ Fast queries - no need to scan `scanned_codes` table every time
- ✅ Historical tracking - preserves operation times even if scans are deleted
- ✅ Better performance for reporting and analytics

## Database Schema

### New Columns in `job_operations` Table

```sql
operation_duration_seconds INTEGER      -- Duration in seconds
operation_started_at TIMESTAMP          -- Earliest scan time
operation_completed_at TIMESTAMP        -- Latest scan time
```

### Indexes

```sql
idx_job_operations_duration              -- Index on duration
idx_job_operations_time_range            -- Index on time range
```

## PostgreSQL Functions

### 1. `calculate_operation_duration(job_id, version_tag, operation_id, batch_window_seconds)`

Groups scans into batches and calculates operation duration between START and END batches.

**Parameters:**
- `job_id_param` - Job identifier
- `version_tag_param` - Version tag
- `operation_id_param` - Operation ID (e.g., 'op001')
- `batch_window_seconds` - Window size for grouping scans (default: 30 seconds)

**Returns:**
- `duration_seconds` - Time difference between START batch and END batch
- `started_at` - Start timestamp of first batch
- `completed_at` - Start timestamp of second batch (END)
- `scan_count` - Total number of scans found
- `start_batch_size` - Number of scans in START batch
- `end_batch_size` - Number of scans in END batch

**How it works:**
1. Finds all scans in `scanned_codes` matching the job/version/operation, ordered by time
2. Groups scans into batches: scans within `batch_window_seconds` (default 30s) are in the same batch
3. Identifies first batch as START, second batch (after gap) as END
4. Calculates duration: `EXTRACT(EPOCH FROM (end_batch_start - start_batch_start))`
5. If only one batch exists, duration is NULL (job not finished yet)

**Example:**
```sql
SELECT * FROM calculate_operation_duration('4677_5995', '1', 'op001');
-- Returns: 
--   duration_seconds=1200 (20 minutes between batches)
--   started_at='2025-01-15 10:00:00' (start of first batch)
--   completed_at='2025-01-15 10:20:00' (start of second batch)
--   scan_count=12
--   start_batch_size=5 (scans in first batch)
--   end_batch_size=7 (scans in second batch)
```

### 2. `update_operation_duration(job_id, version_tag, operation_id)`

Updates `job_operations` table with calculated duration.

**How it works:**
1. Calls `calculate_operation_duration()` to get values
2. Updates `job_operations` record with:
   - `operation_duration_seconds`
   - `operation_started_at`
   - `operation_completed_at`

**Usage:**
```sql
SELECT update_operation_duration('4677_5995', '1', 'op001');
```

### 3. View: `job_operations_with_duration`

A view that shows operation durations, using stored values if available, otherwise calculating on-the-fly.

**Query Example:**
```sql
SELECT 
    job_id,
    version_tag,
    operation_id,
    operation_duration_seconds,
    calculated_duration_seconds,  -- Falls back to calculation if NULL
    operation_started_at,
    operation_completed_at
FROM job_operations_with_duration
WHERE job_id = '4677_5995';
```

## Processing Script Integration

The `processScannedCodes()` function in `server/db/status-updates.ts` automatically calculates and stores operation duration when processing scans.

**How it works:**
1. When a scan is processed and `updateJobOperation()` is called
2. If the operation is completed via scanner (not print_os)
3. Automatically calls `update_operation_duration()` to calculate and store the duration

**Code Location:**
```typescript
// In updateJobOperation() function
if (completedBy === 'scanner' && status === 'completed') {
    await client.query(
        `SELECT update_operation_duration($1, $2, $3)`,
        [jobId, versionTag, operationId]
    );
}
```

## Usage Examples

### Query Operation Duration for a Job

```sql
-- Get stored duration (fast)
SELECT 
    job_id,
    version_tag,
    operation_id,
    operation_duration_seconds,
    operation_started_at,
    operation_completed_at
FROM job_operations
WHERE job_id = '4677_5995'
AND completed_at IS NOT NULL;

-- Get duration with fallback calculation (always accurate)
SELECT * FROM job_operations_with_duration
WHERE job_id = '4677_5995';

-- Calculate duration on-the-fly (for historical data)
SELECT * FROM calculate_operation_duration('4677_5995', '1', 'op001');
```

### Update Duration for Existing Operations

```sql
-- Update duration for a specific operation
SELECT update_operation_duration('4677_5995', '1', 'op001');

-- Update durations for all completed operations (batch update)
DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN 
        SELECT DISTINCT job_id, version_tag, operation_id
        FROM job_operations
        WHERE completed_at IS NOT NULL
        AND operation_duration_seconds IS NULL
    LOOP
        PERFORM update_operation_duration(rec.job_id, rec.version_tag, rec.operation_id);
    END LOOP;
END $$;
```

### Reporting: Average Operation Time by Operation Type

```sql
SELECT 
    operation_id,
    COUNT(*) as operation_count,
    AVG(operation_duration_seconds) as avg_duration_seconds,
    MIN(operation_duration_seconds) as min_duration_seconds,
    MAX(operation_duration_seconds) as max_duration_seconds,
    AVG(operation_duration_seconds) / 60.0 as avg_duration_minutes
FROM job_operations
WHERE operation_duration_seconds IS NOT NULL
GROUP BY operation_id
ORDER BY operation_id;
```

## Migration

Run the migration to add the new columns and functions:

```bash
# The migration file is: server/db/migrations/015-add-operation-duration-tracking.sql
```

The migration:
1. ✅ Adds `operation_duration_seconds`, `operation_started_at`, `operation_completed_at` columns
2. ✅ Creates indexes for efficient querying
3. ✅ Creates `calculate_operation_duration()` function
4. ✅ Creates `update_operation_duration()` function
5. ✅ Creates `job_operations_with_duration` view

## How Scans Are Processed

When a job is scanned multiple times in batches:

1. **Each scan** is recorded in `scanned_codes` table with:
   - `code_text` - The scanned barcode (job_id_version_tag or file_id)
   - `scanned_at` - Timestamp of the scan
   - `operations` - JSONB array of operation IDs (e.g., `["op001"]`)

2. **Processing script** (`processScannedCodes()`) runs periodically:
   - Finds all scans for a job/operation
   - Updates `job_operations.completed_at` with the latest scan time
   - Calls `update_operation_duration()` to calculate duration

3. **Batch grouping logic**:
   - Scans are ordered by `scanned_at` timestamp
   - Scans within 30 seconds of each other are grouped into the same batch
   - When a gap > 30 seconds occurs, a new batch starts
   - **First batch** = START of operation
   - **Second batch** (after gap) = END of operation

4. **Duration calculation**:
   - Finds ALL scans for the job/version/operation
   - Groups scans into batches based on time gaps
   - Gets START batch start time as `operation_started_at`
   - Gets END batch start time as `operation_completed_at`
   - Calculates: `duration = END_batch_start - START_batch_start` (in seconds)
   - If only START batch exists, duration is NULL (operation in progress)

## Example Scenario

**Job:** `4677_5995`, Version: `1`, Operation: `op001`

**START Batch (scans within 30 seconds):**
1. `2025-01-15 10:00:00` - Scan 1
2. `2025-01-15 10:00:05` - Scan 2
3. `2025-01-15 10:00:10` - Scan 3
4. `2025-01-15 10:00:15` - Scan 4
5. `2025-01-15 10:00:20` - Scan 5

**Gap:** No scans for 20 minutes

**END Batch (scans within 30 seconds):**
6. `2025-01-15 10:20:00` - Scan 6
7. `2025-01-15 10:20:05` - Scan 7
8. `2025-01-15 10:20:10` - Scan 8
9. `2025-01-15 10:20:15` - Scan 9
10. `2025-01-15 10:20:20` - Scan 10
11. `2025-01-15 10:20:25` - Scan 11

**Result:**
- `operation_started_at`: `2025-01-15 10:00:00` (START batch start)
- `operation_completed_at`: `2025-01-15 10:20:00` (END batch start)
- `operation_duration_seconds`: `1200` seconds (20 minutes)
- `scan_count`: `11` total scans
- `start_batch_size`: `5` scans
- `end_batch_size`: `6` scans

**Note:** Duration is calculated from START batch start to END batch start, not from first scan to last scan.

## Performance Considerations

- **Indexes** are created on `operation_duration_seconds` and time range columns for fast queries
- **Stored values** avoid recalculating from `scanned_codes` every time
- **View** provides fallback calculation if stored value is NULL
- **Function** can be called on-demand for historical data or corrections

## Future Enhancements

Potential improvements:
1. **Batch processing** - Update durations for multiple operations at once
2. **Scheduled recalculation** - Periodically recalculate durations to ensure accuracy
3. **Duration validation** - Flag operations with unusually long/short durations
4. **Reporting dashboard** - Visualize operation times and trends

