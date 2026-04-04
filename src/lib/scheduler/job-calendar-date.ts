import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { getAppTimeZone } from "./app-timezone";

export type JobDateBasis = "scheduled" | "due" | "created";

export type JobCalendarFields = {
  scheduledDate: string | null;
  dueDate: string | null;
  createdAt: string;
};

export function getJobCalendarMeta(job: JobCalendarFields): {
  dateKey: string;
  basis: JobDateBasis;
} {
  const tz = getAppTimeZone();
  if (job.scheduledDate) {
    return {
      dateKey: formatInTimeZone(new Date(job.scheduledDate), tz, "yyyy-MM-dd"),
      basis: "scheduled",
    };
  }
  if (job.dueDate) {
    return {
      dateKey: formatInTimeZone(new Date(job.dueDate), tz, "yyyy-MM-dd"),
      basis: "due",
    };
  }
  return {
    dateKey: formatInTimeZone(new Date(job.createdAt), tz, "yyyy-MM-dd"),
    basis: "created",
  };
}

export function getScheduledDateForMachine(
    machineSchedules: Array<{ machineId: string; scheduledDate: string }> | undefined,
    machineId: string
): string | null {
    const row = machineSchedules?.find((s) => s.machineId === machineId);
    return row?.scheduledDate ?? null;
}

/** Calendar day `yyyy-MM-dd` → UTC ISO stored on `JobMachineSchedule.scheduledDate` (noon in app zone). */
export function dateKeyToScheduledDateIso(dateKey: string): string {
  const tz = getAppTimeZone();
  return fromZonedTime(`${dateKey}T12:00:00`, tz).toISOString();
}
