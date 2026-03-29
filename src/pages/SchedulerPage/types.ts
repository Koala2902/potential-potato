import type { JobDateBasis } from "../../lib/scheduler/job-calendar-date";

export type CalendarJobItem = {
  id: string;
  material: string;
  finishing: string;
  productionPath: string;
  pdfQty: number;
  source: string;
  dateBasis: JobDateBasis;
  /** Estimated minutes on the selected machine (routing step); null if not computed. */
  estimatedMinutesForMachine: number | null;
};
