# Viral Score Backend Contract

The web app does not ask users for a Gemini API key. The key must live on your backend.

## Endpoint

Default client endpoint:

```txt
POST /api/analyze
```

The URL can be overridden in the app settings for local testing. On Vercel, the same endpoint is served from the production deployment.

Health check:

```txt
GET /health
```
Returns `{ "ok": true, "geminiConfigured": true|false, "botConfigured": true|false, "blobConfigured": true|false, "redisConfigured": true|false, "kvConfigured": true|false, "storeBackend": "redis"|"memory" }`.
On Vercel, `/health` rewrites to the API route that serves this response.

Vercel Blob client token:

```txt
POST /api/blob/upload
```
Issues a Vercel Blob client token for direct browser→Blob uploads (multipart client upload protocol).

Vercel Blob delete:

```txt
POST /api/blob/delete   { url: "https://..." }
DELETE /api/blob/delete?url=...
```
Deletes a blob by URL. Returns `{ ok: true }` or `{ ok: true, skipped: true }` if BLOB_READ_WRITE_TOKEN is not configured.

Gemini resumable upload session:

```txt
POST /api/upload-session
```
Creates a Gemini Files API resumable upload session. Returns `{ uploadUrl, sessionId }`.

Gemini upload chunk:

```txt
POST /api/upload-chunk
```
Proxies a single chunk to the Gemini Files API resumable upload URL.

Gemini file status:

```txt
GET /api/file-status?name=files/...
```
Polls the Gemini Files API for file processing state. Returns `{ name, state, uri, mimeType }`.

Client status:

```txt
GET /api/status?clientId=...
```

History sync:

```txt
GET /api/history?clientId=...
```

Unlock access (server-side only — requires `UNLOCK_SECRET`):

```txt
POST /api/unlock
Header: X-Unlock-Secret: <UNLOCK_SECRET>
Body: {
  "clientId": "...",
  "method": "card",
  "unlockSecret": "<UNLOCK_SECRET>",
  "resetUsage": true
}
```

`resetUsage: true` clears `usageCount` for that client (useful after testing). Never expose `UNLOCK_SECRET` in the frontend.

Developer allowlist (no UI, env on Vercel only):

```txt
DEVELOPER_CLIENT_IDS=your_client_id_from_localStorage,another_id
```

Those IDs get unlimited analyses and premium flags via `/api/status`, but the allowlist itself is never sent to browsers. Find your id in DevTools → Application → `viral_score_client_id_v1`, or `localStorage.getItem('viral_score_client_id_v1')`.

Free quota billing: only non-degraded successful analyses increment `usageCount`. Degraded text fallbacks (overload / video failure) do not consume a free attempt.

Telegram Stars unlocks via `POST /api/telegram-webhook` on `successful_payment` (no client call to `/api/unlock`).

Payment payload:

```txt
GET /api/payment-payload?clientId=...&method=stars
```

External card checkout:

```txt
https://your-checkout.example/pay?clientId=...&method=card&returnUrl=...
```

After a successful card payment, the external checkout or its webhook should call `POST /api/unlock`.

Stars invoice link:

```txt
POST /api/stars-invoice-link
```

Telegram webhook:

```txt
POST /api/telegram-webhook
```

Contextual Q&A after analysis (not a general chat — only questions about the analyzed content):

```txt
POST /api/ask-analysis
```

JSON body: `question`, `result` (analysis JSON), optional `meta` (`platform`, `mode`, `sourceType`, …), `language` (`en`|`ru`), optional `history` (last turns: `{ role: "user"|"assistant", text }`).

Response: `{ "answer": "...", "language": "en" }`.

## Request

The frontend sends `multipart/form-data`.

Fields:

- `clientId`: stable per-user or per-device identifier
- `analysisId`: stable id for the current analysis run
- `platform`: `Instagram`, `TikTok`, `YouTube`, `X`, or `Telegram`
- `mode`: `quick`, `pro`, or `ad`
- `sourceType`: `video-file`, `video-url`, or `text`
- `language`: `en` or `ru`
- `context`: optional extra user context
- `prompt`: the assembled analysis prompt
- `freeLimit`: current free quota value from the client (server enforces quota; do not trust client unlock flags)
- `video`: file, only for `video-file`
- `url`: post/video URL, only for `video-url`
- `text`: caption/transcript/script, only for `text`
- `clientId`: required for `POST /api/unlock`
- `clientId` and optional `method`: used by `GET /api/payment-payload`
- `clientId`, `title`, `description`, `stars`: used by `POST /api/stars-invoice-link`
- `message.successful_payment.invoice_payload`: used by `POST /api/telegram-webhook`

## Response

Return JSON matching this shape:

```json
{
  "viral_score": 78,
  "hook_strength": 82,
  "retention_score": 74,
  "clarity_score": 80,
  "shareability_score": 76,
  "cta_score": 70,
  "platform_fit_score": 84,
  "first_three_seconds_score": 79,
  "strengths": ["Clear premise"],
  "risks": ["CTA appears too late"],
  "suggestions": ["Move the payoff into the first 3 seconds"],
  "next_actions": ["Test a shorter hook"],
  "summary": "Strong concept with room to tighten the opening.",
  "hook_insight": "The first line is specific and easy to understand.",
  "retention_insight": "The middle section needs more pattern breaks.",
  "shareability_insight": "The topic has clear save/share potential.",
  "platform_fit_insight": "Fits short-form discovery well.",
  "improved_hook": "Stop posting videos before checking this.",
  "improved_caption": "Run your next post through this before publishing.",
  "improved_cta": "Upload your draft and get a viral score."
}
```

The frontend also accepts `{ "result": { ... } }` or `{ "analysis": { ... } }`.
The backend may also return `usageCount`, `accessUnlocked`, and `freeLimit`.
The history endpoint returns `{ "history": [...] }`.
The unlock endpoint returns `{ "accessUnlocked": true, ... }`.
The Telegram webhook returns `{ "ok": true, "handled": true, ... }` when a payment is recognized.
The payload endpoint returns `{ "payload": "clientId:..." }` and the method.
The payload format is `clientId:<id>;method:<method>`.
The Stars invoice endpoint returns `{ "clientId": "...", "method": "stars", "invoiceLink": "...", "payload": "...", "stars": 10 }`.

## Notes

- Store `GEMINI_API_KEY` only on the server.
- Store `BOT_TOKEN` only on the server before using the Stars invoice generator.
- Validate Telegram payments and free limits on the server for production.
- Do not trust localStorage for paid access in production.
- Allow CORS for the frontend origin, especially if the app is opened from `file://` during local testing.
