# Asana Time Tracker

A self-hosted Asana App Component that adds time tracking to every task.

## Features

- **Start/Stop Timer** — click to start/stop a timer on any task
- **Manual Time Entry** — log hours and minutes with notes
- **Widget** — see total time logged directly on the task
- **Rule Actions** — auto-start/stop timers when task status changes
- **REST API** — integrate with other tools
- **Per-user tracking** — see who logged what time

## Quick Setup

### 1. Install Dependencies

```bash
cd asana-time-tracker
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:
```
ASANA_APP_CLIENT_ID=your_client_id
ASANA_APP_CLIENT_SECRET=your_client_secret
PORT=3000
BASE_URL=https://your-public-domain.com
```

> **Important:** `BASE_URL` must be a publicly accessible HTTPS URL. Use ngrok for local development: `ngrok http 3000`

### 3. Start the Server

```bash
npm start
# or for development with auto-reload:
npm run dev
```

### 4. Configure in Asana Developer Console

Go to [developers.asana.com](https://developers.asana.com) > Your App ("DEV NAGA"):

#### OAuth Settings
- **Redirect URL:** `{BASE_URL}/auth/callback`

#### App Components
Add these components:

**Widget:**
- Widget URL: `{BASE_URL}/widget`
- Resource attach URL: `{BASE_URL}/handshake`

**Form (Custom Action):**
- Form URL: `{BASE_URL}/form`
- Display name: "Log Time"

**Rule Action (Optional):**
- Action URL: `{BASE_URL}/rule/action`
- Display name: "Auto Track Time"

### 5. Authorize Users

Each user visits `{BASE_URL}/auth` once to connect their Asana account.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth` | Start OAuth flow |
| GET | `/auth/callback` | OAuth callback |
| GET | `/widget?task={gid}` | Widget data for task |
| POST | `/widget/action` | Start/Stop timer |
| GET | `/form` | Manual time entry form |
| POST | `/form/submit` | Submit manual time |
| POST | `/rule/action` | Rule-based auto tracking |
| GET | `/api/tasks/:gid/time` | Get time entries for task |
| POST | `/api/tasks/:gid/timer/start` | Start timer |
| POST | `/api/tasks/:gid/timer/stop` | Stop timer |
| POST | `/api/tasks/:gid/time` | Log manual time |
| GET | `/health` | Health check |

## Hosting Options

| Option | Cost | Best For |
|--------|------|----------|
| **Render** | Free tier | Quick deployment |
| **Railway** | ~$5/mo | Easy setup |
| **Heroku** | ~$7/mo | Reliable |
| **AWS EC2** | Varies | Full control |
| **Your own server** | Free | If you have one |

### Deploy to Render (Recommended)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) > New Web Service
3. Connect your repo
4. Set environment variables in Render dashboard
5. Deploy

## Architecture

```
Asana Task UI
    │
    ├── Widget (GET /widget) ── Shows total time, timer status, recent entries
    │
    ├── Start/Stop Button (POST /widget/action) ── Toggles timer
    │
    ├── Log Time Form (GET /form → POST /form/submit) ── Manual entry
    │
    └── Rule Action (POST /rule/action) ── Auto start/stop on status change
            │
            ▼
    Express Server (server.js)
            │
            ▼
    SQLite Database (timetracker.db)
        ├── tokens (OAuth credentials)
        ├── time_entries (logged time)
        └── active_timers (running timers)
```

## Data Storage

All time data is stored locally in SQLite (`timetracker.db`). No Asana data is modified or deleted — the app only:
- Reads task/user information
- Adds comments to tasks showing time logged
