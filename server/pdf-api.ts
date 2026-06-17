import express from 'express';
import fs from 'fs';
import path from 'path';
import {
    PDF_ARCHIVE_PATH,
    logPdfArchiveStartup,
    pdfEtag,
    resolvePdfWithStats,
} from './pdf-archive.js';
import { initPdfThumbnailService, servePdfThumbnail } from './services/pdfThumbnailService.js';

export const pdfApiRouter = express.Router();

function streamPdfResponse(
    req: express.Request,
    res: express.Response,
    impositionId: string,
    pdfPath: string,
    stats: fs.Stats
): void {
    const etag = pdfEtag(stats);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('ETag', etag);

    if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
    }

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if (match) {
            const fileSize = stats.size;
            let start = match[1] ? parseInt(match[1], 10) : 0;
            let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
            if (!Number.isFinite(start) || start < 0) start = 0;
            if (!Number.isFinite(end) || end >= fileSize) end = fileSize - 1;
            if (start <= end) {
                const chunkSize = end - start + 1;
                res.status(206);
                res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
                res.setHeader('Content-Length', chunkSize.toString());
                res.setHeader('Content-Disposition', `inline; filename="${impositionId}.pdf"`);
                const stream = fs.createReadStream(pdfPath, { start, end });
                stream.on('error', (error) => {
                    console.error('Error streaming PDF range:', error);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Failed to stream PDF' });
                    }
                });
                stream.pipe(res);
                return;
            }
        }
    }

    res.setHeader('Content-Length', stats.size.toString());
    res.setHeader('Content-Disposition', `inline; filename="${impositionId}.pdf"`);
    const fileStream = fs.createReadStream(pdfPath);
    fileStream.on('error', (error) => {
        console.error('Error streaming PDF:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream PDF' });
        }
    });
    fileStream.pipe(res);
}

pdfApiRouter.head('/:impositionId', async (req, res) => {
    try {
        const { impositionId } = req.params;
        const resolved = resolvePdfWithStats(impositionId);

        if (resolved) {
            const { stats } = resolved;
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Length', stats.size.toString());
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Cache-Control', 'private, max-age=3600');
            res.setHeader('ETag', pdfEtag(stats));
            res.status(200).end();
        } else {
            res.status(404).end();
        }
    } catch (error) {
        console.error('Error checking PDF:', error);
        res.status(500).end();
    }
});

pdfApiRouter.get('/:impositionId', async (req, res) => {
    try {
        const { impositionId } = req.params;
        const resolved = resolvePdfWithStats(impositionId);

        if (!resolved) {
            console.warn('[pdf] Not found:', path.join(PDF_ARCHIVE_PATH, `${impositionId}.pdf`), '(and year subfolders)');
            return res.status(404).json({ error: 'PDF not found' });
        }

        streamPdfResponse(req, res, impositionId, resolved.path, resolved.stats);
    } catch (error) {
        console.error('Error serving PDF:', error);
        res.status(500).json({ error: 'Failed to serve PDF' });
    }
});

pdfApiRouter.get('/:impositionId/thumbnail', async (req, res) => {
    try {
        const { impositionId } = req.params;
        await servePdfThumbnail(req, res, impositionId);
    } catch (error) {
        console.error('Error serving PDF thumbnail:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to serve PDF thumbnail' });
        }
    }
});

/** Startup logging and thumbnail cache directory setup. */
export function initPdfServices(): void {
    logPdfArchiveStartup();
    initPdfThumbnailService();
}
