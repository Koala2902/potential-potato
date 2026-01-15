# Production Suite - Feature Integration Plan

**Date:** January 15, 2026  
**Base System:** Production Suite (Operation/Schedule/Production pages)  
**Reference:** PDF Selector & Print Production Management System Documentation

---

## Current System Overview

### Existing Pages
1. **Operation Page** - Production queue grouped by runlist_id, imposition viewer with PDF preview area
2. **Schedule Page** - Daily/Weekly/Monthly views with machine selection and scheduling
3. **Production Page** - Machine cards showing completed jobs, status, and recent activity

### Existing Infrastructure
- Express backend server (port 3001)
- PostgreSQL database connection
- React + TypeScript frontend
- Vite build system
- Dark theme UI with custom CSS

---

## Feature Integration Plan

### Phase 1: Enhance Operation Page (Priority: HIGH)

#### 1.1 File Management System
**Current State:** Operation page shows imposition details but no file management

**Add:**
- [ ] File upload component for imposition files
- [ ] PDF thumbnail preview in the middle panel (top 2/3 section)
- [ ] File list with delete functionality
- [ ] File organization: `{customerName}/{size}/{imposition_id}/files/`
- [ ] Thumbnail generation service (server-side)

**Implementation:**
- Create `FileDropZone` component (adapt from reference)
- Add file upload endpoint: `POST /api/imposition/:impositionId/upload-file`
- Add file list endpoint: `GET /api/imposition/:impositionId/files`
- Add thumbnail generation using Sharp library
- Integrate into `ImpositionViewer` component

**Files to Create:**
- `src/components/FileDropZone.tsx`
- `src/components/PdfThumbnail.tsx`
- `server/controllers/fileController.ts`
- `server/services/fileService.ts`

---

#### 1.2 Notes System
**Current State:** No notes functionality

**Add:**
- [ ] Notes component for each imposition
- [ ] Add/edit/delete notes with timestamps
- [ ] Store notes in database (new table: `imposition_notes`)

**Implementation:**
- Create `SimpleNotes` component (adapt from reference)
- Add notes table: `imposition_notes(imposition_id, note_text, created_at, user_id)`
- Add API endpoints: `GET/POST/DELETE /api/imposition/:impositionId/notes`
- Integrate into `ImpositionViewer` details section (bottom 1/3)

**Files to Create:**
- `src/components/SimpleNotes.tsx`
- `server/db/migrations/create_imposition_notes.sql`

---

#### 1.3 Status Tracking
**Current State:** No status tracking for impositions

**Add:**
- [ ] Status badges (Pending, In Progress, Completed)
- [ ] Status update functionality
- [ ] Visual indicators in production queue list

**Implementation:**
- Add `status` column to `production_planner_paths` table (or create junction table)
- Add status update endpoint: `PUT /api/imposition/:impositionId/status`
- Update `ProductionQueueList` to show status badges
- Add status filter to queue

**Database Changes:**
```sql
ALTER TABLE production_planner_paths 
ADD COLUMN status VARCHAR(20) DEFAULT 'pending';

-- Or create separate tracking table
CREATE TABLE imposition_status (
  imposition_id TEXT PRIMARY KEY,
  status VARCHAR(20) DEFAULT 'pending',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by VARCHAR(50)
);
```

---

### Phase 2: Enhance Schedule Page (Priority: MEDIUM)

#### 2.1 Job Assignment to Schedule
**Current State:** Schedule shows mock scheduled jobs

**Add:**
- [ ] Drag-and-drop impositions from Operation page to Schedule
- [ ] Assign impositions to machines and time slots
- [ ] Save schedule assignments to database

**Implementation:**
- Create `scheduled_jobs` table (already exists in types, need to create in DB)
- Add schedule assignment endpoint: `POST /api/schedule/assign`
- Update Schedule views to fetch from database
- Add drag-and-drop functionality (use react-dnd or similar)

**Database:**
```sql
CREATE TABLE scheduled_jobs (
  scheduled_job_id SERIAL PRIMARY KEY,
  imposition_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  runlist_id TEXT,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (imposition_id) REFERENCES imposition_configurations(imposition_id)
);
```

---

#### 2.2 Schedule Management
**Current State:** Read-only schedule views

**Add:**
- [ ] Edit scheduled job times (drag to resize)
- [ ] Delete scheduled jobs
- [ ] Bulk operations (assign multiple impositions)
- [ ] Schedule conflicts detection

**Implementation:**
- Add update endpoint: `PUT /api/schedule/:scheduledJobId`
- Add delete endpoint: `DELETE /api/schedule/:scheduledJobId`
- Add conflict detection logic in service layer
- Update DailyView to support drag-to-resize

---

