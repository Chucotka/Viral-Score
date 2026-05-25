# Viral Score

Short-form content analyzer for video files, video links, and text.

## Local run

1. Set your server key:

```bash
export GEMINI_API_KEY="your_key_here"
export BOT_TOKEN="your_telegram_bot_token"
export UNLOCK_SECRET="long_random_secret_for_card_webhooks"
```

2. Start the backend:

```bash
npm start
```

3. Open:

```txt
http://127.0.0.1:3000
```

The app will use `http://127.0.0.1:3000/api/analyze` by default when opened from `file://`.
The backend health check lives at `http://127.0.0.1:3000/health`.
`/health` also reports whether Telegram bot payments are configured.
Client usage sync lives at `http://127.0.0.1:3000/api/status?clientId=...`.
Client history sync lives at `http://127.0.0.1:3000/api/history?clientId=...`.
Paid access unlocks through Telegram Stars (`POST /api/telegram-webhook` on successful payment) or `POST /api/unlock` from your card checkout webhook with `UNLOCK_SECRET`.
Telegram Stars webhooks can hit `POST /api/telegram-webhook`.
Payment payloads can be fetched from `GET /api/payment-payload?clientId=...&method=stars`.
Stars invoice links can be generated with `POST /api/stars-invoice-link`.
Each analysis sends a stable `analysisId` so history stays deduplicated across client and server.
If your environment blocks `0.0.0.0`, the server binds to `127.0.0.1`.

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

Link **Vercel KV** (or Upstash Redis) to the project. Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.

Without KV, client quotas, unlock state, and history live in **per-instance memory** and reset on cold starts.

Optional env:

```bash
RATE_LIMIT_ANALYZE_PER_HOUR=40
```

## Production

- Keep `GEMINI_API_KEY` only on the server.
- Serve the app over HTTPS or as a Telegram Mini App.
- Point the frontend to `/api/analyze` or your own backend URL.
