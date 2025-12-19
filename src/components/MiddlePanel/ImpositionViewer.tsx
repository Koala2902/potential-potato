import { ImpositionItem, ImpositionDetails } from '../../types';
import { FileText, Hash, Package } from 'lucide-react';
import './ImpositionViewer.css';

interface ImpositionViewerProps {
    imposition: ImpositionItem | null;
    details: ImpositionDetails | null;
    fileIds: string[];
}

export default function ImpositionViewer({ imposition, details, fileIds }: ImpositionViewerProps) {
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
                    {fileIds.length > 0 && (
                        <div className="detail-card" style={{ gridColumn: '1 / -1' }}>
                            <div className="detail-icon">
                                <Package size={18} />
                            </div>
                            <div className="detail-content" style={{ width: '100%' }}>
                                <div className="detail-label">File IDs ({fileIds.length})</div>
                                <div style={{ 
                                    display: 'flex', 
                                    flexDirection: 'column', 
                                    gap: 'var(--spacing-xs)',
                                    marginTop: 'var(--spacing-xs)'
                                }}>
                                    {fileIds.map((fileId, index) => {
                                        // Simplify file_id: extract FILE_version_tag_job_id
                                        // Format options:
                                        // 1. FILE_version_Labex_job_id_part1_job_id_part2_...rest
                                        // 2. FILE_version_job_id_part1_job_id_part2_...rest
                                        // We want: FILE_version_job_id_part1_job_id_part2
                                        // Stop before the descriptive text starts (usually after job_id numbers)
                                        const simplifiedFileId = (() => {
                                            // Use regex to extract exactly FILE_version_job_id_part1_job_id_part2
                                            // Pattern: FILE_X_Y_Z_... where X is version, Y and Z are job_id numbers
                                            // We want to stop right after the second job_id number
                                            
                                            // Try pattern: FILE_version_job_id1_job_id2 (stop before next part)
                                            let match = fileId.match(/^(FILE_\d+_\d+_\d+)(?:_|$)/);
                                            if (match) {
                                                // match[1] = FILE_X_Y_Z (exactly what we want)
                                                return match[1];
                                            }
                                            
                                            // Try pattern with Labex: FILE_X_Labex_Y_Z
                                            match = fileId.match(/^(FILE_\d+)_Labex_(\d+_\d+)(?:_|$)/);
                                            if (match) {
                                                return `${match[1]}_${match[2]}`;
                                            }
                                            
                                            // Fallback: split and take first 4 parts if they match pattern
                                            const parts = fileId.split('_');
                                            if (parts.length >= 4 && parts[0] === 'FILE' && 
                                                /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2]) && /^\d+$/.test(parts[3])) {
                                                return `${parts[0]}_${parts[1]}_${parts[2]}_${parts[3]}`;
                                            }
                                            
                                            return fileId;
                                        })();
                                        
                                        return (
                                            <div 
                                                key={index} 
                                                className="detail-value" 
                                                style={{
                                                    padding: 'var(--spacing-xs) var(--spacing-sm)',
                                                    background: 'var(--bg-tertiary)',
                                                    borderRadius: 'var(--radius-sm)',
                                                    fontSize: '0.8rem',
                                                    wordBreak: 'break-all'
                                                }}
                                            >
                                                {simplifiedFileId}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}

                    {details && Object.entries(details).map(([key, value]) => {
                        // Skip these fields
                        const skipFields = [
                            'imposition_id', 
                            'file_id', 
                            'file_ids',
                            'runlist_id',
                            'production_path',
                            'material',
                            'finishing',
                            'product_id',
                            'pages',
                            'steps_count',
                            'layout_around',
                            'imposed_file_path',
                            'imposition_created_at',
                            'created_at'
                        ];
                        
                        if (skipFields.includes(key)) return null;
                        if (value === null || value === undefined) return null;
                        
                        // Special handling for explanation field
                        if (key === 'explanation') {
                            return (
                                <div key={key} className="detail-card" style={{ gridColumn: '1 / -1' }}>
                                    <div className="detail-icon">
                                        <FileText size={18} />
                                    </div>
                                    <div className="detail-content" style={{ width: '100%' }}>
                                        <div className="detail-label">Explanation</div>
                                        <div className="detail-value" style={{ 
                                            marginTop: 'var(--spacing-xs)',
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word'
                                        }}>
                                            {String(value)}
                                        </div>
                                    </div>
                                </div>
                            );
                        }
                        
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

