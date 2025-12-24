import { Factory, CheckCircle2, Clock, Activity } from 'lucide-react';
import { useState, useEffect } from 'react';
import { fetchProductionStatus, fetchMachines, ProductionStatus, ProductionJob, Machine } from '../../services/api';
import './ProductionPage.css';

export default function ProductionPage() {
    const [productionStatus, setProductionStatus] = useState<ProductionStatus[]>([]);
    const [machines, setMachines] = useState<Machine[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        loadData();
        // Refresh every 30 seconds
        const interval = setInterval(loadData, 30000);
        return () => clearInterval(interval);
    }, []);

    const loadData = async () => {
        try {
            setLoading(true);
            setError(null);
            const [statusData, machinesData] = await Promise.all([
                fetchProductionStatus(),
                fetchMachines(),
            ]);
            
            // Sort machines in specific order: Indigo, Digicon, Bladerunner, Slitter
            const machineOrder = ['INDIGO', 'DIGICON', 'BLADERUNNER', 'SLITTER'];
            const sortedStatus = statusData.sort((a, b) => {
                const aIndex = machineOrder.findIndex(order => 
                    a.machine_id.toUpperCase().includes(order)
                );
                const bIndex = machineOrder.findIndex(order => 
                    b.machine_id.toUpperCase().includes(order)
                );
                
                // If both found, sort by order
                if (aIndex !== -1 && bIndex !== -1) {
                    return aIndex - bIndex;
                }
                // If only one found, prioritize it
                if (aIndex !== -1) return -1;
                if (bIndex !== -1) return 1;
                // If neither found, maintain original order
                return 0;
            });
            
            setProductionStatus(sortedStatus);
            setMachines(machinesData);
        } catch (err: any) {
            setError(err.message || 'Failed to load production data');
            console.error('Error loading production data:', err);
        } finally {
            setLoading(false);
        }
    };

    const getMachineName = (machineId: string): string => {
        const machine = machines.find(m => m.machine_id === machineId);
        return machine?.machine_name || machineId;
    };

    const formatTimeAgo = (dateString: string): string => {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        return `${diffDays}d ago`;
    };

    const formatDuration = (seconds: number | null): string => {
        if (!seconds) return 'N/A';
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (remainingSeconds === 0) return `${minutes}m`;
        return `${minutes}m ${remainingSeconds}s`;
    };

    const ProgressRing = ({ progress, size = 40 }: { progress: number; size?: number }) => {
        const radius = (size - 8) / 2;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (progress / 100) * circumference;
        const strokeWidth = 4;

        return (
            <div className="progress-ring-container" style={{ width: size, height: size }}>
                <svg width={size} height={size} className="progress-ring">
                    <circle
                        className="progress-ring-background"
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        strokeWidth={strokeWidth}
                    />
                    <circle
                        className="progress-ring-foreground"
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        strokeWidth={strokeWidth}
                        strokeDasharray={circumference}
                        strokeDashoffset={offset}
                        transform={`rotate(-90 ${size / 2} ${size / 2})`}
                    />
                </svg>
                <div className="progress-ring-text">{progress}%</div>
            </div>
        );
    };

    if (loading) {
        return (
            <div className="production-page">
                <div className="production-header">
                    <div className="production-title">
                        <Factory size={24} />
                        <h2>Production Overview</h2>
                    </div>
                </div>
                <div className="loading-state">Loading production data...</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="production-page">
                <div className="production-header">
                    <div className="production-title">
                        <Factory size={24} />
                        <h2>Production Overview</h2>
                    </div>
                </div>
                <div className="error-state">Error: {error}</div>
            </div>
        );
    }

    return (
        <div className="production-page">
            <div className="production-header">
                <div className="production-title">
                    <Factory size={24} />
                    <h2>Production Overview</h2>
                </div>
            </div>

            <div className="production-machines-grid">
                {productionStatus.map((machineStatus) => {
                    const machineName = getMachineName(machineStatus.machine_id);
                    const completedCount = machineStatus.completed.length;
                    const hasProcessing = machineStatus.processing.length > 0;

                    return (
                        <div key={machineStatus.machine_id} className="machine-production-card">
                            <div className="machine-card-header">
                                <div className="machine-card-title">
                                    <div className="machine-card-name">{machineName}</div>
                                    <div className="machine-card-code">{machineStatus.machine_id}</div>
                                </div>
                            </div>

                            <div className="machine-stats-grid">
                                <div className="machine-stat-item">
                                    <div className="machine-stat-icon completed">
                                        <CheckCircle2 size={18} />
                                    </div>
                                    <div className="machine-stat-content">
                                        <div className="machine-stat-value">{completedCount}</div>
                                        <div className="machine-stat-label">Completed</div>
                                    </div>
                                </div>

                                <div className="machine-stat-item">
                                    <div className="machine-stat-icon status">
                                        <Activity size={18} />
                                    </div>
                                    <div className="machine-stat-content">
                                        <div className="machine-stat-value">
                                            {hasProcessing ? 'Active' : 'Idle'}
                                        </div>
                                        <div className="machine-stat-label">Status</div>
                                    </div>
                                </div>
                            </div>

                            {/* Currently Processing */}
                            {hasProcessing && (
                                <div className="machine-processing-section">
                                    <div className="section-header">
                                        <Clock size={14} className="section-icon processing" />
                                        <span>Currently Processing</span>
                                    </div>
                                    {machineStatus.processing.map((job) => (
                                        <div key={job.job_id} className="job-item processing">
                                            <div className="job-info">
                                                <div className="job-id">{job.job_id}</div>
                                                <div className="job-meta">
                                                    <span>{formatTimeAgo(job.last_completed_at)}</span>
                                                    {job.duration_seconds && (
                                                        <span>• {formatDuration(job.duration_seconds)}</span>
                                                    )}
                                                </div>
                                            </div>
                                            {job.total_versions > job.processed_versions && (
                                                <ProgressRing progress={job.progress} size={36} />
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Recent Completed */}
                            {machineStatus.completed.length > 0 && (
                                <div className="machine-recent-activity">
                                    <div className="recent-activity-header">Recent Activity</div>
                                    <div className="recent-activity-list">
                                        {machineStatus.completed.map((job) => (
                                            <div key={job.job_id} className="recent-activity-item completed">
                                                <div className="recent-activity-job-info">
                                                    <div className="recent-activity-job-code">{job.job_id}</div>
                                                    <div className="recent-activity-time">
                                                        {formatTimeAgo(job.last_completed_at)}
                                                        {job.duration_seconds && (
                                                            <> • {formatDuration(job.duration_seconds)}</>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="recent-activity-status">
                                                    <CheckCircle2 size={14} className="status-icon completed" />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {machineStatus.completed.length === 0 && !hasProcessing && (
                                <div className="no-activity">No recent activity</div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
