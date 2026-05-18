import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const INDEX_PATH = path.join(__dirname, 'index.html');
const CONTRACT_PATH = path.join(__dirname, 'BACKEND_CONTRACT.md');
const STATE_PATH = path.join(__dirname, 'server-state.json');
const MODEL_CANDIDATES = ['gemini-2.5-flash', 'gemini-2.5-flash-preview-04-17', 'gemini-2.0-flash'];
const MODEL_CANDIDATES_VIDEO = ['gemini-2.5-flash', 'gemini-2.5-flash-preview-04-17', 'gemini-2.0-flash'];
let serverStateCache = null;
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    viral_score: { type: 'number' },
    hook_strength: { type: 'number' },
    retention_score: { type: 'number' },
    clarity_score: { type: 'number' },
    shareability_score: { type: 'number' },
    cta_score: { type: 'number' },
    platform_fit_score: { type: 'number' },
    first_three_seconds_score: { type: 'number' },
    strengths: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } },
    next_actions: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    hook_insight: { type: 'string' },
    retention_insight: { type: 'string' },
    shareability_insight: { type: 'string' },
    platform_fit_insight: { type: 'string' },
    improved_hook: { type: 'string' },
    improved_caption: { type: 'string' },
    improved_cta: { type: 'string' }
  },
  required: [
    'viral_score',
    'hook_strength',
    'retention_score',
    'clarity_score',
    'shareability_score',
    'cta_score',
    'platform_fit_score',
    'first_three_seconds_score',
    'strengths',
    'risks',
    'suggestions',
    'next_actions',
    'summary',
    'hook_insight',
    'retention_insight',
    'shareability_insight',
    'platform_fit_insight',
    'improved_hook',
    'improved_caption',
    'improved_cta'
  ]
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(text);
}

function normalizeUrl(value) {
  try {
    return new URL(value).toString();
  } catch {
    return '';
  }
}

function extractFirstUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const direct = text.match(/https?:\/\/[^\s<>"']+/i)?.[0]
    || text.match(/\b(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"']*)?/i)?.[0]
    || '';
  if (!direct) return '';
  const cleaned = direct.replace(/[),.;!?]+$/g, '');
  const prefixed = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  try {
    return new URL(prefixed).toString();
  } catch {
    return '';
  }
}

function normalizePasteableLink(value) {
  return normalizeUrl(value) || extractFirstUrl(value);
}

function isDirectVideoUrl(value) {
  try {
    const path = new URL(value).pathname.toLowerCase();
    return /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(path);
  } catch {
    return false;
  }
}

function getUrlPlatform(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '');
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('vk.com') || host.includes('vkvideo.ru')) return 'vk';
    if (host.includes('t.me') || host.includes('telegram.org')) return 'telegram';
    return 'other';
  } catch {
    return 'other';
  }
}

function clampScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function toStringList(value) {
  return Array.isArray(value) ? value.map(item => (typeof item === 'string' ? item : '')).filter(Boolean) : [];
}

function normalizeResult(raw) {
  return {
    viral_score: clampScore(raw?.viral_score),
    hook_strength: clampScore(raw?.hook_strength),
    retention_score: clampScore(raw?.retention_score),
    clarity_score: clampScore(raw?.clarity_score),
    shareability_score: clampScore(raw?.shareability_score),
    cta_score: clampScore(raw?.cta_score),
    platform_fit_score: clampScore(raw?.platform_fit_score),
    first_three_seconds_score: clampScore(raw?.first_three_seconds_score),
    strengths: toStringList(raw?.strengths),
    risks: toStringList(raw?.risks),
    suggestions: toStringList(raw?.suggestions),
    next_actions: toStringList(raw?.next_actions),
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
    hook_insight: typeof raw?.hook_insight === 'string' ? raw.hook_insight : '',
    retention_insight: typeof raw?.retention_insight === 'string' ? raw.retention_insight : '',
    shareability_insight: typeof raw?.shareability_insight === 'string' ? raw.shareability_insight : '',
    platform_fit_insight: typeof raw?.platform_fit_insight === 'string' ? raw.platform_fit_insight : '',
    improved_hook: typeof raw?.improved_hook === 'string' ? raw.improved_hook : '',
    improved_caption: typeof raw?.improved_caption === 'string' ? raw.improved_caption : '',
    improved_cta: typeof raw?.improved_cta === 'string' ? raw.improved_cta : ''
  };
}

