export type JobStatus = 'pending' | 'started' | 'completed';

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
  material?: string;
  finishing?: string;
  operations?: JobOperations;
  totalVersions?: number;
  completedVersions?: number;
  versionTags?: string[];
  currentStatus?: string;
  maxCompletedSequence?: number;
  runlistId?: string | null;
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
  // Extended fields from API
  machine_id?: string;
  machine_name?: string;
  machine_type?: string;
  availability_status?: string;
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
    file_items?: ImpositionFileItem[];
    file_ids?: string[];
    file_id?: string; // Keep for backward compatibility
    [key: string]: any;
}

export interface ImpositionFileItem {
    file_id: string;
    qty: number | null;
}
