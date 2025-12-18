import { Machine, ScheduledJob } from '../../../types';
import './ScheduleViews.css';

interface DailyViewProps {
    date: Date;
    machines: Machine[];
    selectedMachines: string[];
    scheduledJobs: ScheduledJob[];
    startHour: number;
    endHour: number;
    endMinute: number;
}

export default function DailyView({
    date,
    machines,
    selectedMachines,
    scheduledJobs,
    startHour,
    endHour,
    endMinute,
}: DailyViewProps) {
    const filteredMachines = machines.filter((m) => selectedMachines.includes(m.id));
    const dayStart = new Date(date);
    dayStart.setHours(startHour, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(endHour, endMinute, 0, 0);

    // Filter jobs for this day
    const dayJobs = scheduledJobs.filter((job) => {
        const jobDate = new Date(job.startTime);
        return (
            jobDate >= dayStart &&
            jobDate < new Date(dayEnd.getTime() + 24 * 60 * 60 * 1000)
        );
    });

    // Generate time slots (every 30 minutes)
    const timeSlots: Date[] = [];
    const current = new Date(dayStart);
    while (current < dayEnd) {
        timeSlots.push(new Date(current));
        current.setMinutes(current.getMinutes() + 30);
    }

    const getJobPosition = (job: ScheduledJob) => {
        const start = new Date(job.startTime);
        const end = new Date(job.endTime);
        const dayStartTime = new Date(dayStart);
        
        // Calculate minutes from day start
        const startMinutes = (start.getTime() - dayStartTime.getTime()) / (1000 * 60);
        const durationMinutes = (end.getTime() - start.getTime()) / (1000 * 60);
        
        const slotHeight = 60; // pixels per hour (30 min slots = 30px each)
        const top = (startMinutes / 60) * slotHeight;
        const height = (durationMinutes / 60) * slotHeight;
        return { top, height };
    };

    return (
        <div className="daily-view">
            <div className="schedule-grid">
                <div className="time-column">
                    {timeSlots.map((slot, idx) => {
                        if (idx % 2 === 0) {
                            return (
                                <div key={idx} className="time-slot">
                                    {slot.toLocaleTimeString('en-US', {
                                        hour: 'numeric',
                                        minute: '2-digit',
                                        hour12: true,
                                    })}
                                </div>
                            );
                        }
                        return <div key={idx} className="time-slot-minor"></div>;
                    })}
                </div>
                <div className="machines-container">
                    {filteredMachines.map((machine) => {
                        const machineJobs = dayJobs.filter((j) => j.machineId === machine.id);
                        return (
                            <div key={machine.id} className="machine-column">
                                <div className="machine-header">
                                    <div className="machine-name">{machine.name}</div>
                                    <div className="machine-code">{machine.code}</div>
                                </div>
                                <div className="machine-timeline">
                                    {machineJobs.map((job) => {
                                        const { top, height } = getJobPosition(job);
                                        return (
                                            <div
                                                key={job.id}
                                                className={`scheduled-job job-${job.status}`}
                                                style={{
                                                    top: `${top}px`,
                                                    height: `${height}px`,
                                                }}
                                                title={`${job.jobCode} - ${job.startTime} to ${job.endTime}`}
                                            >
                                                <div className="job-code">{job.jobCode}</div>
                                                <div className="job-time">
                                                    {new Date(job.startTime).toLocaleTimeString('en-US', {
                                                        hour: 'numeric',
                                                        minute: '2-digit',
                                                    })}
                                                    {' - '}
                                                    {new Date(job.endTime).toLocaleTimeString('en-US', {
                                                        hour: 'numeric',
                                                        minute: '2-digit',
                                                    })}
                                                </div>
                                                <div className="job-qty">Qty: {job.qty}</div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