async function loadServerState() {
  if (serverStateCache) return serverStateCache;
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    serverStateCache = JSON.parse(raw);
  } catch {
    serverStateCache = { clients: {} };
  }
  if (!serverStateCache.clients || typeof serverStateCache.clients !== 'object') {
    serverStateCache.clients = {};
  }
  return serverStateCache;
}

async function saveServerState() {
  if (!serverStateCache) return;
  await writeFile(STATE_PATH, JSON.stringify(serverStateCache, null, 2));
}

function normalizeClientId(value) {
  return String(value || 'anonymous').trim().slice(0, 128) || 'anonymous';
}

function getClientRecord(state, clientId) {
  const id = normalizeClientId(clientId);
  if (!state.clients[id]) {
    state.clients[id] = {
      usageCount: 0,
      accessUnlocked: false,
      history: [],
      lastSeenAt: new Date().toISOString()
    };
  }
  return state.clients[id];
}

function extractClientIdFromPayload(payload) {
  if (!payload) return '';
  const text = String(payload).trim();
  if (!text) return '';
  if (text.startsWith('clientId:')) {
    const raw = text.slice(9).split(';')[0];
    return normalizeClientId(raw);
  }
  if (text.startsWith('client:')) {
    const raw = text.slice(7).split(';')[0];
    return normalizeClientId(raw);
  }
  try {
    const parsed = JSON.parse(text);
    return normalizeClientId(parsed.clientId || parsed.client_id || parsed.id);
  } catch {
    return normalizeClientId(text);
  }
}

function buildPaymentPayload(clientId, method = 'stars') {
  return `clientId:${normalizeClientId(clientId)};method:${String(method || 'stars')}`;
}

function normalizeAnalysisId(value) {
  return String(value || '').trim().slice(0, 128);
}

function normalizeHistoryEntry(entry) {
  return {
    id: String(entry?.id || '').trim() || String(Date.now()),
    createdAt: typeof entry?.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
    platform: typeof entry?.platform === 'string' ? entry.platform : 'Instagram',
    mode: typeof entry?.mode === 'string' ? entry.mode : 'pro',
    sourceLabel: typeof entry?.sourceLabel === 'string' ? entry.sourceLabel : '',
    sourceType: typeof entry?.sourceType === 'string' ? entry.sourceType : 'text',
    viral_score: clampScore(entry?.viral_score),
    result: entry?.result ? normalizeResult(entry.result) : null
  };
}

function getPromptBase({ platform, mode, sourceType, language, context }) {
  const russian = language === 'ru';
  const modeGuides = russian ? {
    quick: 'Дай короткую, понятную оценку для автора с практичными правками.',
    pro: 'Дай подробный creator-анализ с максимально конкретными действиями.',
    ad: 'Оцени как рекламный креатив: важнее всего хук, удержание, ясность, убеждение и конверсия.'
  } : {
    quick: 'Give a crisp, creator-friendly assessment with practical fixes.',
    pro: 'Give a detailed creator analysis with strong actionability.',
    ad: 'Evaluate like a paid creative: hook, retention, clarity, persuasion, and conversion matter most.'
  };
  const sourceGuides = russian ? {
    'video-file': 'Анализируй само загруженное видео. Сфокусируйся на первых секундах, темпе, визуальной ясности, тексте на экране, эмоции и шеринге.',
    'video-url': 'Анализируй публичное видео или страницу по ссылке. Если URL context доступен, используй его; иначе опирайся на ссылку и контекст пользователя.',
    'text': 'Анализируй переданный текст, caption, транскрипт или сценарий как концепт поста.'
  } : {
    'video-file': 'Analyze the uploaded video itself. Focus on the opening seconds, pacing, visual clarity, on-screen text, emotion, and shareability.',
    'video-url': 'Analyze the linked public video or page. If URL context is available, use it; otherwise reason from the URL and provided context.',
    'text': 'Analyze the supplied text, caption, transcript, or script as a post concept.'
  };
  return [
    russian ? `Ты senior-стратег коротких видео для ${platform}. Отвечай на русском языке.` : `You are a senior short-form content strategist for ${platform}.`,
    modeGuides[mode] || modeGuides.pro,
    sourceGuides[sourceType] || sourceGuides.text,
    russian ? 'Верни только валидный JSON по заданной схеме. Все оценки должны быть целыми числами от 0 до 100.' : 'Return only valid JSON that matches the provided schema. All scores must be integers from 0 to 100.',
    russian ? 'Все текстовые поля должны быть короткими: одна фраза для insight, максимум 4 suggestions, без markdown.' : 'Keep every text field short: one sentence for insights, no more than 4 suggestions, no markdown.',
    russian ? 'Рекомендации должны улучшать удержание, шеры и клики.' : 'Base recommendations on what most improves watch time, shares, and click-through.'
  ].join(' ');
}

