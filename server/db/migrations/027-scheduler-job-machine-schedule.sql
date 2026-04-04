-- Per-machine calendar rows (matches Prisma model JobMachineSchedule).
CREATE TABLE IF NOT EXISTS scheduler."JobMachineSchedule" (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    "jobId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobMachineSchedule_pkey" PRIMARY KEY (id),
    CONSTRAINT "JobMachineSchedule_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES scheduler."Job"(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JobMachineSchedule_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES scheduler."Machine"(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JobMachineSchedule_jobId_machineId_key" UNIQUE ("jobId", "machineId")
);
