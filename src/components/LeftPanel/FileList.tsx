import { Job } from '../../types';
import { Clock, CheckCircle2, Circle } from 'lucide-react';
import './FileList.css';

interface FileListProps {
    jobs: Job[];
    selectedJob: Job | null;
    onSelectJob: (job: Job) => void;
    lastScannedJob: Job | null;
}

export default function FileList({ jobs, selectedJob, onSelectJob, lastScannedJob }: FileListProps) {
    const getStatusIcon = (status: Job['status']) => {
        switch (status) {
            case 'completed':
                return <CheckCircle2 size={16} />;
            case 'started':
                return <Clock size={16} />;
            default:
                return <Circle size={16} />;
        }
    };

    const formatDueDate = (dateString: string) => {
        const date = new Date(dateString);
        const now = new Date();
        const diffHours = (date.getTime() - now.getTime()) / (1000 * 60 * 60);

        if (diffHours < 0) {
            return 'Overdue';
        } else if (diffHours < 24) {
            return 'Due today';
        } else if (diffHours < 48) {
            return 'Due tomorrow';
        } else {
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
    };

    const isDueUrgent = (dateString: string) => {
        const date = new Date(dateString);
        const now = new Date();
        const diffHours = (date.getTime() - now.getTime()) / (1000 * 60 * 60);
        return diffHours < 24;
    };

    return (
        <div className="file-list">
            <div className="file-list-header">
                <h2 className="gradient-text">Production Queue</h2>
                <div className="file-count">
                    {jobs.filter(j => j.status === 'completed').length} / {jobs.length}
                </div>
            </div>

            <div className="file-list-content">
                {jobs.map((job) => (
                    <div
                        key={job.id}
                        className={`file-item ${selectedJob?.id === job.id ? 'active' : ''} ${lastScannedJob?.id === job.id ? 'last-scanned' : ''
                            } ${job.status}`}
                        onClick={() => onSelectJob(job)}
                    >
                        <div className="file-item-header">
                            <div className="file-status-icon">
                                {getStatusIcon(job.status)}
                            </div>
                            <div className="file-info">
                                <div className="file-code">{job.jobCode}</div>
                                <div className="file-ticket">Ticket: {job.ticketId}</div>
                            </div>
                            <span className={`badge badge-${job.status}`}>
                                {job.status}
                            </span>
                        </div>

                        <div className="file-item-details">
                            <div className="detail-row">
                                <span className="detail-label">Order:</span>
                                <span className="detail-value">{job.orderId}</span>
                            </div>
                            <div className="detail-row">
                                <span className="detail-label">Qty:</span>
                                <span className="detail-value">{job.versionQty}</span>
                            </div>
                            <div className="detail-row">
                                <span className="detail-label">Due:</span>
                                <span className={`detail-value ${isDueUrgent(job.dueDate) ? 'urgent' : ''}`}>
                                    {formatDueDate(job.dueDate)}
                                </span>
                            </div>
                        </div>

                        {lastScannedJob?.id === job.id && (
                            <div className="scan-indicator">
                                <div className="scan-pulse"></div>
                                Last Scanned
                            </div>
                        )}

                        {job.status === 'started' && job.startedAt && (
                            <div className="progress-indicator">
                                <div className="progress-bar">
                                    <div className="progress-fill animate-pulse"></div>
                                </div>
                                <span className="progress-text">In Progress</span>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