async function getApiError(response, fallback) {
  try {
    const data = await response.clone().json();
    if (typeof data?.error === 'string') return data.error;
    if (typeof data?.error?.message === 'string') return data.error.message;
    return fallback;
  } catch {
    try {
      const text = await response.clone().text();
      return text.slice(0, 500) || fallback;
    } catch {
      return fallback;
    }
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitGeminiFileProcessed(uploadName, mimeType, partial = {}) {
  let state = partial.state || 'ACTIVE';
  if (!uploadName || state === 'ACTIVE') {
    return { ...partial, mimeType: mimeType || partial.mimeType, state: 'ACTIVE' };
  }
  const started = Date.now();
  let delayMs = 0;
  while (Date.now() - started < 120000) {
    if (delayMs) await sleep(delayMs);
    delayMs = delayMs ? Math.min(Math.round(delayMs * 1.55), 2800) : 400;
    const statusResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/${uploadName}?key=${encodeURIComponent(GEMINI_API_KEY)}`);
    if (!statusResponse.ok) continue;
    const statusData = await statusResponse.json();
    state = statusData.state;
    if (state === 'ACTIVE') return { ...statusData, mimeType: mimeType || statusData.mimeType };
    if (state === 'FAILED') throw new Error('Gemini file processing failed.');
  }
  throw new Error('Timed out waiting for uploaded video processing.');
}

function geminiFileResourcePath(fileUri) {
  const s = String(fileUri || '').trim();
  if (!s) return '';
  if (/^files\/[^/?]+/.test(s)) return s.split('?')[0];
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/(files\/[^/?]+)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

async function uploadVideoFile(file) {
  const body = file?.body || file;
  const fileName = file?.name || 'video.mp4';
  const rawType = file?.type || body?.type || 'video/mp4';
  const fileType = rawType === 'application/octet-stream'
    ? (fileName.toLowerCase().endsWith('.mov') ? 'video/quicktime'
      : fileName.toLowerCase().endsWith('.webm') ? 'video/webm'
      : 'video/mp4')
    : rawType;
  const fileSize = Number(file?.size || (Buffer.isBuffer(body) ? body.length : 0) || 0);
  const startResponse = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(fileSize),
      'X-Goog-Upload-Header-Content-Type': fileType,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: fileName } })
  });
  if (!startResponse.ok) {
    throw new Error(await getApiError(startResponse, `Upload start failed: ${startResponse.status}`));
  }
  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini did not return an upload URL.');
  }
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body
  });
  if (!uploadResponse.ok) {
    throw new Error(await getApiError(uploadResponse, `File upload failed: ${uploadResponse.status}`));
  }
  const uploadData = await uploadResponse.json();
  const uploadedFile = uploadData.file || uploadData;
  const uploadName = uploadedFile.name || uploadData.name;
  let fileState = uploadedFile.state || 'ACTIVE';
  if (uploadName && fileState !== 'ACTIVE') {
    return waitGeminiFileProcessed(uploadName, fileType, uploadedFile);
  }
  return { ...uploadedFile, mimeType: fileType };
}

async function uploadVideoFromBlobUrl(videoUrl) {
  let contentLength = '0';
  let mimeType = 'video/mp4';
  try {
    const headOpts = { method: 'HEAD' };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      headOpts.signal = AbortSignal.timeout(8000);
    }
    const headRes = await fetch(videoUrl, headOpts);
    contentLength = headRes.headers.get('content-length') || '0';
    const ct = headRes.headers.get('content-type') || 'video/mp4';
    mimeType = ct === 'application/octet-stream'
      ? (videoUrl.toLowerCase().includes('.mov') ? 'video/quicktime'
        : videoUrl.toLowerCase().includes('.webm') ? 'video/webm'
        : 'video/mp4')
      : ct.split(';')[0].trim() || 'video/mp4';
  } catch {
    // fall through
  }
  const dispName = (() => {
    try { return new URL(videoUrl).pathname.split('/').filter(Boolean).pop() || 'video.mp4'; }
    catch { return 'video.mp4'; }
  })();
  const startResponse = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': contentLength,
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: dispName } })
  });
  if (!startResponse.ok) {
    throw new Error(await getApiError(startResponse, `Upload start failed: ${startResponse.status}`));
  }
  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini did not return an upload URL.');
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) throw new Error(`Could not fetch video from URL: ${videoResponse.status}`);
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      ...(contentLength !== '0' ? { 'Content-Length': contentLength } : {})
    },
    body: videoResponse.body,
    duplex: 'half'
  });
  if (!uploadResponse.ok) {
    throw new Error(await getApiError(uploadResponse, `File upload to Gemini failed: ${uploadResponse.status}`));
  }
  const uploadData = await uploadResponse.json();
  const uploadedFile = uploadData.file || uploadData;
  const uploadName = uploadedFile.name || uploadData.name;
  let fileState = uploadedFile.state || 'ACTIVE';
  if (uploadName && fileState !== 'ACTIVE') {
    return waitGeminiFileProcessed(uploadName, mimeType, uploadedFile);
  }
  return { ...uploadedFile, mimeType };
}

async function callGemini(requestBody, mode = 'pro', options = {}) {
  const isVideo = options.isVideo === true;
  const quick = mode === 'quick' || isVideo;
  const ad = mode === 'ad';
  const temperature = quick ? 0.22 : ad ? 0.34 : 0.36;
  const maxOutputTokens = isVideo ? 3072 : (quick ? 3072 : 4096);
  const models = isVideo ? MODEL_CANDIDATES_VIDEO : (quick ? MODEL_CANDIDATES.slice(0, 1) : MODEL_CANDIDATES);
  let lastError = null;
  for (const model of models) {
    const generationConfig = {
      temperature,
      topP: 0.92,
      maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema: ANALYSIS_SCHEMA
    };
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...requestBody,
        generationConfig
      })
    });
    if (response.ok) {
      return response.json();
    }
    lastError = new Error(await getApiError(response, `Model ${model} failed: ${response.status}`));
  }
  throw lastError || new Error('All Gemini models failed.');
}

function extractModelText(data) {
  const part = data?.candidates?.[0]?.content?.parts?.[0];
  if (!part) throw new Error('Gemini returned an empty response.');
  if (typeof part.text === 'string') return part.text.trim();
  if (typeof part.inlineData?.data === 'string') return part.inlineData.data.trim();
  return JSON.stringify(part);
}

function parseModelJson(text) {
  let resultText = text.trim();
  if (resultText.startsWith('```json')) {
    resultText = resultText.slice(7).trim();
  } else if (resultText.startsWith('```')) {
    resultText = resultText.slice(3).trim();
  }
  if (resultText.endsWith('```')) {
    resultText = resultText.slice(0, -3).trim();
  }
  try {
    return JSON.parse(resultText);
  } catch {
    const start = resultText.indexOf('{');
    const end = resultText.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(resultText.slice(start, end + 1));
    }
    throw new Error('Gemini returned incomplete JSON.');
  }
}

function linkVideoHint(urlPlatform, mode) {
  const quick = mode === 'quick';
  if (quick) {
    if (urlPlatform === 'youtube') return 'YouTube: use url_context (title/description/transcript). Keep JSON tight.';
    if (urlPlatform === 'tiktok' || urlPlatform === 'instagram') {
      return `${urlPlatform === 'tiktok' ? 'TikTok' : 'Instagram'}: video often behind login—score from user context + URL; say so in summary.`;
    }
    if (urlPlatform === 'vk') return 'VK: url_context for public metadata; note if video unavailable.';
    if (urlPlatform === 'telegram') return 'Telegram: url_context if t.me post is public.';
    return 'Use url_context on the URL; if blocked, lean on user context.';
  }
  if (urlPlatform === 'youtube') {
    return 'This is a YouTube link. Use URL context to read the public page — title, description, and transcript if available. Base your analysis on this metadata and the user context provided.';
  }
  if (urlPlatform === 'tiktok' || urlPlatform === 'instagram') {
    return `This is a ${urlPlatform === 'tiktok' ? 'TikTok' : 'Instagram'} link. IMPORTANT: You cannot access the actual video content from this URL — the page requires authentication. Base your analysis on: (1) any context the user provided below, (2) the URL structure and username if visible, (3) general best practices for this platform. Be transparent in your summary that video content was not directly accessible and the score is based on context only.`;
  }
  if (urlPlatform === 'vk') {
    return 'This is a VK Video link. Use URL context to read any accessible public page metadata. Note in your summary if video content was not directly accessible.';
  }
  if (urlPlatform === 'telegram') {
    return 'This is a Telegram link. Use URL context if the post is publicly accessible. Note in your summary if content was not directly accessible.';
  }
  return 'Use URL context to read public page metadata and visible text. If the page is not accessible, note this in your summary and base your analysis on the user-provided context.';
}

async function analyzeMultipart(formData) {
  const analysisId = normalizeAnalysisId(formData.get('analysisId'));
  const clientId = normalizeClientId(formData.get('clientId'));
  const platform = String(formData.get('platform') || 'Instagram');
  const mode = String(formData.get('mode') || 'pro');
  const sourceType = String(formData.get('sourceType') || 'text');
  const language = String(formData.get('language') || 'en');
  const context = String(formData.get('context') || '').trim();
  const freeLimit = Math.max(0, Number(formData.get('freeLimit') || '3'));
  const accessUnlocked = String(formData.get('accessUnlocked') || '') === '1';
  const prompt = String(formData.get('prompt') || getPromptBase({ platform, mode, sourceType, language, context }));
  const video = formData.get('video');
  const url = String(formData.get('url') || '');
  const text = String(formData.get('text') || '');
  const serverState = await loadServerState();
  const client = getClientRecord(serverState, clientId);
  client.lastSeenAt = new Date().toISOString();
  client.accessUnlocked = client.accessUnlocked || accessUnlocked;

  if (!client.accessUnlocked && freeLimit > 0 && client.usageCount >= freeLimit) {
    const error = new Error('Free quota ended.');
    error.statusCode = 402;
    throw error;
  }

  let requestBody;
  if (sourceType === 'video-file') {
    const fileUri = String(formData.get('fileUri') || '').trim();
    const fileMimeType = String(formData.get('fileMimeType') || 'video/mp4').trim();
    const videoBlobUrl = String(formData.get('videoBlobUrl') || '').trim();
    let uploadedFile = null;
    if (fileUri) {
      const resource = geminiFileResourcePath(fileUri);
      uploadedFile = { uri: fileUri, mimeType: fileMimeType };
      if (resource) {
        const st = await fetch(`https://generativelanguage.googleapis.com/v1beta/${resource}?key=${encodeURIComponent(GEMINI_API_KEY)}`);
        if (st.ok) {
          const meta = await st.json();
          if (meta.state && meta.state !== 'ACTIVE') {
            const ready = await waitGeminiFileProcessed(resource, fileMimeType, meta);
            uploadedFile = { uri: ready.uri || fileUri, mimeType: fileMimeType || ready.mimeType };
          }
        }
      }
    } else if (videoBlobUrl) {
      uploadedFile = await uploadVideoFromBlobUrl(videoBlobUrl);
    } else if (video && typeof video !== 'string') {
      uploadedFile = await uploadVideoFile(video);
    }
    if (!uploadedFile) throw new Error('Missing uploaded video file.');
    if (!uploadedFile.uri) throw new Error('Missing file URI. Upload may have failed.');
    requestBody = {
      contents: [{
        parts: [
          {
            file_data: { file_uri: uploadedFile.uri, mime_type: uploadedFile.mimeType || 'video/mp4' },
            media_resolution: 'MEDIA_RESOLUTION_LOW'
          },
          { text: prompt }
        ]
      }]
    };
  } else if (sourceType === 'video-url') {
    const normalizedUrl = normalizePasteableLink(url);
    if (normalizedUrl && isDirectVideoUrl(normalizedUrl)) {
      try {
        const uploadedFile = await uploadVideoFromBlobUrl(normalizedUrl);
        if (!uploadedFile?.uri) throw new Error('Missing uploaded file URI from direct video URL.');
        requestBody = {
          contents: [{
            parts: [
              { file_data: { file_uri: uploadedFile.uri, mime_type: uploadedFile.mimeType || 'video/mp4' } },
              { text: prompt }
            ]
          }]
        };
      } catch {
        requestBody = {
          contents: [{
            parts: [{ text: `${prompt}\n\nDirect video URL (could not stream server-side):\n${normalizedUrl}` }]
          }],
          tools: [{ url_context: {} }]
        };
      }
    } else if (normalizedUrl) {
      const urlPlatform = getUrlPlatform(normalizedUrl);
      const videoLinkHint = linkVideoHint(urlPlatform, mode);
      requestBody = {
        contents: [{
          parts: [{ text: `${prompt}\n\n${videoLinkHint}\n\nPublic URL:\n${normalizedUrl}` }]
        }],
        tools: [{ url_context: {} }]
      };
    } else if (url.trim()) {
      requestBody = {
        contents: [{
          parts: [{ text: `${prompt}\n\nLink or share text:\n${url.trim()}` }]
        }]
      };
    } else {
      throw new Error('Please paste a valid URL.');
    }
  } else {
    if (!text.trim()) throw new Error('Please paste the caption, transcript, or script.');
    const rawText = text.trim();
    const textForModel = mode === 'quick' && rawText.length > 12000
      ? `${rawText.slice(0, 12000)}\n\n[truncated for speed — core is above]`
      : rawText;
    requestBody = {
      contents: [{
        parts: [{ text: `${prompt}\n\nText:\n${textForModel}` }]
      }]
    };
  }

  const hasUploadedVideo = requestBody?.contents?.[0]?.parts?.some((p) => p.file_data?.file_uri);
  const data = await callGemini(requestBody, mode, { isVideo: sourceType === 'video-file' || hasUploadedVideo });
  const result = normalizeResult(parseModelJson(extractModelText(data)));
  client.usageCount += 1;
  client.lastAnalysis = {
    id: analysisId || new Date().toISOString(),
    createdAt: new Date().toISOString(),
    platform,
    mode,
    sourceType,
    sourceLabel: sourceType,
    viral_score: result.viral_score,
    summary: result.summary,
    strengths: result.strengths,
    risks: result.risks,
    suggestions: result.suggestions
  };
  client.history = [normalizeHistoryEntry({
    id: client.lastAnalysis.id,
    ...client.lastAnalysis,
    result
  }), ...((client.history || []).map(normalizeHistoryEntry))].slice(0, 8);
  await saveServerState();
  return {
    result,
    usageCount: client.usageCount,
    accessUnlocked: client.accessUnlocked,
    freeLimit
  };
}

async function getClientStatus(clientId) {
  const serverState = await loadServerState();
  const client = getClientRecord(serverState, clientId);
  return {
    clientId: normalizeClientId(clientId),
    usageCount: client.usageCount,
    accessUnlocked: client.accessUnlocked,
    lastSeenAt: client.lastSeenAt,
    lastAnalysis: client.lastAnalysis || null
  };
}

async function unlockClientAccess(clientId, method = 'stars') {
  const serverState = await loadServerState();
  const client = getClientRecord(serverState, clientId);
  client.accessUnlocked = true;
  client.lastPaymentMethod = method;
  client.lastSeenAt = new Date().toISOString();
  await saveServerState();
  return {
    clientId: normalizeClientId(clientId),
    accessUnlocked: true,
    usageCount: client.usageCount,
    lastPaymentMethod: method
  };
}

async function getPaymentPayload(clientId, method = 'stars') {
  return {
    clientId: normalizeClientId(clientId),
    method: String(method || 'stars'),
    payload: buildPaymentPayload(clientId, method)
  };
}

async function createStarsInvoiceLink({ clientId, title, description, stars }) {
  if (!BOT_TOKEN) {
    const error = new Error('BOT_TOKEN is not configured on the server.');
    error.statusCode = 500;
    throw error;
  }

  const normalizedClientId = normalizeClientId(clientId);
  if (!normalizedClientId) {
    const error = new Error('clientId is required.');
    error.statusCode = 400;
    throw error;
  }

  const amount = Math.max(1, Math.min(25000, Math.round(Number(stars) || 0)));
  const invoiceTitle = String(title || 'Viral Score access').trim().slice(0, 32) || 'Viral Score access';
  const invoiceDescription = String(description || 'Unlock unlimited analyses in Viral Score.').trim().slice(0, 255) || 'Unlock unlimited analyses in Viral Score.';
  const payload = buildPaymentPayload(normalizedClientId, 'stars');
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: invoiceTitle,
      description: invoiceDescription,
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Access', amount }]
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok || !data.result) {
    const error = new Error(data?.description || `Telegram createInvoiceLink failed with status ${response.status}.`);
    error.statusCode = 502;
    throw error;
  }

  return {
    clientId: normalizedClientId,
    method: 'stars',
    invoiceLink: data.result,
    payload,
    stars: amount
  };
}

