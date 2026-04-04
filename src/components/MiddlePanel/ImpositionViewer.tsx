import { ImpositionItem, ImpositionDetails } from '../../types';
import { FileText } from 'lucide-react';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Document, Page } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './ImpositionViewer.css';

interface ImpositionViewerProps {
    imposition: ImpositionItem | null;
    details: ImpositionDetails | null;
    fileIds: string[];
}

/** Extra pixels for canvas (render larger than view, then scale down for sharpness). */
const RESOLUTION_BOOST = 1.85;

export default function ImpositionViewer({ imposition }: ImpositionViewerProps) {
    const [pdfError, setPdfError] = useState<string | null>(null);
    const [archiveOk, setArchiveOk] = useState<boolean | null>(null);
    const [pdfLoading, setPdfLoading] = useState(true);
    const [fitScale, setFitScale] = useState(1);

    const shellRef = useRef<HTMLDivElement>(null);
    const innerRotatedRef = useRef<HTMLDivElement>(null);

    const [shellSize, setShellSize] = useState({ w: 400, h: 500 });

    useEffect(() => {
        setPdfError(null);
        setArchiveOk(null);
        setPdfLoading(true);
        setFitScale(1);

        if (!imposition?.imposition_id) {
            return;
        }

        fetch(`/api/pdf/${imposition.imposition_id}`, { method: 'HEAD' })
            .then((response) => {
                if (!response.ok) {
                    if (response.status === 404) {
                        setPdfError('PDF not found in archive');
                    } else {
                        setPdfError(`Failed to load PDF (${response.status})`);
                    }
                    setPdfLoading(false);
                    return;
                }
                setArchiveOk(true);
            })
            .catch((err) => {
                console.error('Error checking PDF:', err);
                setPdfError('Could not reach PDF archive');
                setPdfLoading(false);
            });
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
    }, [archiveOk]);

    const pageWidth = useMemo(() => {
        const pad = 12;
        const m = Math.max(Math.min(shellSize.w, shellSize.h) - pad * 2, 100);
        const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1.5;
        return Math.round(m * RESOLUTION_BOOST * dpr);
    }, [shellSize]);

    /** r = unscaledRotated * prevScale; target scale = min(shell/r) * prevScale * 0.98 */
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
    }, [shellSize, pageWidth, updateFitScale]);

    useEffect(() => {
        window.addEventListener('resize', updateFitScale);
        return () => window.removeEventListener('resize', updateFitScale);
    }, [updateFitScale]);

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

    const pdfUrl = `/api/pdf/${imposition.imposition_id}`;

    const onDocumentLoad = () => {
        setPdfLoading(false);
        setPdfError(null);
    };

    const onDocumentError = () => {
        setPdfError('Failed to render PDF preview');
        setPdfLoading(false);
    };

    const onPageRenderSuccess = () => {
        requestAnimationFrame(() => updateFitScale());
    };

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
                                <div className="pdf-note-sub">PDF file may not exist in archive</div>
                            </div>
                        </div>
                    ) : archiveOk === null ? (
                        <div className="pdf-thumbnail-shell">
                            <div className="pdf-thumbnail-loading" style={{ pointerEvents: 'auto' }}>
                                <FileText size={48} strokeWidth={1.5} />
                                <div className="pdf-note">Checking archive…</div>
                            </div>
                        </div>
                    ) : archiveOk === true ? (
                        <div ref={shellRef} className="pdf-thumbnail-shell">
                            {pdfLoading && (
                                <div className="pdf-thumbnail-loading">
                                    <FileText size={48} strokeWidth={1.5} />
                                    <div className="pdf-note">Loading preview…</div>
                                </div>
                            )}
                            <Document
                                key={imposition.imposition_id}
                                file={pdfUrl}
                                onLoadSuccess={onDocumentLoad}
                                onLoadError={onDocumentError}
                                loading={null}
                                className="pdf-thumbnail-document"
                            >
                                <div
                                    className="pdf-thumbnail-scale-wrap"
                                    style={{
                                        transform: `scale(${fitScale})`,
                                        transformOrigin: 'center center',
                                    }}
                                >
                                    <div
                                        ref={innerRotatedRef}
                                        className="pdf-thumbnail-rotated"
                                        style={{ transform: 'rotate(90deg)', transformOrigin: 'center center' }}
                                    >
                                        <Page
                                            pageNumber={1}
                                            width={pageWidth}
                                            renderTextLayer={false}
                                            renderAnnotationLayer={false}
                                            className="pdf-thumbnail-page"
                                            onRenderSuccess={onPageRenderSuccess}
                                        />
                                    </div>
                                </div>
                            </Document>
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
