import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { Request, Response } from 'express';
import sharp from 'sharp';
import { resolvePdfWithStats } from '../pdf-archive.js';

const execFileAsync = promisify(execFile);

const DEFAULT_WIDTH = 1200;
const MIN_WIDTH = 400;
const MAX_WIDTH = 1600;
/** Longest side when rasterizing; preserves aspect ratio (unlike -scale-to-x). */
const MASTER_RASTER_MAX_SIDE = 1200;

let pdftoppmAvailable: boolean | null = null;

export class PdfThumbnailNotFoundError extends Error {
    constructor(impositionId: string) {
        super(`PDF not found for imposition ${impositionId}`);
        this.name = 'PdfThumbnailNotFoundError';
    }
}

export class PdfThumbnailRendererUnavailableError extends Error {
    constructor() {
        super('pdftoppm is not available on PATH');
        this.name = 'PdfThumbnailRendererUnavailableError';
    }
}

function thumbnailCacheDir(): string {
    return (
        process.env.PDF_THUMBNAIL_CACHE_DIR?.trim() ||
        path.resolve(process.cwd(), '.cache/pdf-thumbnails')
    );
}

function clampWidth(raw: unknown): number {
    const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)));
}

function safeImpositionId(impositionId: string): string {
    return impositionId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Bump when raster/encode logic changes (invalidates stale cache entries). */
const CACHE_VERSION = 'v2';

function cachePathFor(
    impositionId: string,
    stats: fs.Stats,
    width: number
): string {
    const fileName = `${safeImpositionId(impositionId)}-${stats.mtimeMs}-${stats.size}-${CACHE_VERSION}-w${width}.webp`;
    return path.join(thumbnailCacheDir(), fileName);
}

function masterRasterPathFor(impositionId: string, stats: fs.Stats): string {
    const fileName = `${safeImpositionId(impositionId)}-${stats.mtimeMs}-${stats.size}-${CACHE_VERSION}-master-s${MASTER_RASTER_MAX_SIDE}.png`;
    return path.join(thumbnailCacheDir(), fileName);
}

async function checkPdftoppm(): Promise<boolean> {
    try {
        await execFileAsync('pdftoppm', ['-v']);
        return true;
    } catch {
        return false;
    }
}

export function initPdfThumbnailService(): void {
    const dir = thumbnailCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    void checkPdftoppm().then((ok) => {
        pdftoppmAvailable = ok;
        if (!ok) {
            console.warn(
                '[pdf-thumbnail] pdftoppm not found on PATH. Install poppler-utils (e.g. brew install poppler). Thumbnail route will return 503.'
            );
        } else {
            console.log(`[pdf-thumbnail] cache: ${dir}`);
        }
    });
}

async function renderPage1Png(pdfPath: string, maxSide: number): Promise<Buffer> {
    if (pdftoppmAvailable !== true) {
        pdftoppmAvailable = await checkPdftoppm();
        if (!pdftoppmAvailable) {
            throw new PdfThumbnailRendererUnavailableError();
        }
    }

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pdf-thumb-'));
    const outPrefix = path.join(tmpDir, 'page');
    try {
        // -scale-to fits longest side in maxSide px (aspect-preserving). Do not use -scale-to-x.
        await execFileAsync('pdftoppm', [
            '-f',
            '1',
            '-l',
            '1',
            '-png',
            '-singlefile',
            '-scale-to',
            String(maxSide),
            pdfPath,
            outPrefix,
        ]);
        const pngPath = `${outPrefix}.png`;
        return await fs.promises.readFile(pngPath);
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function getOrRenderMasterRaster(
    impositionId: string,
    pdfPath: string,
    stats: fs.Stats
): Promise<Buffer> {
    const rasterPath = masterRasterPathFor(impositionId, stats);
    if (fs.existsSync(rasterPath)) {
        return fs.promises.readFile(rasterPath);
    }

    const png = await renderPage1Png(pdfPath, MASTER_RASTER_MAX_SIDE);
    fs.mkdirSync(thumbnailCacheDir(), { recursive: true });
    await fs.promises.writeFile(rasterPath, png);
    return png;
}

export async function getPdfThumbnail(
    impositionId: string,
    width: number
): Promise<Buffer> {
    const resolved = resolvePdfWithStats(impositionId);
    if (!resolved) {
        throw new PdfThumbnailNotFoundError(impositionId);
    }

    const { path: pdfPath, stats } = resolved;
    const cachePath = cachePathFor(impositionId, stats, width);
    if (fs.existsSync(cachePath)) {
        return fs.promises.readFile(cachePath);
    }

    const png = await getOrRenderMasterRaster(impositionId, pdfPath, stats);
    const meta = await sharp(png).metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    const pipeline =
        width >= longest
            ? sharp(png)
            : sharp(png).resize(width, null, { fit: 'inside' });

    const webp = await pipeline.webp({ quality: 85, effort: 4 }).toBuffer();

    fs.mkdirSync(thumbnailCacheDir(), { recursive: true });
    await fs.promises.writeFile(cachePath, webp);
    return webp;
}

export async function servePdfThumbnail(
    req: Request,
    res: Response,
    impositionId: string
): Promise<void> {
    const width = clampWidth(req.query.w);
    try {
        const resolved = resolvePdfWithStats(impositionId);
        if (!resolved) {
            res.status(404).json({ error: 'PDF not found' });
            return;
        }

        const cachePath = cachePathFor(impositionId, resolved.stats, width);
        if (fs.existsSync(cachePath)) {
            res.setHeader('Content-Type', 'image/webp');
            res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
            res.sendFile(cachePath);
            return;
        }

        const webp = await getPdfThumbnail(impositionId, width);
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        res.send(webp);
    } catch (error) {
        if (error instanceof PdfThumbnailNotFoundError) {
            res.status(404).json({ error: 'PDF not found' });
            return;
        }
        if (error instanceof PdfThumbnailRendererUnavailableError) {
            res.status(503).json({ error: 'PDF thumbnail renderer unavailable' });
            return;
        }
        throw error;
    }
}

/** Fire-and-forget thumbnail generation after a successful scan. */
export function warmPdfThumbnail(impositionId: string, width = DEFAULT_WIDTH): void {
    void getPdfThumbnail(impositionId, width).catch((err) => {
        if (err instanceof PdfThumbnailNotFoundError) return;
        console.warn(`[pdf-thumbnail] warm failed for ${impositionId}:`, err);
    });
}