### Phase 3: Enhance Production Page (Priority: MEDIUM)

#### 3.1 Real-time Status Updates
**Current State:** Static machine cards

**Add:**
- [ ] WebSocket connection for real-time updates
- [ ] Live status changes when impositions are scanned/updated
- [ ] Activity feed updates in real-time

**Implementation:**
- Add WebSocket server (use `ws` package)
- Create `useWebSocket` hook for React
- Update Production page to subscribe to machine status updates
- Broadcast status changes from Operation/Schedule pages

**Files to Create:**
- `server/websocket.ts`
- `src/hooks/useWebSocket.ts`

---

#### 3.2 Machine Operations Tracking
**Current State:** Shows completed count and status

**Add:**
- [ ] Operations performed per machine
- [ ] Setup times tracking
- [ ] Capacity utilization metrics
- [ ] Operation history

**Implementation:**
- Create `machine_operations_log` table
- Add operations tracking endpoints
- Update machine cards to show operations in progress
- Add operations timeline view

**Database:**
```sql
CREATE TABLE machine_operations_log (
  log_id SERIAL PRIMARY KEY,
  machine_id TEXT NOT NULL,
  imposition_id TEXT,
  operation_id TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  operator_id TEXT,
  notes TEXT
);
```

---

### Phase 4: Add Scanning System (Priority: HIGH)

#### 4.1 Scanning Page
**Current State:** No scanning functionality

**Add:**
- [ ] New "Scanning" page in navigation
- [ ] Machine selection dropdown
- [ ] Operation checklist (dynamically loaded per machine)
- [ ] Scan input field with auto-submit
- [ ] Recent scans tracking

**Implementation:**
- Create `ScanningPage` component
- Add scanning endpoint: `POST /api/scans`
- Create `scanned_codes` table
- Add validation logic (check if imposition_id exists)
- Update Operation page to highlight scanned impositions

**Database:**
```sql
CREATE TABLE scanned_codes (
  scan_id SERIAL PRIMARY KEY,
  code_text VARCHAR(255) NOT NULL,
  imposition_id TEXT,
  scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  machine_id TEXT,
  user_id TEXT,
  operations JSONB,
  metadata JSONB,
  validation_status VARCHAR(20) DEFAULT 'pending'
);
```

**Files to Create:**
- `src/pages/ScanningPage/ScanningPage.tsx`
- `src/pages/ScanningPage/ScanningPage.css`
- `server/controllers/scanningController.ts`
- `server/services/scanningService.ts`

---

#### 4.2 Scan Validation
**Add:**
- [ ] Validate scanned codes against impositions
- [ ] Link scans to impositions automatically
- [ ] Show scan history in Operation page
- [ ] Status indicators (valid/invalid/pending)

**Implementation:**
- Add validation service
- Update `getImpositionDetails` to include scan history
- Add scan status indicators to `ProductionQueueList`

---

### Phase 5: Add Kanban Board (Priority: LOW)

#### 5.1 Production Workflow Kanban
**Current State:** No workflow visualization

**Add:**
- [ ] New "Workflow" page or tab in Production page
- [ ] Kanban board with columns: Print Ready, Printing, Finishing, Quality Check, Dispatched
- [ ] Drag-and-drop impositions between columns
- [ ] Group by: Customer, Material, Finishing

**Implementation:**
- Create `KanbanBoard` component (adapt from reference)
- Add workflow status to impositions
- Add drag-and-drop library (react-beautiful-dnd or dnd-kit)
- Add workflow update endpoint

**Files to Create:**
- `src/components/KanbanBoard.tsx`
- `src/pages/WorkflowPage/WorkflowPage.tsx` (or add as tab to Production)

---

### Phase 6: Material Management (Priority: LOW)

#### 6.1 Materials Page
**Current State:** No material management

**Add:**
- [ ] Materials CRUD interface
- [ ] Supplier management
- [ ] Material groups/categories
- [ ] Link materials to impositions

**Implementation:**
- Create `MaterialsPage` component
- Add materials API endpoints
- Link to `imposition_configurations.material` field
- Add material selection in Operation page

**Note:** Materials data already exists in `imposition_configurations.material` field, so this is mainly for management UI.

---

## Implementation Priority

### Immediate (Week 1)
1. ✅ File upload system for Operation page
2. ✅ PDF thumbnail preview
3. ✅ Notes system
4. ✅ Status tracking

### Short-term (Week 2-3)
5. ✅ Scanning system
6. ✅ Schedule assignment from Operation page
7. ✅ Real-time updates (WebSocket)

### Medium-term (Month 2)
8. ✅ Kanban workflow board
9. ✅ Material management
10. ✅ Advanced schedule management (drag-to-resize, conflicts)

