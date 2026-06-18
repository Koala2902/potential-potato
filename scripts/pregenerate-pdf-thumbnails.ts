import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { PDF_ARCHIVE_PATH } from '../server/pdf-archive.js';
import { getPdfThumbnailForPdfPath, initPdfThumbnailService } from '../server/services/pdfThumbnailService.js';

dotenv.config();

type ScriptOptions = {
    width: number;
    concurrency: number;
};

function parseArgs(): ScriptOptions {
    const args = process.argv.slice(2);
    let width = 1200;
    let concurrency = 4;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--width' && args[i + 1]) {
            width = Math.max(400, Math.min(1600, Number(args[++i]) || 1200));
        } else if (a === '--concurrency' && args[i + 1]) {
            concurrency = Math.max(1, Math.min(16, Number(args[++i]) || 4));
        }
    }

    return { width, concurrency };
}

async function listArchivePdfPaths(root: string): Promise<string[]> {
    const pdfPaths: string[] = [];
    const stack: string[] = [root];

    while (stack.length > 0) {
        const dir = stack.pop()!;
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '.thumb-cache') continue;
                stack.push(full);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!entry.name.toLowerCase().endsWith('.pdf')) continue;
            pdfPaths.push(full);
        }
    }

    return pdfPaths;
}

async function detectArchiveYearFolders(root: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (/^\d{4}$/.test(entry.name)) {
            out.push(entry.name);
        }
    }
    out.sort((a, b) => Number(b) - Number(a));
    return out;
}

function humanMs(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const remS = s % 60;
    return `${m}m ${remS}s`;
}

async function main(): Promise<void> {
    const { width, concurrency } = parseArgs();

    if (!fs.existsSync(PDF_ARCHIVE_PATH)) {
        throw new Error(`PDF archive path is missing: ${PDF_ARCHIVE_PATH}`);
    }

    const years = await detectArchiveYearFolders(PDF_ARCHIVE_PATH);
    if (years.length > 0) {
        process.env.PDF_ARCHIVE_YEAR_FOLDERS = years.join(',');
    }
    process.env.PDF_ARCHIVE_TRY_YEAR_SUBFOLDERS = 'true';

    initPdfThumbnailService();

    console.log(`[thumb-backfill] archive: ${PDF_ARCHIVE_PATH}`);
    console.log(`[thumb-backfill] years: ${process.env.PDF_ARCHIVE_YEAR_FOLDERS ?? '(default)'}`);
    console.log(`[thumb-backfill] width=${width}, concurrency=${concurrency}`);
    console.log('[thumb-backfill] scanning archive for PDFs...');

    const pdfPaths = (await listArchivePdfPaths(PDF_ARCHIVE_PATH)).sort();
    console.log(`[thumb-backfill] found ${pdfPaths.length} PDF files`);

    const startedAt = Date.now();
    let next = 0;
    let ok = 0;
    let failed = 0;

    async function worker(workerId: number): Promise<void> {
        while (true) {
            const i = next++;
            if (i >= pdfPaths.length) return;
            const pdfPath = pdfPaths[i];
            try {
                await getPdfThumbnailForPdfPath(pdfPath, width);
                ok++;
            } catch (error) {
                failed++;
                const msg = error instanceof Error ? error.message : String(error);
                console.warn(`[thumb-backfill][w${workerId}] failed ${pdfPath}: ${msg}`);
            }

            if ((ok + failed) % 25 === 0 || ok + failed === pdfPaths.length) {
                const elapsed = Date.now() - startedAt;
                console.log(
                    `[thumb-backfill] progress ${ok + failed}/${pdfPaths.length} ok=${ok} failed=${failed} elapsed=${humanMs(elapsed)}`
                );
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, (_, idx) => worker(idx + 1)));

    const elapsed = Date.now() - startedAt;
    console.log(`[thumb-backfill] done ok=${ok} failed=${failed} total=${pdfPaths.length} elapsed=${humanMs(elapsed)}`);
    if (failed > 0) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error('[thumb-backfill] fatal:', error);
    process.exit(1);
});

