# Legacy tablet UI (port 5175)

Minimal **Production** and **Stock** pages for older tablets and browsers that cannot run the React app on port 5173.

No bundler in the browser — plain HTML, CSS, and ES5-friendly JavaScript with `XMLHttpRequest`.

## Run

`npm run dev` starts everything in one terminal:

| Service | Port | Script |
|---------|------|--------|
| API | 3001 | `dev:server` |
| Main React app | 5173 | `dev:client` |
| Legacy tablet (Production / Stock) | 5175 | `dev:tablet-legacy` |
| Operation scanner | 5174 | `dev:legacy` |

All UIs proxy `/api` → Express on `:3001`.

**Run individually:**

```bash
npm run dev:server          # API only
npm run dev:tablet-legacy   # Tablet UI only (:5175, needs API)
npm run dev:legacy          # Operation scanner only (:5174, needs API)
npm run dev:tablet          # API + tablet UI (no main app)
```

## Tablet bookmark

Replace the host with your dev machine’s LAN IP:

- Production: `http://10.1.1.64:5175/#/production`
- Stock: `http://10.1.1.64:5175/#/stock`

Default API base is `/api` (Vite on 5175 proxies to Express on 3001). Use the **API** button in the header to reset to `/api` if needed.

## Features

### Production

- `GET /api/production-status`
- `GET /api/machines`
- 2×2 grid of the first four machines (Indigo → Digicon → Digital Cut → Slitter)
- Tap a card for processing / recent completed job lists
- Refreshes every 15 seconds

### Stock

- NL / NP company filter
- Group filter chips and search
- Material table; tap a row to edit stock quantity (`PATCH /api/stock/materials/:id`)
- USB barcode wedge → `GET /api/stock/material-by-barcode`

### Operation scanner (optional)

Navigate to `#/scan` for the legacy operation scanner (`POST /api/scan`). It is not shown in the bottom nav.

## Desktop vs tablet

| Device | URL |
|--------|-----|
| Desktop / modern browsers | `http://<host>:5173` |
| Old tablet | `http://<host>:5175` |

## Operation scanner (port 5174)

Separate minimal scanner — see [operation/README.md](operation/README.md). Uses `http://<host>:3001/api` directly (no Vite proxy).
