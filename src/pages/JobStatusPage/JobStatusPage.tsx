import { Activity, CheckCircle2, Clock, AlertCircle } from 'lucide-react';
import './JobStatusPage.css';

export default function JobStatusPage() {
    return (
        <div className="job-status-page">
            <div className="job-status-header">
                <div className="job-status-title">
                    <Activity size={24} />
                    <h2>Job Status</h2>
                </div>
            </div>

            <div className="job-status-content">
                <div className="job-status-placeholder">
                    <Activity size={64} strokeWidth={1.5} />
                    <h3>Job Status</h3>
                    <p>Job status tracking will be implemented here</p>
                </div>
            </div>
        </div>
    );
}