### Long-term (Month 3+)
11. ✅ Analytics dashboard
12. ✅ Reporting system
13. ✅ User management and permissions
14. ✅ Audit logging

---

## Database Schema Additions

### New Tables Needed

```sql
-- File management
CREATE TABLE imposition_files (
  file_id SERIAL PRIMARY KEY,
  imposition_id TEXT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  thumbnail_path TEXT,
  file_size BIGINT,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  uploaded_by VARCHAR(50),
  FOREIGN KEY (imposition_id) REFERENCES imposition_configurations(imposition_id)
);

-- Notes
CREATE TABLE imposition_notes (
  note_id SERIAL PRIMARY KEY,
  imposition_id TEXT NOT NULL,
  note_text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(50),
  FOREIGN KEY (imposition_id) REFERENCES imposition_configurations(imposition_id)
);

-- Status tracking
CREATE TABLE imposition_status (
  imposition_id TEXT PRIMARY KEY,
  status VARCHAR(20) DEFAULT 'pending',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by VARCHAR(50),
  FOREIGN KEY (imposition_id) REFERENCES imposition_configurations(imposition_id)
);

-- Scheduled jobs (if not exists)
CREATE TABLE scheduled_jobs (
  scheduled_job_id SERIAL PRIMARY KEY,
  imposition_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  runlist_id TEXT,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (imposition_id) REFERENCES imposition_configurations(imposition_id)
);

-- Scanned codes
CREATE TABLE scanned_codes (
  scan_id SERIAL PRIMARY KEY,
  code_text VARCHAR(255) NOT NULL,
  imposition_id TEXT,
  scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  machine_id TEXT,
  user_id TEXT,
  operations JSONB,
  metadata JSONB,
  validation_status VARCHAR(20) DEFAULT 'pending',
  validation_results JSONB,
  validated_at TIMESTAMP
);

-- Machine operations log
CREATE TABLE machine_operations_log (
  log_id SERIAL PRIMARY KEY,
  machine_id TEXT NOT NULL,
  imposition_id TEXT,
  operation_id TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  operator_id TEXT,
  notes TEXT,
  duration_minutes INTEGER
);
```

---

## API Endpoints to Add

### File Management
- `POST /api/imposition/:impositionId/upload-file` - Upload file
- `GET /api/imposition/:impositionId/files` - List files
- `GET /api/file/:fileId/thumbnail` - Get thumbnail
- `DELETE /api/file/:fileId` - Delete file

### Notes
- `GET /api/imposition/:impositionId/notes` - Get notes
- `POST /api/imposition/:impositionId/notes` - Add note
- `DELETE /api/note/:noteId` - Delete note

### Status
- `PUT /api/imposition/:impositionId/status` - Update status
- `GET /api/imposition/:impositionId/status` - Get status

### Schedule
- `POST /api/schedule/assign` - Assign imposition to schedule
- `PUT /api/schedule/:scheduledJobId` - Update schedule
- `DELETE /api/schedule/:scheduledJobId` - Delete schedule
- `GET /api/schedule/conflicts` - Check for conflicts

### Scanning
- `POST /api/scans` - Record scan
- `GET /api/scans/recent` - Get recent scans
- `GET /api/scans/:impositionId` - Get scans for imposition

### Machine Operations
- `POST /api/machine-operations/log` - Log operation
- `GET /api/machine-operations/:machineId` - Get operations for machine

---

## Component Architecture

### New Components to Create

```
src/components/
  FileDropZone.tsx          # File upload with drag-and-drop
  PdfThumbnail.tsx          # PDF thumbnail preview
  SimpleNotes.tsx           # Notes management
  DeleteFileModal.tsx       # File deletion confirmation
  StatusBadge.tsx           # Status indicator badge
  ScanInput.tsx             # Scanning input field
  RecentScans.tsx           # Recent scans list
  MachineSelector.tsx       # Machine selection dropdown
  OperationChecklist.tsx    # Operations checklist
  KanbanBoard.tsx           # Kanban workflow board
  KanbanCard.tsx            # Individual kanban card
```

### Updated Components

```
src/components/
  LeftPanel/
    ProductionQueueList.tsx    # Add status badges, scan indicators
  MiddlePanel/
    ImpositionViewer.tsx       # Add file upload, notes, PDF preview
  Navigation/
    Navigation.tsx             # Add Scanning page link
```

---

## Technology Additions

### New Dependencies

```json
{
  "dependencies": {
    "sharp": "^0.33.0",              // Image processing for thumbnails
    "ws": "^8.16.0",                  // WebSocket server
    "react-dnd": "^16.0.1",           // Drag and drop (or dnd-kit)
    "react-dnd-html5-backend": "^16.0.1"
  },
  "devDependencies": {
    "@types/ws": "^8.5.10"
  }
}
```

