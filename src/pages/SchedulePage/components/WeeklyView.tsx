import { Machine, ScheduledJob } from '../../../types';
import './ScheduleViews.css';

interface WeeklyViewProps {
    startDate: Date;
    machines: Machine[];
    selectedMachines: string[];
    scheduledJobs: ScheduledJob[];
}

export default function WeeklyView({
    startDate,
    machines,
    selectedMachines,
    scheduledJobs,
}: WeeklyViewProps) {
    const filteredMachines = machines.filter((m) => selectedMachines.includes(m.id));
    
    // Get the week's dates (Monday to Sunday)
    const weekDates: Date[] = [];
    const monday = new Date(startDate);
    const day = monday.getDay();
    const diff = monday.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
    monday.setDate(diff);
    
    for (let i = 0; i < 7; i++) {
        const date = new Date(monday);
        date.setDate(monday.getDate() + i);
        weekDates.push(date);
    }

    const getJobsForDay = (machineId: string, date: Date): ScheduledJob[] => {
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(date);
        dayEnd.setHours(23, 59, 59, 999);

        return scheduledJobs.filter((job) => {
            if (job.machineId !== machineId) return false;
            const jobDate = new Date(job.startTime);
            return jobDate >= dayStart && jobDate <= dayEnd;
        });
    };

    const getJobDuration = (job: ScheduledJob): number => {
        const start = new Date(job.startTime);
        const end = new Date(job.endTime);
        return (end.getTime() - start.getTime()) / (1000 * 60 * 60); // hours
    };

    return (
        <div className="weekly-view">
            <div className="weekly-grid">
                <div className="weekly-header">
                    <div className="machine-row-header">Machine</div>
                    {weekDates.map((date, idx) => (
                        <div key={idx} className="day-header">
                            <div className="day-name">
                                {date.toLocaleDateString('en-US', { weekday: 'short' })}
                            </div>
                            <div className="day-date">
                                {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            </div>
                        </div>
                    ))}
                </div>
                {filteredMachines.map((machine) => {
                    const machineJobsByDay = weekDates.map((date) =>
                        getJobsForDay(machine.id, date)
                    );
                    const totalJobs = machineJobsByDay.reduce((sum, jobs) => sum + jobs.length, 0);

                    return (
                        <div key={machine.id} className="weekly-row">
                            <div className="machine-cell">
                                <div className="machine-name">{machine.name}</div>
                                <div className="machine-code">{machine.code}</div>
                                <div className="machine-job-count">{totalJobs} jobs</div>
                            </div>
                            {weekDates.map((date, dayIdx) => {
                                const dayJobs = machineJobsByDay[dayIdx];
                                const totalHours = dayJobs.reduce(
                                    (sum, job) => sum + getJobDuration(job),
                                    0
                                );

                                return (
                                    <div key={dayIdx} className="day-cell">
                                        {dayJobs.length > 0 && (
                                            <div className="day-jobs-group">
                                                <div className="day-jobs-count">
                                                    {dayJobs.length} {dayJobs.length === 1 ? 'job' : 'jobs'}
                                                </div>
                                                <div className="day-jobs-hours">
                                                    {totalHours.toFixed(1)}h
                                                </div>
                                                <div className="day-jobs-list">
                                                    {dayJobs.map((job) => (
                                                        <div
                                                            key={job.id}
                                                            className={`job-chip job-${job.status}`}
                                                            title={`${job.jobCode} - ${new Date(job.startTime).toLocaleTimeString()} - ${new Date(job.endTime).toLocaleTimeString()}`}
                                                        >
                                                            {job.jobCode}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

