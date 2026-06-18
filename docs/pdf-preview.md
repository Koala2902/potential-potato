# PDF preview (Ticket page)

The Ticket middle panel shows a rotated thumbnail of imposition PDF page 1. Previews are generated on the server and cached — the browser no longer downloads or parses full PDFs.

## Architecture

```
ImpositionViewer  →  GET /api/pdf/:id/thumbnail?w=1200  →  disk cache (WebP)
                              ↓ (cache miss)
                         pdftoppm -scale-to 1200  →  master PNG  →  sharp (WebP)
                              ↓
                         SMB archive: PDF_ARCHIVE_PATH / {year} / {imposition_id}.pdf
```

| Endpoint | Purpose |
|----------|---------|
| `HEAD /api/pdf/:impositionId` | Check PDF exists |
| `GET /api/pdf/:impositionId` | Stream full PDF (byte-range + ETag supported) |
| `GET /api/pdf/:impositionId/thumbnail?w=1200` | Cached WebP thumbnail of page 1 |

## Server dependencies

**poppler-utils** (`pdftoppm` on PATH) is required for thumbnails.

- macOS: `brew install poppler`
- Debian/Ubuntu: `apt install poppler-utils`

**sharp** is installed via npm for WebP encoding.

## Configuration

See `.env.example`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PDF_ARCHIVE_PATH` | `/Volumes/Daily Print Jobs/_NEXT HotFolder/RDevArchive` | Mounted folder for `{imposition_id}.pdf` files |
| `PDF_ARCHIVE_YEAR_FOLDERS` | current year + two prior | Year subfolders to search under the archive |
| `PDF_ARCHIVE_TRY_YEAR_SUBFOLDERS` | `true` | Set `false` to only check the flat archive path |
| `PDF_THUMBNAIL_CACHE_DIR` | `<PDF_ARCHIVE_PATH>/.thumb-cache` | Disk cache for master PNG + WebP files |

Use a POSIX path after mounting the SMB share (`smb://` URLs do not work with Node `fs`).  
If the configured thumbnail cache path is unavailable, thumbnail requests fail with `503` (no local fallback).

## Caching

- **Path resolution** — in-memory TTL cache (~5 min) in `server/pdf-archive.ts` to avoid repeated SMB `existsSync` probes.
- **Master raster** — `{id}-{mtime}-{size}-v2-master-s1200.png` from `pdftoppm -scale-to 1200` (longest side, aspect-preserving).
- **WebP** — `{id}-{mtime}-{size}-v2-w{width}.webp` derived from the master PNG.

Cache keys include PDF `mtime` and file size so regenerated archive files are picked up automatically. Bump `CACHE_VERSION` in `pdfThumbnailService.ts` when raster logic changes.

Thumbnails are warmed in the background after a successful barcode scan resolves an imposition.

## Client behaviour

`ImpositionViewer` requests a stable `w=1200` thumbnail and uses CSS `rotate(90deg)` + uniform `fitScale` to fit the panel — matching the previous react-pdf viewer. The next queue item’s thumbnail is prefetched via `<link rel="prefetch">`.

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| “Preview renderer unavailable” | `pdftoppm` not on PATH — install poppler-utils and restart the API server |
| “PDF not found in archive” | File missing under `PDF_ARCHIVE_PATH` (flat or year subfolder) |
| Stretched / wrong aspect ratio | Stale cache from an older rasterizer; delete thumbnail cache files under `<PDF_ARCHIVE_PATH>/.thumb-cache` (or your override) or bump `CACHE_VERSION` |
| “PDF thumbnail cache unavailable” | Cache path not mounted/writable; verify `PDF_THUMBNAIL_CACHE_DIR` (or archive mount) exists and is writable |
| Slow first load (~0.5s) | Normal on cache miss (SMB read + rasterize); repeat views should be &lt;50ms |
