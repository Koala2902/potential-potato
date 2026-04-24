# Legacy Operation View

Minimal operation scanner page for older devices (example: old Mac Safari).

## Purpose

- Keep the UI very simple and lightweight.
- Reuse the existing backend API calls so scans update the same database flow as the current app.

## Run

From project root:

```bash
npm run dev:server
npm run dev:legacy
```

Then open:

- `http://10.1.1.64:5174`

## API behavior

This page calls the same endpoints used by current operation flow:

- `GET /api/machines`
- `GET /api/scheduler-modes?machineId=...`
- `GET /api/operations?machineId=...`
- `POST /api/scan` with body:
  - `scan`
  - `machineId`
  - `operations` (single resolved operation id in an array)

## Notes

- Default API base in UI is auto-filled as `http://<current-host>:3001/api`.
- You can change API Base URL in the page if your backend runs elsewhere.
