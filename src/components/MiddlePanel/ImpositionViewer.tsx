import { ImpositionItem, ImpositionDetails } from '../../types';
import { FileText } from 'lucide-react';
import { useState, useEffect } from 'react';
import './ImpositionViewer.css';

interface ImpositionViewerProps {
    imposition: ImpositionItem | null;
    details: ImpositionDetails | null;
    fileIds: string[];
}

export default function ImpositionViewer({ imposition }: ImpositionViewerProps) {
    const [pdfError, setPdfError] = useState<string | null>(null);
    const [pdfLoading, setPdfLoading] = useState(true);

    // Reset PDF state when imposition changes
    useEffect(() => {
        setPdfError(null);
        setPdfLoading(true);
    }, [imposition?.imposition_id]);

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

    // Use relative URL to avoid CORS issues
    // Add #view=FitV to fit the PDF to the viewport height
    const pdfUrl = `/api/pdf/${imposition.imposition_id}#view=FitV`;

    const handleIframeLoad = () => {
        setPdfLoading(false);
    };

    const handleIframeError = () => {
        setPdfError('Failed to load PDF');
        setPdfLoading(false);
    };

    return (
        <div className="imposition-viewer">
            {/* Left side - PDF Preview */}
            <div className="pdf-preview-section">
                <div className="pdf-header">
                    <div className="pdf-title">
                        <FileText size={20} />
                        <span>{imposition.simplified_name}</span>
                    </div>
                </div>
                <div className="pdf-preview-container">
                    {pdfError ? (
                        <div className="pdf-placeholder">
                            <div className="pdf-placeholder-content">
                                <FileText size={48} strokeWidth={1.5} />
                                <div className="pdf-filename">{imposition.imposition_id}</div>
                                <div className="pdf-note" style={{ color: 'var(--status-error)' }}>
                                    {pdfError}
                                </div>
                                <div className="pdf-note-sub">PDF file may not exist in archive</div>
                            </div>
                        </div>
                    ) : (
                        <div style={{ 
                            width: '100%', 
                            height: '100%', 
                            position: 'relative',
                            background: 'var(--bg-secondary)'
                        }}>
                            {pdfLoading && (
                                <div className="pdf-placeholder-content" style={{ 
                                    position: 'absolute', 
                                    top: '50%', 
                                    left: '50%', 
                                    transform: 'translate(-50%, -50%)',
                                    zIndex: 1
                                }}>
                                    <FileText size={48} strokeWidth={1.5} />
                                    <div className="pdf-note">Loading PDF...</div>
                                </div>
                            )}
                            <iframe
                                key={imposition.imposition_id}
                                src={pdfUrl}
                                onLoad={handleIframeLoad}
                                onError={handleIframeError}
                                style={{
                                    width: '100%',
                                    height: '100%',
                                    border: 'none',
                                    background: '#525659'
                                }}
                                title={`PDF Preview - ${imposition.imposition_id}`}
                            />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

