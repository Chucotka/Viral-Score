# Viral Score

Short-form content analyzer for video files, video links, and text.

## Local run

Local dev runs the exact same serverless code as production (`api/[...path].js`) via the Vercel CLI, so there is a single source of truth.

1. Install the CLI once and link the project:

```bash
npm i -g vercel   # or use: npx vercel
vercel link
```

2. Provide secrets via `.env.local` (or `vercel env pull`):

```bash
GEMINI_API_KEY="your_key_here"
BOT_TOKEN="your_telegram_bot_token"
UNLOCK_SECRET="long_random_secret_for_card_webhooks"
```

3. Start the dev server (serves the static app + the same `api/*` functions as prod):

```bash
vercel dev          # or: npx vercel dev
```

4. Open the printed local URL (default `http://localhost:3000`).

The backend health check lives at `/health`.
`/health` also reports whether Telegram bot payments are configured.
Client usage sync lives at `http://127.0.0.1:3000/api/status?clientId=...`.
Client history sync lives at `http://127.0.0.1:3000/api/history?clientId=...`.
Paid access unlocks through Telegram Stars (`POST /api/telegram-webhook` on successful payment) or `POST /api/unlock` from your card checkout webhook with `UNLOCK_SECRET`.
Telegram Stars webhooks can hit `POST /api/telegram-webhook`.
Payment payloads can be fetched from `GET /api/payment-payload?clientId=...&method=stars`.
Stars invoice links can be generated with `POST /api/stars-invoice-link`.
Each analysis sends a stable `analysisId` so history stays deduplicated across client and server.

External card checkout can be configured in the app settings. The app appends:

```txt
clientId=...
method=card
returnUrl=...
```

After a successful card payment, call `POST /api/unlock` with header `X-Unlock-Secret: $UNLOCK_SECRET` (or `unlockSecret` in the JSON body). The Mini App polls `GET /api/status` after Stars payment — do not unlock from the browser.

## Vercel deploy

The project also ships with Vercel API routes, so the production app can run on `https://viral-score.vercel.app` without a separate backend server. On Vercel, the frontend uses `/api/analyze` and `/health` directly from the same deployment.

### Persistent storage (recommended)

Connect **Upstash Redis** from the Vercel Marketplace (Storage → your existing `upstash-kv-…` store → Connect to Project). Vercel injects `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Legacy `KV_REST_API_*` names still work.

Do not install deprecated `@vercel/kv` — this app uses `@upstash/redis` directly.

Without Redis, client quotas, unlock state, and history live in **per-instance memory** and reset on cold starts.

Optional env:

```bash
RATE_LIMIT_ANALYZE_PER_HOUR=40
```

## Production

- Keep `GEMINI_API_KEY` only on the server.
- Serve the app over HTTPS or as a Telegram Mini App.
- Point the frontend to `/api/analyze` or your own backend URL.
