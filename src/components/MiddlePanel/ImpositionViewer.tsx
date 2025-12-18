import { ImpositionItem, ImpositionDetails } from '../../types';
import { FileText, Hash, Package } from 'lucide-react';
import './ImpositionViewer.css';

interface ImpositionViewerProps {
    imposition: ImpositionItem | null;
    details: ImpositionDetails | null;
    fileId: string | null;
}

export default function ImpositionViewer({ imposition, details, fileId }: ImpositionViewerProps) {
    if (!imposition) {
        return (
            <div className="imposition-viewer">
                <div className="empty-state">
                    <div className="empty-icon">
                        <FileText size={64} />
                    </div>
                    <h3>No Imposition Selected</h3>
                    <p>Select an imposition from the queue or scan a barcode</p>
                </div>
            </div>
        );
    }

    return (
        <div className="imposition-viewer">
            {/* Top 2/3 - PDF Preview */}
            <div className="pdf-preview-section">
                <div className="pdf-header">
                    <div className="pdf-title">
                        <FileText size={20} />
                        <span>{imposition.simplified_name}</span>
                    </div>
                </div>
                <div className="pdf-preview-container">
                    <div className="pdf-placeholder">
                        <div className="pdf-placeholder-content">
                            <FileText size={48} strokeWidth={1.5} />
                            <div className="pdf-filename">{imposition.imposition_id}</div>
                            <div className="pdf-note">PDF Preview</div>
                            <div className="pdf-note-sub">(PDF preview will be implemented later)</div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Bottom 1/3 - Details */}
            <div className="imposition-details-section">
                <h3 className="section-title">Imposition Details</h3>
                <div className="details-grid">
                    <div className="detail-card">
                        <div className="detail-icon">
                            <Hash size={18} />
                        </div>
                        <div className="detail-content">
                            <div className="detail-label">Imposition ID</div>
                            <div className="detail-value-large">{imposition.imposition_id}</div>
                        </div>
                    </div>

                    {fileId && (
                        <div className="detail-card">
                            <div className="detail-icon">
                                <Package size={18} />
                            </div>
                            <div className="detail-content">
                                <div className="detail-label">File ID</div>
                                <div className="detail-value-large">{fileId}</div>
                            </div>
                        </div>
                    )}

                    {details && Object.entries(details).map(([key, value]) => {
                        if (key === 'imposition_id' || key === 'file_id') return null;
                        if (value === null || value === undefined) return null;
                        
                        return (
                            <div key={key} className="detail-card">
                                <div className="detail-icon">
                                    <Hash size={18} />
                                </div>
                                <div className="detail-content">
                                    <div className="detail-label">{key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</div>
                                    <div className="detail-value">{String(value)}</div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

