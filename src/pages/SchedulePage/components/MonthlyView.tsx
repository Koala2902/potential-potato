import { Machine, ScheduledJob } from '../../../types';
import './ScheduleViews.css';

interface MonthlyViewProps {
    month: Date;
    machines: Machine[];
    selectedMachines: string[];
    scheduledJobs: ScheduledJob[];
}

export default function MonthlyView({
    month,
    machines,
    selectedMachines,
    scheduledJobs,
}: MonthlyViewProps) {
    const filteredMachines = machines.filter((m) => selectedMachines.includes(m.id));
    
    // Get first and last day of the month
    const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
    const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    
    // Get all dates in the month
    const monthDates: Date[] = [];
    const current = new Date(firstDay);
    while (current <= lastDay) {
        monthDates.push(new Date(current));
        current.setDate(current.getDate() + 1);
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

    const getLoadPercentage = (machineId: string, date: Date): number => {
        const dayJobs = getJobsForDay(machineId, date);
        if (dayJobs.length === 0) return 0;
        
        const totalHours = dayJobs.reduce((sum, job) => {
            const start = new Date(job.startTime);
            const end = new Date(job.endTime);
            return sum + (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        }, 0);
        
        // Assuming 8 hours work day
        return Math.min((totalHours / 8) * 100, 100);
    };

    // Group dates by week
    const weeks: Date[][] = [];
    let currentWeek: Date[] = [];
    
    monthDates.forEach((date, idx) => {
        if (idx === 0) {
            // Fill in days before month starts
            const dayOfWeek = date.getDay();
            for (let i = 0; i < dayOfWeek; i++) {
                currentWeek.push(new Date(0)); // Placeholder
            }
        }
        
        currentWeek.push(date);
        
        if (currentWeek.length === 7 || idx === monthDates.length - 1) {
            // Fill remaining days if needed
            while (currentWeek.length < 7) {
                currentWeek.push(new Date(0)); // Placeholder
            }
            weeks.push([...currentWeek]);
            currentWeek = [];
        }
    });

    return (
        <div className="monthly-view">
            <div className="monthly-header">
                <div className="month-name">
                    {month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                </div>
            </div>
            <div className="monthly-machines-grid">
                {filteredMachines.map((machine) => (
                    <div key={machine.id} className="machine-calendar-card">
                        <div className="machine-calendar-header">
                            <div className="machine-calendar-name">{machine.name}</div>
                            <div className="machine-calendar-code">{machine.code}</div>
                        </div>
                        <div className="machine-calendar-grid">
                            <div className="machine-week-header">
                                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                                    <div key={day} className="machine-weekday-header">
                                        {day}
                                    </div>
                                ))}
                            </div>
                            {weeks.map((week, weekIdx) => (
                                <div key={weekIdx} className="machine-week-row">
                                    {week.map((date, dayIdx) => {
                                        if (date.getTime() === 0) {
                                            return (
                                                <div
                                                    key={`${weekIdx}-${dayIdx}`}
                                                    className="machine-day empty"
                                                ></div>
                                            );
                                        }

                                        const load = getLoadPercentage(machine.id, date);
                                        const jobs = getJobsForDay(machine.id, date);
                                        const isToday =
                                            date.toDateString() === new Date().toDateString();

                                        return (
                                            <div
                                                key={`${weekIdx}-${dayIdx}`}
                                                className={`machine-day ${isToday ? 'today' : ''}`}
                                            >
                                                <div className="machine-day-number">
                                                    {date.getDate()}
                                                </div>
                                                {jobs.length > 0 && (
                                                    <div className="machine-day-load">
                                                        <div
                                                            className={`machine-load-bar load-${getLoadLevel(load)}`}
                                                            style={{ width: `${load}%` }}
                                                            title={`${jobs.length} jobs, ${load.toFixed(0)}% load`}
                                                        ></div>
                                                        <div className="machine-day-job-count">
                                                            {jobs.length}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function getLoadLevel(percentage: number): string {
    if (percentage >= 90) return 'high';
    if (percentage >= 60) return 'medium';
    if (percentage >= 30) return 'low';
    return 'very-low';
}

