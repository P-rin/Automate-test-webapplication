# Backend - Autonomous Verification Layer

Node.js + Express + TypeScript backend for generating Playwright test scripts, storing text artifacts in Firestore, executing tests via terminal command, and serving local screenshots over static HTTP.

## Features

- `POST /api/auth/github`: exchange GitHub OAuth `code`, verify active Copilot subscription, and create backend session token.
- `GET /api/auth/session`: validate backend session token.
- `POST /api/auth/logout`: revoke backend session token.
- `POST /api/generate`, `/api/generate-job`, `/api/v2/generate-job`, `/api/generate-test`: require a Firebase ID token, explore the app via Playwright MCP, then generate test plans and scripts with Ollama.
- `/api/v2/generate-job` accepts `humanReview=true` to pause after AI acceptance criteria and after page discovery. Review with `GET/PUT /api/v2/generation-jobs/:jobId/acceptance-criteria`, then confirm with `POST /api/v2/generation-jobs/:jobId/acceptance-criteria/confirm`. Read discovered pages with `GET /api/v2/generation-jobs/:jobId/pages`, then confirm selected `pageIds` with `POST /api/v2/generation-jobs/:jobId/pages/confirm`.
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

Fill Firebase Admin credentials (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`). Start Ollama on the backend host and pull both configured models:

```bash
ollama pull qwen3.5:9b
ollama pull qwen2.5-coder:7b
```

On machines with 16 GB RAM or less, set `OLLAMA_MAX_LOADED_MODELS=1` as a Windows user environment variable and restart Ollama. This prevents the planner and script models from being loaded into memory at the same time.

GitHub OAuth remains a separate session feature and still checks Copilot entitlement:

- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `GITHUB_OAUTH_REDIRECT_URI` (ex: `http://localhost:5173/auth/callback`)

Environment keys:

- `OLLAMA_BASE_URL` = Ollama server URL (default `http://localhost:11434`)
- `OLLAMA_MODEL` = generation model (default `qwen2.5-coder:7b`)
- `OLLAMA_PLANNER_MODEL` = test-case planning model (default `qwen3.5:9b`)
- `OLLAMA_SCRIPT_MODEL` = Playwright script-generation model (default `qwen2.5-coder:7b`)
- `OLLAMA_PLANNER_THINK` = enable thinking on planner requests (`false` by default)
- `OLLAMA_NUM_CTX` = Ollama context window size (default `8192`)
- `OLLAMA_KEEP_ALIVE` = duration to keep the active model loaded (default `5m`)
- `LLM_MAX_PROMPT_CHARS` = maximum planner prompt size
- `REQUIREMENT_MAX_UNITS` = maximum requirement units extracted per generation job (default `80`)
- `REQUIREMENT_MAX_CRITERIA` = maximum acceptance criteria retained per generation job (default `60`)
- `COVERAGE_GAP_MAX_CASES` = maximum targeted test cases generated for uncovered required criteria per job (default `10`)
- `EXECUTION_RETRIES` = Playwright retries for failed tests (default `1`); tests that pass only after retry are reported as flaky
- `COPILOT_API_URL` and `COPILOT_MODEL` = used only by the separate GitHub OAuth entitlement check
- `PLAYWRIGHT_EXPLORE_MAX_SNAPSHOTS` = max number of snapshots to collect during MCP exploration
- `PLAYWRIGHT_EXPLORE_MAX_CANDIDATES` = max number of clickable candidates to explore after the base snapshot
- `PLAYWRIGHT_EXPLORE_MAX_DEPTH` = max crawl depth for internal route exploration
- `GENERATION_JOB_MAX_PAGES` = maximum pages in the human-review page selection list (default `30`)
- `GENERATION_JOB_PAGE_MAX_DEPTH` = maximum BFS depth during page discovery (default `3`)
- `GENERATION_JOB_PAGE_MAX_NAVIGATION_ACTIONS` = maximum shallow navigation clicks per page (default `5`)

For localhost OAuth testing with HTTPS public URL, see [TUNNELING.md](./TUNNELING.md).

3. Start dev server:

```bash
npm run dev
```

Default backend URL: `http://localhost:4000`.

## Notes

- Text data (scripts, logs, status) are stored in Firestore.
- Screenshot, video, and trace evidence stays on local disk at `backend/storage/screenshots`, `backend/storage/videos`, and `backend/storage/traces`, served by Express static middleware.
- Accessibility snapshots are collected through Playwright MCP (`@playwright/mcp`) from the backend service.
- Ollama performs planner and script-generation passes and can call an allowlisted set of Playwright MCP tools with a bounded number of calls.
- Generation now uses multi-step MCP exploration rather than a single snapshot: initial page, credential-driven login attempt when credentials are found in uploaded specs, then additional navigation snapshots from important buttons/links.
- Generation jobs default to safe planning: the planner stops at confirmation screens for purchases, payments, deletions, and account changes unless `allowMutatingTests` is explicitly enabled for a test environment.
- Legacy generation requests keep the original one-shot flow unless `/api/v2/generate-job` receives `humanReview=true`. Human-review jobs store discovered pages in `generationJobs/{jobId}/pages`, detailed snapshots in `snapshots`, and link planned cases to their selected `pageId`.
- Backend can be configured with environment variables to control MCP startup:
  - `PLAYWRIGHT_MCP_COMMAND` — custom command to launch MCP server (default `playwright-mcp`, `npx` is blocked)
  - `PLAYWRIGHT_MCP_ARGS` — optional CLI args array for the MCP command
  - `PLAYWRIGHT_MCP_BROWSER` — browser selection (`chrome`, `firefox`, `webkit`, `msedge`)
  - `PLAYWRIGHT_MCP_ISOLATED` — if `true`, enables isolated MCP sessions
  - `PLAYWRIGHT_MCP_USER_DATA_DIR` — custom user data directory for Playwright MCP
  - `PLAYWRIGHT_MCP_STORAGE_STATE` — path to a storage state file for initial session state
  - `PLAYWRIGHT_HEADLESS` — `true` or `false` to control headless mode
  - `PLAYWRIGHT_EXPLORE_MAX_DEPTH` — maximum navigation depth for internal route crawling
- Frontend should subscribe with Firestore `onSnapshot` to collections `testCases` and `testRuns` for real-time updates.
- Ollama connection/model errors are reported on the generation job; generation does not silently fall back to Copilot or a deterministic smoke test.
