import { ImpositionItem, ImpositionDetails } from '../../types';
import { FileText } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import './ImpositionViewer.css';

interface ImpositionViewerProps {
    imposition: ImpositionItem | null;
    details: ImpositionDetails | null;
    fileIds: string[];
    /** Next imposition in queue — thumbnail URL is prefetched when set. */
    prefetchImpositionId?: string | null;
}

/** Stable request width — CSS fitScale handles panel sizing; avoids refetch on resize. */
const THUMB_REQUEST_WIDTH = 1200;

export default function ImpositionViewer({
    imposition,
    prefetchImpositionId,
}: ImpositionViewerProps) {
    const [pdfError, setPdfError] = useState<string | null>(null);
    const [pdfLoading, setPdfLoading] = useState(true);
    const [fitScale, setFitScale] = useState(1);

    const shellRef = useRef<HTMLDivElement>(null);
    const innerRotatedRef = useRef<HTMLDivElement>(null);

    const [shellSize, setShellSize] = useState({ w: 400, h: 500 });

    const thumbUrl = imposition
        ? `/api/pdf/${imposition.imposition_id}/thumbnail?w=${THUMB_REQUEST_WIDTH}`
        : null;

    useEffect(() => {
        setPdfError(null);
        setPdfLoading(true);
        setFitScale(1);
    }, [imposition?.imposition_id]);

    useEffect(() => {
        const el = shellRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            const cr = entries[0]?.contentRect;
            if (!cr) return;
            setShellSize({ w: cr.width, h: cr.height });
        });
        ro.observe(el);
        setShellSize({ w: el.clientWidth, h: el.clientHeight });
        return () => ro.disconnect();
    }, [imposition?.imposition_id]);

    useEffect(() => {
        if (!prefetchImpositionId) return;
        const href = `/api/pdf/${prefetchImpositionId}/thumbnail?w=${THUMB_REQUEST_WIDTH}`;
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.as = 'image';
        link.href = href;
        document.head.appendChild(link);
        return () => {
            if (link.isConnected) {
                document.head.removeChild(link);
            }
        };
    }, [prefetchImpositionId]);

    const updateFitScale = useCallback(() => {
        setFitScale((prev) => {
            const shell = shellRef.current;
            const inner = innerRotatedRef.current;
            if (!shell || !inner) return prev;
            const s = shell.getBoundingClientRect();
            const r = inner.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) return prev;
            const next = Math.min((s.width * prev) / r.width, (s.height * prev) / r.height) * 0.98;
            return Number.isFinite(next) ? Math.min(next, 1) : prev;
        });
    }, []);

    useEffect(() => {
        const id = requestAnimationFrame(() => updateFitScale());
        return () => cancelAnimationFrame(id);
    }, [shellSize, updateFitScale]);

    useEffect(() => {
        window.addEventListener('resize', updateFitScale);
        return () => window.removeEventListener('resize', updateFitScale);
    }, [updateFitScale]);

    const onImageLoad = () => {
        setPdfLoading(false);
        setPdfError(null);
        requestAnimationFrame(() => updateFitScale());
    };

    const onImageError = async () => {
        if (!thumbUrl) {
            setPdfError('Failed to load preview');
            setPdfLoading(false);
            return;
        }
        try {
            const res = await fetch(thumbUrl);
            if (res.status === 404) {
                setPdfError('PDF not found in archive');
            } else if (res.status === 503) {
                setPdfError('Preview renderer unavailable (install poppler-utils)');
            } else {
                setPdfError(`Failed to load preview (${res.status})`);
            }
        } catch {
            setPdfError('Could not reach preview service');
        }
        setPdfLoading(false);
    };

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
                                <div className="pdf-note-sub">
                                    {pdfError === 'PDF not found in archive'
                                        ? 'PDF file may not exist in archive'
                                        : 'Check server logs or contact support'}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div ref={shellRef} className="pdf-thumbnail-shell">
                            {pdfLoading && (
                                <div className="pdf-thumbnail-loading">
                                    <FileText size={48} strokeWidth={1.5} />
                                    <div className="pdf-note">Loading preview…</div>
                                </div>
                            )}
                            <div
                                className="pdf-thumbnail-scale-wrap"
                                style={{
                                    transform: `scale(${fitScale})`,
                                    transformOrigin: 'center center',
                                    visibility: pdfLoading ? 'hidden' : 'visible',
                                }}
                            >
                                <div
                                    ref={innerRotatedRef}
                                    className="pdf-thumbnail-rotated"
                                    style={{ transform: 'rotate(90deg)', transformOrigin: 'center center' }}
                                >
                                    {thumbUrl && (
                                        <img
                                            key={thumbUrl}
                                            src={thumbUrl}
                                            alt={imposition.simplified_name}
                                            className="pdf-thumbnail-image"
                                            onLoad={onImageLoad}
                                            onError={onImageError}
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
