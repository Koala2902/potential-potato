# Database Configuration Summary

## Two Databases Found

### 1. **`jobmanager` Database** (53 tables)
**Contains:**
- ✅ `runlists` (0 rows)
- ✅ `runlist_impositions` (0 rows)  
- ✅ `jobs` (702 rows)
- ❌ `production_planner_paths` - **DOES NOT EXIST**
- ❌ `imposition_file_mapping` - **DOES NOT EXIST**
- ❌ `imposition_configurations` - **DOES NOT EXIST**

**Use case:** General job management system

---

### 2. **`logs` Database** (10 tables) ⭐ **CURRENTLY IN USE**
**Contains:**
- ✅ `production_planner_paths` (310 rows) - **HAS DATA**
- ✅ `imposition_file_mapping` (556 rows) - **HAS DATA**
- ✅ `imposition_configurations` (310 rows) - **HAS DATA**
- ❌ `runlists` - **DOES NOT EXIST**
- ❌ `runlist_impositions` - **DOES NOT EXIST**
- ❌ `jobs` - **DOES NOT EXIST**

**Use case:** Production planning and imposition tracking

---

## Current Configuration

**`.env` file:**
```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=logs          # ← Using 'logs' database
DB_USER=postgres
DB_PASSWORD=postgres
PORT=3001
```

**Why `logs` database?**
- The application code expects `production_planner_paths` table
- This table exists ONLY in `logs` database
- The `logs` database has actual production data (310 rows)
- API is working and returning production queue data successfully

---

## API Status

✅ **Working!** 
- Endpoint: `http://localhost:3001/api/production-queue`
- Returns: 72 runlists with impositions
- Data is being fetched successfully from `logs` database

---

## To Switch Databases

If you need to use `jobmanager` instead:
1. Update `.env`: `DB_NAME=jobmanager`
2. Update queries in `server/db/queries.ts` to use `runlists` + `runlist_impositions` tables
3. Restart server

If you need to use `logs` (current):
- Already configured ✅
- No changes needed

