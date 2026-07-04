# Backend - Autonomous Verification Layer

Node.js + Express + TypeScript backend for generating Playwright test scripts, storing text artifacts in Firestore, executing tests via terminal command, and serving local screenshots over static HTTP.

## Features

- `POST /api/generate`: ingest localhost URL + `.md/.txt` files, explore the app via Playwright MCP (landing page, login attempt from spec credentials, post-login navigation snapshots), then generate Playwright script via Copilot API SDK client.
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

Important provider rules:

- `LLM_PROVIDER=auto` (default):
	- if token is PAT (`ghp_` / `github_pat_`), backend uses GitHub Models endpoint
	- otherwise backend uses Copilot endpoint
- `LLM_PROVIDER=copilot`: force `https://api.githubcopilot.com` (PAT is not supported)
- `LLM_PROVIDER=github-models`: force `https://models.github.ai/inference` (use PAT with Models access)

Environment keys:

- `LLM_PROVIDER` = `auto` | `copilot` | `github-models`
- `COPILOT_API_TOKEN` = shared auth token variable for selected provider
- `COPILOT_API_URL` = Copilot base URL (default `https://api.githubcopilot.com`)
- `GITHUB_MODELS_API_URL` = GitHub Models base URL (default `https://models.github.ai/inference`)
- `COPILOT_MODEL` = model for copilot provider
- `GITHUB_MODELS_MODEL` = model for github-models provider
- `PLAYWRIGHT_EXPLORE_MAX_SNAPSHOTS` = max number of snapshots to collect during MCP exploration
- `PLAYWRIGHT_EXPLORE_MAX_CANDIDATES` = max number of clickable candidates to explore after the base snapshot
- `PLAYWRIGHT_EXPLORE_MAX_DEPTH` = max crawl depth for internal route exploration

3. Start dev server:

```bash
npm run dev
```

Default backend URL: `http://localhost:4000`.

## Notes

- Text data (scripts, logs, status) are stored in Firestore.
- Screenshot evidence stays on local disk at `backend/storage/screenshots` and is exposed by Express static middleware.
- Accessibility snapshots are collected through Playwright MCP (`@playwright/mcp`) from the backend service.
- Generation now uses multi-step MCP exploration rather than a single snapshot: initial page, credential-driven login attempt when credentials are found in uploaded specs, then additional navigation snapshots from important buttons/links.
- Backend can be configured with environment variables to control MCP startup:
  - `PLAYWRIGHT_MCP_COMMAND` — custom command to launch MCP server (default `npx`)
  - `PLAYWRIGHT_MCP_ARGS` — optional CLI args array for the MCP command
  - `PLAYWRIGHT_MCP_BROWSER` — browser selection (`chrome`, `firefox`, `webkit`, `msedge`)
  - `PLAYWRIGHT_MCP_ISOLATED` — if `true`, enables isolated MCP sessions
  - `PLAYWRIGHT_MCP_USER_DATA_DIR` — custom user data directory for Playwright MCP
  - `PLAYWRIGHT_MCP_STORAGE_STATE` — path to a storage state file for initial session state
  - `PLAYWRIGHT_HEADLESS` — `true` or `false` to control headless mode
  - `PLAYWRIGHT_EXPLORE_MAX_DEPTH` — maximum navigation depth for internal route crawling
- Frontend should subscribe with Firestore `onSnapshot` to collections `testCases` and `testRuns` for real-time updates.
- If provider authentication fails and generation cannot continue, backend falls back to a deterministic smoke test script so users can keep testing the execution flow.