async function handleTelegramUpdate(update) {
  const payment = update?.message?.successful_payment;
  if (!payment) {
    return { ok: true, handled: false };
  }
  const clientId = extractClientIdFromPayload(payment.invoice_payload);
  if (!clientId) {
    return { ok: false, error: 'Missing client payload in successful payment.' };
  }
  const unlocked = await unlockClientAccess(clientId, 'stars');
  return { ok: true, handled: true, ...unlocked };
}

async function getClientHistory(clientId) {
  const serverState = await loadServerState();
  const client = getClientRecord(serverState, clientId);
  return {
    clientId: normalizeClientId(clientId),
    history: Array.isArray(client.history) ? client.history.map(normalizeHistoryEntry) : []
  };
}

async function serveFile(res, filePath, contentType) {
  const contents = await readFile(filePath);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(contents);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return serveFile(res, INDEX_PATH, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/BACKEND_CONTRACT.md') {
      return serveFile(res, CONTRACT_PATH, 'text/markdown; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        geminiConfigured: Boolean(GEMINI_API_KEY),
        botConfigured: Boolean(BOT_TOKEN),
        blobConfigured: false,
        directUploadFallback: true
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const clientId = url.searchParams.get('clientId');
      return sendJson(res, 200, await getClientStatus(clientId));
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const clientId = url.searchParams.get('clientId');
      return sendJson(res, 200, await getClientHistory(clientId));
    }
    if (req.method === 'GET' && url.pathname === '/api/payment-payload') {
      const clientId = url.searchParams.get('clientId');
      const method = url.searchParams.get('method') || 'stars';
      return sendJson(res, 200, await getPaymentPayload(clientId, method));
    }
    if (req.method === 'POST' && url.pathname === '/api/stars-invoice-link') {
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: Readable.toWeb(req),
        duplex: 'half'
      });
      const body = await request.json().catch(() => ({}));
      return sendJson(res, 200, await createStarsInvoiceLink(body || {}));
    }
    if (req.method === 'POST' && url.pathname === '/api/unlock') {
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: Readable.toWeb(req),
        duplex: 'half'
      });
      const body = await request.json().catch(() => ({}));
      const clientId = normalizeClientId(body?.clientId);
      if (!clientId) {
        return sendJson(res, 400, { error: 'clientId is required.' });
      }
      return sendJson(res, 200, await unlockClientAccess(clientId, body?.method));
    }
    if (req.method === 'POST' && url.pathname === '/api/telegram-webhook') {
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: Readable.toWeb(req),
        duplex: 'half'
      });
      const update = await request.json().catch(() => ({}));
      return sendJson(res, 200, await handleTelegramUpdate(update));
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      if (!GEMINI_API_KEY) {
        return sendJson(res, 500, { error: 'GEMINI_API_KEY is not configured on the server.' });
      }
      const chunks = [];
      await new Promise((resolve, reject) => {
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', resolve);
        req.on('error', reject);
      });
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks)
      });
      const formData = await request.formData();
      const result = await analyzeMultipart(formData);
      return sendJson(res, 200, result);
    }

    return sendText(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Viral Score backend running on http://${HOST}:${PORT}`);
});
