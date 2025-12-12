import { Job } from '../../types';
import { FileText, Package, Hash, Calendar } from 'lucide-react';
import './PdfViewer.css';

interface PdfViewerProps {
    job: Job | null;
}

export default function PdfViewer({ job }: PdfViewerProps) {
    if (!job) {
        return (
            <div className="pdf-viewer">
                <div className="empty-state">
                    <div className="empty-icon">
                        <FileText size={64} />
                    </div>
                    <h3>No Job Selected</h3>
                    <p>Select a job from the list or scan a barcode to view details</p>
                </div>
            </div>
        );
    }

    return (
        <div className="pdf-viewer">
            <div className="pdf-header">
                <div className="pdf-title">
                    <FileText size={20} />
                    <span>{job.jobCode}</span>
                </div>
                <span className={`badge badge-${job.status}`}>{job.status}</span>
            </div>

            <div className="pdf-preview-container">
                <div className="pdf-placeholder">
                    <div className="pdf-placeholder-content">
                        <FileText size={48} strokeWidth={1.5} />
                        <div className="pdf-filename">{job.pdfPath.split('/').pop()}</div>
                        <div className="pdf-note">PDF Preview</div>
                        <div className="pdf-note-sub">Connected to: {job.pdfPath}</div>
                    </div>
                </div>
            </div>

            <div className="job-details-section">
                <h3 className="section-title">Job Details</h3>
                <div className="details-grid">
                    <div className="detail-card">
                        <div className="detail-icon">
                            <Package size={18} />
                        </div>
                        <div className="detail-content">
                            <div className="detail-label">Order ID</div>
                            <div className="detail-value-large">{job.orderId}</div>
                        </div>
                    </div>

                    <div className="detail-card">
                        <div className="detail-icon">
                            <Hash size={18} />
                        </div>
                        <div className="detail-content">
                            <div className="detail-label">Ticket ID</div>
                            <div className="detail-value-large">{job.ticketId}</div>
                        </div>
                    </div>

                    <div className="detail-card">
                        <div className="detail-icon">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 2v20M2 12h20" />
                                <circle cx="12" cy="12" r="9" />
                            </svg>
                        </div>
                        <div className="detail-content">
                            <div className="detail-label">Version Tag</div>
                            <div className="detail-value-large">{job.versionTag}</div>
                        </div>
                    </div>

                    <div className="detail-card">
                        <div className="detail-icon">
                            <Calendar size={18} />
                        </div>
                        <div className="detail-content">
                            <div className="detail-label">Version Qty</div>
                            <div className="detail-value-large">{job.versionQty.toLocaleString()}</div>
                        </div>
                    </div>
                </div>

                {job.startedAt && (
                    <div className="timing-info">
                        <div className="timing-item">
                            <span className="timing-label">Started:</span>
                            <span className="timing-value">
                                {new Date(job.startedAt).toLocaleTimeString('en-US', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                })}
                            </span>
                        </div>
                        {job.completedAt && (
                            <div className="timing-item">
                                <span className="timing-label">Completed:</span>
                                <span className="timing-value">
                                    {new Date(job.completedAt).toLocaleTimeString('en-US', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                    })}
                                </span>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
