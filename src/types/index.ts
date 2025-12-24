export type JobStatus = 'pending' | 'started' | 'completed';

// Job Status Categories for JobStatusPage
export type JobStatusCategory = 'print_ready' | 'printed' | 'digital_cut' | 'slitter' | 'production_finished';

// Group by rules
export type GroupByRule = 'material' | 'finishing' | 'material_finishing' | 'runlist';

// Sort by rules
export type SortByRule = 'due_date' | 'created_at' | 'job_code';

// Job operations status
export interface JobOperations {
  print?: boolean;
  coating?: boolean;
  kiss_cut?: boolean;
  backscore?: boolean;
  slitter?: boolean;
}

export interface Job {
  id: string;
  jobCode: string;
  rollId: string;
  orderId: string;
  ticketId: string;
  versionTag: string;
  versionQty: number;
  pdfPath: string;
  status: JobStatus;
  dueDate: string;
  comments: string;
  qtyExplanation: string;
  positionInRoll: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  // Extended fields for JobStatusPage
  material?: string;
  finishing?: string;
  operations?: JobOperations;
  // Grouped job fields (from job_operations)
  totalVersions?: number;
  completedVersions?: number;
  versionTags?: string[];
  currentStatus?: string; // 'print_ready' | 'printed' | 'digital_cut' | 'slitter' | 'production_finished'
  maxCompletedSequence?: number;
  runlistId?: string | null; // Runlist ID for grouping
}

export interface Roll {
  id: string;
  rollCode: string;
  createdAt: string;
  status: 'active' | 'completed' | 'archived';
  jobs: Job[];
}

export interface ScanEvent {
  jobId: string;
  jobCode: string;
  scannedAt: string;
  scanType: 'start' | 'finish';
}

export interface AppState {
  currentRoll: Roll | null;
  selectedJob: Job | null;
  lastScannedJob: Job | null;
  jobs: Job[];
  isLoading: boolean;
}

export interface Machine {
  id: string;
  name: string;
  code: string;
  type: string;
  status: 'active' | 'maintenance' | 'inactive';
}

export interface ScheduledJob {
  id: string;
  jobId: string;
  jobCode: string;
  machineId: string;
  startTime: string; // ISO datetime
  endTime: string; // ISO datetime
  status: JobStatus;
  orderId: string;
  ticketId: string;
  qty: number;
}

export interface ProductionQueueItem {
  runlist_id: string;
  imposition_count: number;
  impositions: ImpositionItem[];
}

export interface ImpositionItem {
  imposition_id: string;
  simplified_name: string;
  sheet_width?: number;
}

export interface ImpositionDetails {
    imposition_id: string;
    file_ids?: string[];
    file_id?: string; // Keep for backward compatibility
    [key: string]: any;
}

// JobStatusCard configuration
export interface JobStatusCardConfig {
  status: JobStatusCategory;
  filterRule: (job: Job) => boolean;
  groupBy: GroupByRule;
  sortBy: SortByRule;
  title: string;
  description: string;
  icon: string; // Icon name for lucide-react
}

// Grouped jobs for display
export interface GroupedJobs {
  groupKey: string;
  jobs: Job[];
}
