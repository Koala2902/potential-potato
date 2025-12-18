import { Factory, CheckCircle2, AlertCircle, Activity, Clock } from 'lucide-react';
import { mockMachines } from '../../data/scheduleData';
import { mockScheduledJobs } from '../../data/scheduleData';
import { Machine, ScheduledJob } from '../../types';
import './ProductionPage.css';

export default function ProductionPage() {
    const machines = mockMachines;
    const scheduledJobs = mockScheduledJobs;

    const getMachineStats = (machineId: string) => {
        const machineJobs = scheduledJobs.filter((job) => job.machineId === machineId);
        const completed = machineJobs.filter((job) => job.status === 'completed').length;

        return { completed };
    };

    const getMachineStatus = (machine: Machine): { label: string; color: string; bgColor: string } => {
        switch (machine.status) {
            case 'active':
                return {
                    label: 'Active',
                    color: 'var(--accent-success)',
                    bgColor: 'rgba(16, 185, 129, 0.15)',
                };
            case 'maintenance':
                return {
                    label: 'Maintenance',
                    color: 'var(--accent-warning)',
                    bgColor: 'rgba(245, 158, 11, 0.15)',
                };
            case 'inactive':
                return {
                    label: 'Inactive',
                    color: 'var(--text-muted)',
                    bgColor: 'rgba(100, 116, 139, 0.15)',
                };
            default:
                return {
                    label: 'Unknown',
                    color: 'var(--text-secondary)',
                    bgColor: 'rgba(100, 116, 139, 0.15)',
                };
        }
    };

    const getRecentActivity = (machineId: string): ScheduledJob[] => {
        const machineJobs = scheduledJobs
            .filter((job) => job.machineId === machineId)
            .sort((a, b) => {
                // Sort by start time, most recent first
                return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
            })
            .slice(0, 5); // Get top 5 most recent

        return machineJobs;
    };

    const formatTimeAgo = (dateString: string): string => {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
        if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
        return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    };

    return (
        <div className="production-page">
            <div className="production-header">
                <div className="production-title">
                    <Factory size={24} />
                    <h2>Production Overview</h2>
                </div>
            </div>

            <div className="production-machines-grid">
                {machines.map((machine) => {
                    const stats = getMachineStats(machine.id);
                    const recentActivity = getRecentActivity(machine.id);

                    return (
                        <div
                            key={machine.id}
                            className={`machine-production-card ${
                                machine.status !== 'active' ? 'inactive' : ''
                            }`}
                        >
                            <div className="machine-card-header">
                                <div className="machine-card-title">
                                    <div className="machine-card-name">{machine.name}</div>
                                    <div className="machine-card-code">{machine.code}</div>
                                </div>
                                {machine.status === 'maintenance' && (
                                    <div className="machine-status-badge">Maintenance</div>
                                )}
                            </div>

                            <div className="machine-stats-grid">
                                <div className="machine-stat-item">
                                    <div className="machine-stat-icon completed">
                                        <CheckCircle2 size={18} />
                                    </div>
                                    <div className="machine-stat-content">
                                        <div className="machine-stat-value">{stats.completed}</div>
                                        <div className="machine-stat-label">Completed</div>
                                    </div>
                                </div>

                                <div className="machine-stat-item">
                                    <div
                                        className="machine-stat-icon status"
                                        style={{
                                            background: getMachineStatus(machine).bgColor,
                                            color: getMachineStatus(machine).color,
                                        }}
                                    >
                                        <Activity size={18} />
                                    </div>
                                    <div className="machine-stat-content">
                                        <div
                                            className="machine-stat-value"
                                            style={{ color: getMachineStatus(machine).color }}
                                        >
                                            {getMachineStatus(machine).label}
                                        </div>
                                        <div className="machine-stat-label">Status</div>
                                    </div>
                                </div>
                            </div>

                            <div className="machine-recent-activity">
                                <div className="recent-activity-header">Recent Activity</div>
                                <div className="recent-activity-list">
                                    {recentActivity.length > 0 ? (
                                        recentActivity.map((job) => (
                                            <div
                                                key={job.id}
                                                className={`recent-activity-item ${job.status}`}
                                            >
                                                <div className="recent-activity-job-code">
                                                    {job.jobCode}
                                                </div>
                                                <div className="recent-activity-time">
                                                    {formatTimeAgo(job.startTime)}
                                                </div>
                                                <div className="recent-activity-status">
                                                    {job.status === 'completed' && (
                                                        <CheckCircle2
                                                            size={14}
                                                            className="status-icon completed"
                                                        />
                                                    )}
                                                    {job.status === 'started' && (
                                                        <Clock
                                                            size={14}
                                                            className="status-icon in-progress"
                                                        />
                                                    )}
                                                    {job.status === 'pending' && (
                                                        <AlertCircle
                                                            size={14}
                                                            className="status-icon pending"
                                                        />
                                                    )}
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="no-activity">No recent activity</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

