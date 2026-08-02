# Localhost Tunneling for GitHub OAuth

Use one of the options below to expose backend port `4000` as an HTTPS public URL during local development.

## Option A: ngrok

```bash
npm run tunnel:ngrok
```

Then copy the HTTPS URL, for example:

- `https://abc123.ngrok-free.app`

Set your frontend/backend env values:

- `VITE_BACKEND_URL=https://abc123.ngrok-free.app`
- `FRONTEND_ORIGIN=https://your-frontend-origin`

## Option B: localtunnel

```bash
npm run tunnel:lt
```

Set the returned HTTPS URL as `VITE_BACKEND_URL`.

## Option C: VS Code Port Forwarding

1. Open Ports view in VS Code.
2. Forward backend port `4000`.
3. Set visibility to `Public`.
4. Copy the generated HTTPS URL and use it as `VITE_BACKEND_URL`.

## OAuth Redirect URI Checklist

- `GITHUB_OAUTH_REDIRECT_URI` should match the frontend callback page, e.g. `http://localhost:5173/auth/callback` (or your deployed frontend URL).
- GitHub OAuth App callback URL must match exactly.
- Ensure frontend can call backend `/api/auth/github` via CORS (`FRONTEND_ORIGIN`).
