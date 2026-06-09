# Backend - Autonomous Verification Layer

Node.js + Express + TypeScript backend for generating Playwright test scripts, storing text artifacts in Firestore, executing tests via terminal command, and serving local screenshots over static HTTP.

## Features

- `POST /api/generate`: ingest localhost URL + `.md/.txt` files, collect accessibility snapshot via Playwright MCP Server, generate Playwright script via Copilot API SDK client.
- `POST /api/save-test`: persist generated test case to Firestore.
- `POST /api/execute`: run selected test cases with Playwright (`npx playwright test`) and update Firestore in real-time.
- `GET /health`: liveness check.
- Static screenshot serving via `/static/screenshots/*` from local disk.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

Fill Firebase Admin credentials (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) and Copilot API token (`COPILOT_API_TOKEN`).

3. Start dev server:

```bash
npm run dev
```

Default backend URL: `http://localhost:4000`.

## Notes

- Text data (scripts, logs, status) are stored in Firestore.
- Screenshot evidence stays on local disk at `backend/storage/screenshots` and is exposed by Express static middleware.
- Accessibility snapshots are collected through Playwright MCP (`@playwright/mcp`) from the backend service.
- Frontend should subscribe with Firestore `onSnapshot` to collections `testCases` and `testRuns` for real-time updates.
