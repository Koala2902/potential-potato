export type JobStatus = 'pending' | 'started' | 'completed';

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
}

export interface ImpositionDetails {
    imposition_id: string;
    file_ids?: string[];
    file_id?: string; // Keep for backward compatibility
    [key: string]: any;
}
