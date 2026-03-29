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
        
        // Check if PDF exists before trying to load it
        if (imposition?.imposition_id) {
            fetch(`/api/pdf/${imposition.imposition_id}`, { method: 'HEAD' })
                .then(response => {
                    if (!response.ok) {
                        if (response.status === 404) {
                            setPdfError('PDF not found in archive');
                        } else {
                            setPdfError(`Failed to load PDF (${response.status})`);
                        }
                        setPdfLoading(false);
                    }
                    // If OK, let the iframe handle loading
                })
                .catch(err => {
                    console.error('Error checking PDF:', err);
                    // Don't set error here - let the iframe try to load and handle errors
                });
        }
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
        // Check if the iframe content actually loaded successfully
        // Note: iframe onLoad fires even for error pages, so we need to check the content
        const iframe = document.querySelector(`iframe[title="PDF Preview - ${imposition.imposition_id}"]`) as HTMLIFrameElement;
        if (iframe) {
            try {
                // Try to access iframe content to check if it's an error page
                // This might fail due to CORS, but that's okay - we'll rely on timeout
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (iframeDoc) {
                    const bodyText = iframeDoc.body?.textContent || '';
                    if (bodyText.includes('PDF not found') || bodyText.includes('error')) {
                        setPdfError('PDF not found');
                        setPdfLoading(false);
                        return;
                    }
                }
            } catch (e) {
                // CORS error - can't check content, assume it loaded fine
                // The timeout will catch actual errors
            }
        }
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

