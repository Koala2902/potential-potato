# Production Suite

A sophisticated job tracking system for print production workflows with USB scanner integration and real-time status monitoring.

## Features

✨ **Three-Panel Interface**
- **Left Panel**: Production queue with job status tracking
- **Middle Panel**: PDF preview and job details
- **Right Panel**: Production information, due dates, and timeline

🎨 **Modern Design**
- Premium dark theme with glassmorphism effects
- Purple-indigo gradient accents
- Smooth animations and micro-interactions
- Responsive three-column grid layout

📊 **Job Tracking**
- Pending → Started → Completed workflow
- Smart scan timing (1-minute window logic)
- Visual status indicators with color coding
- Due date urgency highlighting

🔧 **Technology Stack**
- **Frontend**: React 18 + TypeScript + Vite
- **Styling**: Vanilla CSS with custom design system
- **Icons**: Lucide React
- **PDF Handling**: Server-generated WebP thumbnails (Poppler + Sharp)

## Getting Started

### Prerequisites
- Node.js 20.19+ or 22.12+ (currently working with 20.12.2)
- npm or yarn
- **poppler-utils** (`pdftoppm`) for Ticket PDF thumbnails — macOS: `brew install poppler`, Debian/Ubuntu: `apt install poppler-utils`

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/production-suite.git
cd production-suite

# Install dependencies
npm install

# Start development server
npm run dev
```

The application will be available at `http://localhost:5173`

### Old tablets (legacy UI on port 5175)

The main app uses React 19 and modern JavaScript, which may not run on very old tablets. Use the lightweight legacy UI instead. It shares the **same Express API on port 3001** as `npm run dev` (tablet Vite on 5175 proxies `/api` there).

```bash
npm run dev          # terminal 1 — API + main UI
npm run dev:tablet   # terminal 2 — tablet UI only
```

Bookmark on the tablet (replace with your machine’s LAN IP):

- `http://10.1.1.64:5175/#/production`
- `http://10.1.1.64:5175/#/stock`

See [legacy/README.md](legacy/README.md) for details.

### Phone access and camera (HTTPS via Cloudflare)

Mobile browsers only allow the camera on **HTTPS** (or `localhost`). To open the app from a phone when the dev machine is on your LAN (e.g. `10.1.1.64`), use **Cloudflare Tunnel** so you get a temporary `https://…` URL that proxies to Vite on your machine.

1. **Install `cloudflared`** (pick one):
   - macOS: `brew install cloudflare/cloudflare/cloudflared`
   - Other platforms: [Cloudflare downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
2. **Start the app** (Vite + API, default Vite port **5173**):
   - `npm run dev`
3. **In a second terminal**, start the tunnel:
   - `npm run tunnel`
4. In the tunnel output, copy the URL that looks like **`https://….trycloudflare.com`** and open it on your phone.
5. In the browser, allow **Camera** for that site when prompted.

**One command** (starts dev + tunnel; tunnel waits a few seconds for Vite to listen):

```bash
npm run dev:phone
```

If Vite is not on port 5173, run `cloudflared tunnel --url http://127.0.0.1:<your-port>` manually instead of `npm run tunnel`.

## Usage

### Scanner Simulation
Currently using keyboard simulation for development:
1. Select a job from the left panel
2. Press **Enter** to simulate scanning
3. First scan → Marks job as "Started" 
4. Second scan (after 60+ seconds) → Marks as "Completed"

### Job Status Flow
- **Pending** (Gray): Job created, not started
- **Started** (Orange): First scan recorded, work in progress
- **Completed** (Green): Second scan recorded, job finished

## Project Structure

```
production-suite/
├── src/
│   ├── components/
│   │   ├── LeftPanel/          # File list component
│   │   ├── MiddlePanel/        # PDF viewer & details
│   │   └── RightPanel/         # Production information
│   ├── data/
│   │   └── mockData.ts         # Sample job data
│   ├── types/
│   │   └── index.ts            # TypeScript interfaces
│   ├── App.tsx                 # Main application
│   ├── App.css                 # Layout styling
│   └── index.css               # Design system
├── index.html
├── package.json
└── tsconfig.json
```

## Roadmap

### Phase 1: Frontend ✅ (Current)
- [x] Three-panel layout
- [x] Mock data with job status
- [x] Scanner simulation
- [x] Premium UI/UX design

### Phase 2: Backend (Upcoming)
- [ ] Node.js/Express API server
- [ ] PostgreSQL database integration
- [ ] WebSocket for real-time updates
- [ ] USB scanner integration (HID)
- [ ] PDF file serving from local storage

### Phase 3: Production Features
- [ ] Multi-user support
- [ ] Roll management
- [ ] Production analytics
- [ ] Export/reporting capabilities

## Configuration (Future)

Environment variables will be configured via `.env`:

```env
# Database (same as .env.example: DB_* or DATABASE_URL — default DB name productioncapacity)
DATABASE_URL=postgresql://user:password@host:5432/productioncapacity

# PDF Storage
PDF_FOLDER_PATH=/path/to/pdfs

# Server
PORT=3000
```

## Contributing

This is a production tool currently in active development. Features and APIs may change.

## License

MIT

## Screenshots

### Main Interface
Three-panel layout with job list, PDF preview, and production details.

### Status Tracking
Real-time job status updates with color-coded indicators.

---

**Built with ❤️ for production efficiency**
