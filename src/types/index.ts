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
