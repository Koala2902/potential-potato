import { Job } from '../../types';
import { MessageSquare, Calendar, AlertCircle, PackageCheck } from 'lucide-react';
import './ProductionInfo.css';

interface ProductionInfoProps {
    job: Job | null;
}

export default function ProductionInfo({ job }: ProductionInfoProps) {
    if (!job) {
        return (
            <div className="production-info">
                <div className="production-empty">
                    <PackageCheck size={48} strokeWidth={1.5} />
                    <p>Select a job to view production details</p>
                </div>
            </div>
        );
    }

    const getDueDateStatus = () => {
        const dueDate = new Date(job.dueDate);
        const now = new Date();
        const diffHours = (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60);

        if (diffHours < 0) {
            return { status: 'overdue', label: 'OVERDUE', color: 'danger' };
        } else if (diffHours < 24) {
            return { status: 'urgent', label: 'DUE TODAY', color: 'warning' };
        } else if (diffHours < 48) {
            return { status: 'soon', label: 'DUE TOMORROW', color: 'warning' };
        } else {
            return { status: 'normal', label: 'ON TRACK', color: 'success' };
        }
    };

    const dueDateStatus = getDueDateStatus();

    const formatFullDate = (dateString: string) => {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    };

    const formatTime = (dateString: string) => {
        const date = new Date(dateString);
        return date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    return (
        <div className="production-info">
            <div className="production-header">
                <h2>Production Details</h2>
            </div>

            <div className="production-content">
                {/* Due Date Section */}
                <div className="info-section">
                    <div className="section-header">
                        <Calendar size={18} />
                        <h3>Due Date</h3>
                    </div>
                    <div className={`due-date-card ${dueDateStatus.color}`}>
                        <div className={`status-badge badge-${dueDateStatus.color}`}>
                            {dueDateStatus.label}
                        </div>
                        <div className="due-date-details">
                            <div className="due-date-main">{formatFullDate(job.dueDate)}</div>
                            <div className="due-time">Expected by {formatTime(job.dueDate)}</div>
                        </div>
                    </div>
                </div>

                {/* Comments Section */}
                <div className="info-section">
                    <div className="section-header">
                        <MessageSquare size={18} />
                        <h3>Production Notes</h3>
                    </div>
                    <div className="comments-card">
                        <p>{job.comments}</p>
                    </div>
                </div>

                {/* Quantity Explanation Section */}
                <div className="info-section">
                    <div className="section-header">
                        <AlertCircle size={18} />
                        <h3>Quantity Details</h3>
                    </div>
                    <div className="qty-card">
                        <div className="qty-header">
                            <span className="qty-label">Total Quantity</span>
                            <span className="qty-value">{job.versionQty.toLocaleString()}</span>
                        </div>
                        <div className="qty-explanation">
                            {job.qtyExplanation}
                        </div>
                    </div>
                </div>

                {/* Status Timeline */}
                <div className="info-section">
                    <div className="section-header">
                        <PackageCheck size={18} />
                        <h3>Progress Timeline</h3>
                    </div>
                    <div className="timeline">
                        <div className={`timeline-item ${job.createdAt ? 'completed' : ''}`}>
                            <div className="timeline-marker"></div>
                            <div className="timeline-content">
                                <div className="timeline-title">Created</div>
                                <div className="timeline-time">
                                    {new Date(job.createdAt).toLocaleDateString('en-US', {
                                        month: 'short',
                                        day: 'numeric',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                    })}
                                </div>
                            </div>
                        </div>

                        <div className={`timeline-item ${job.startedAt ? 'completed' : job.status === 'started' ? 'active' : ''}`}>
                            <div className="timeline-marker"></div>
                            <div className="timeline-content">
                                <div className="timeline-title">Started</div>
                                <div className="timeline-time">
                                    {job.startedAt
                                        ? new Date(job.startedAt).toLocaleDateString('en-US', {
                                            month: 'short',
                                            day: 'numeric',
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })
                                        : 'Pending'}
                                </div>
                            </div>
                        </div>

                        <div className={`timeline-item ${job.completedAt ? 'completed' : ''}`}>
                            <div className="timeline-marker"></div>
                            <div className="timeline-content">
                                <div className="timeline-title">Completed</div>
                                <div className="timeline-time">
                                    {job.completedAt
                                        ? new Date(job.completedAt).toLocaleDateString('en-US', {
                                            month: 'short',
                                            day: 'numeric',
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })
                                        : 'Pending'}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