---

## File Structure Updates

```
server/
  controllers/
    fileController.ts        # File upload/download
    notesController.ts       # Notes CRUD
    statusController.ts      # Status updates
    scheduleController.ts    # Schedule management
    scanningController.ts    # Scanning operations
    machineOperationsController.ts
  services/
    fileService.ts           # File operations logic
    thumbnailService.ts      # Thumbnail generation
    notesService.ts          # Notes business logic
    scanningService.ts       # Scan validation
    scheduleService.ts       # Schedule conflict detection
  db/
    migrations/              # Database migrations
      create_file_tables.sql
      create_notes_table.sql
      create_status_table.sql
      create_scans_table.sql
  websocket.ts              # WebSocket server setup

src/
  components/
    FileDropZone.tsx
    PdfThumbnail.tsx
    SimpleNotes.tsx
    StatusBadge.tsx
    ScanInput.tsx
    KanbanBoard.tsx
  pages/
    ScanningPage/
      ScanningPage.tsx
      ScanningPage.css
  hooks/
    useWebSocket.ts          # WebSocket hook
    useFileUpload.ts          # File upload hook
  services/
    fileApi.ts               # File API calls
    notesApi.ts               # Notes API calls
    scanningApi.ts            # Scanning API calls
```

---

## Integration Points

### Operation Page Enhancements
1. **File Management:**
   - Add FileDropZone to ImpositionViewer (top section)
   - Show PDF thumbnails in preview area
   - Add file list in details section

2. **Notes:**
   - Add SimpleNotes component to details section
   - Show notes count in ProductionQueueList

3. **Status:**
   - Add status badges to ProductionQueueList items
   - Add status update button in ImpositionViewer

4. **Scanning Integration:**
   - Highlight impositions that have been scanned
   - Show scan count in queue list
   - Link to scan history

### Schedule Page Enhancements
1. **Assignment:**
   - Add "Assign to Schedule" button in Operation page
   - Drag impositions from queue to schedule
   - Show assigned impositions in schedule views

2. **Management:**
   - Make schedule editable (drag to move, resize)
   - Add delete functionality
   - Show conflicts visually

### Production Page Enhancements
1. **Real-time:**
   - Connect WebSocket for live updates
   - Update machine cards when status changes
   - Show active operations

2. **Operations:**
   - Add operations timeline per machine
   - Show current operation in progress
   - Track setup times

---

## Testing Strategy

### Unit Tests
- File upload service
- Thumbnail generation
- Scan validation logic
- Schedule conflict detection

### Integration Tests
- File upload flow
- Scan recording and validation
- Schedule assignment
- Status updates

### E2E Tests
- Complete workflow: Upload → Assign → Schedule → Scan → Complete
- File management operations
- Notes CRUD operations

---

## Migration Strategy

### Phase 1: Foundation (Week 1)
1. Create database tables
2. Add file upload infrastructure
3. Add notes system
4. Add status tracking

### Phase 2: Integration (Week 2)
1. Integrate file upload into Operation page
2. Add notes to ImpositionViewer
3. Add status badges
4. Test end-to-end

### Phase 3: Scanning (Week 3)
1. Create Scanning page
2. Add scan endpoints
3. Integrate with Operation page
4. Add validation logic

### Phase 4: Schedule Enhancement (Week 4)
1. Add schedule assignment
2. Make schedule editable
3. Add conflict detection
4. Test with real data

### Phase 5: Real-time & Polish (Week 5)
1. Add WebSocket
2. Real-time updates
3. Performance optimization
4. UI polish

---

## Success Metrics

### Functionality
- ✅ Files can be uploaded and previewed
- ✅ Notes can be added and viewed
- ✅ Status can be tracked
- ✅ Impositions can be scanned
- ✅ Schedule can be assigned and edited

### Performance
- ✅ File uploads complete in < 5 seconds
- ✅ Thumbnails generate in < 2 seconds
- ✅ Page load time < 1 second
- ✅ Real-time updates < 100ms latency

### User Experience
- ✅ Intuitive file upload
- ✅ Clear status indicators
- ✅ Easy scanning workflow
- ✅ Responsive schedule editing

---

## Notes

- **Priority:** Current system architecture takes precedence
- **Adaptation:** Reference documentation features adapted to fit current structure
- **Database:** Use existing PostgreSQL connection and patterns
- **UI:** Maintain current dark theme and design system
- **API:** Follow existing Express + TypeScript patterns

---

**Next Steps:**
1. Review this plan
2. Prioritize features based on business needs
3. Start with Phase 1 (File Management + Notes + Status)
4. Iterate based on feedback

