import { Readable } from 'node:stream';
import { del } from '@vercel/blob';
import { handleUpload, generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import {
  ensureClientRecord,
  saveClient,
  normalizeClientId,
  isKvConfigured,
  getStoreBackend
} from '../lib/client-store.js';
import { assertRateLimit } from '../lib/rate-limit.js';
import {
  hasPremiumAccess,
  shouldBillFreeAnalysis
} from '../lib/developer-access.js';

export const maxDuration = 300;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const UNLOCK_SECRET = process.env.UNLOCK_SECRET || '';
const BOT_USERNAME = process.env.BOT_USERNAME || 'viral_score_bot';
const VK_APP_ID = process.env.VK_APP_ID || '';
const VK_APP_SECRET = process.env.VK_APP_SECRET || '';

// Temporary store for Telegram video file_ids (clientId → {fileId, mimeType, ts})
const tgVideoStore = new Map();
// Gemini resumable upload URLs keyed by session id (avoids huge X-Upload-Url headers on /api/upload-chunk)
const geminiUploadSessionStore = new Map();
function storeGeminiUploadSession(sessionId, uploadUrl) {
  geminiUploadSessionStore.set(sessionId, { uploadUrl, ts: Date.now() });
  for (const [k, v] of geminiUploadSessionStore) {
    if (Date.now() - v.ts > 60 * 60 * 1000) geminiUploadSessionStore.delete(k);
  }
}
function storeTgVideo(clientId, fileId, mimeType) {
  tgVideoStore.set(clientId, { fileId, mimeType: mimeType || 'video/mp4', ts: Date.now() });
  // Clean up entries older than 30 minutes
  for (const [k, v] of tgVideoStore) {
    if (Date.now() - v.ts > 30 * 60 * 1000) tgVideoStore.delete(k);
  }
}
async function downloadTgFile(fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!infoRes.ok) throw new Error(`getFile failed: ${infoRes.status}`);
  const info = await infoRes.json();
  const filePath = info?.result?.file_path;
  if (!filePath) throw new Error('No file_path from Telegram');
  const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
  if (!fileRes.ok) throw new Error(`Download failed: ${fileRes.status}`);
  return { buffer: Buffer.from(await fileRes.arrayBuffer()), filePath };
}
// All models below are confirmed available on the (paid) key, 1M input context.
// Tiered strategy spreads load across distinct capacity pools so a single model's
// "high demand" spike never breaks the request.
// Text: lite first for speed, then flash + latest alias, then pro.
const MODEL_CANDIDATES = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-pro'];
// Video primary: fast + high quality, with the latest-alias pool as immediate second pool.
const MODEL_CANDIDATES_VIDEO = ['gemini-2.5-flash', 'gemini-flash-latest'];
/** Recovery on high demand: stronger pro tier (separate capacity, rarely overloaded). */
const MODEL_CANDIDATES_VIDEO_RECOVERY = ['gemini-2.5-pro', 'gemini-pro-latest'];

function isUnavailableModelError(message) {
  const text = String(message || '').toLowerCase();
  return /no longer available|not found|deprecated|does not exist|is not supported|404/.test(text);
}

function isRetryableGeminiError(message, status) {
  const text = String(message || '').toLowerCase();
  const code = Number(status);
  if ([429, 500, 503, 529].includes(code)) return true;
  return /high demand|overloaded|resource exhausted|rate limit|too many requests|try again later|temporarily unavailable|service unavailable|quota exceeded|capacity/.test(text);
}

/** Uploaded Gemini file is gone (expired / already cleaned up / wrong key). Retrying other models won't help. */
function isMissingFileError(message) {
  const text = String(message || '').toLowerCase();
  return /permission to access the file|file .*may not exist|may not exist|file .*(not found|does not exist)/.test(text);
}

function userFacingGeminiError(error) {
  const msg = String(error?.message || error || '');
  if (isMissingFileError(msg)) {
    return 'The uploaded video is no longer available on the AI server (it expired or was already used). Please re-upload the video and try again.';
  }
  if (isRetryableGeminiError(msg)) {
    return 'Gemini is temporarily overloaded. Please wait a moment and try again.';
  }
  return msg || 'Analysis failed.';
}

// Text: short retries. Video: lean retries + recovery pass before text-only fallback.
// Speed: model diversity (across passes) does the heavy lifting, so per-model retries stay small.
const GEMINI_RETRY_DELAYS_MS = [400, 900];
const GEMINI_VIDEO_RETRY_DELAYS_MS = [1200, 3000];
const GEMINI_VIDEO_RECOVERY_RETRY_DELAYS_MS = [2500, 5000];
const GEMINI_MAX_ATTEMPTS_PER_MODEL = 2;
const GEMINI_MAX_VIDEO_ATTEMPTS_PER_MODEL = 2;
const GEMINI_VIDEO_RECOVERY_PAUSE_MS = 3500;
/** Overall wall-clock budget for the video pipeline; past this we skip to fast degraded text. */
const GEMINI_VIDEO_PIPELINE_BUDGET_MS = 225000;

function requestUsesTools(requestBody) {
  return Array.isArray(requestBody?.tools) && requestBody.tools.length > 0;
}

const JSON_OUTPUT_HINT = 'Return ONLY one valid JSON object with keys: viral_score, hook_strength, retention_score, clarity_score, shareability_score, cta_score, platform_fit_score, first_three_seconds_score, strengths, risks, suggestions, next_actions, summary, hook_insight, retention_insight, shareability_insight, platform_fit_insight, improved_hook, improved_caption, improved_cta. No markdown fences or commentary.';

function withJsonOutputHint(requestBody) {
  if (!requestUsesTools(requestBody)) return requestBody;
  const body = JSON.parse(JSON.stringify(requestBody));
  const parts = body.contents?.[0]?.parts;
  if (!Array.isArray(parts) || !parts.length) return body;
  const textPart = [...parts].reverse().find((part) => typeof part?.text === 'string');
  if (textPart) {
    textPart.text = `${textPart.text}\n\n${JSON_OUTPUT_HINT}`;
  } else {
    parts.push({ text: JSON_OUTPUT_HINT });
  }
  return body;
}

function buildGenerationConfig({ temperature, topP, maxOutputTokens, usesTools, plainText }) {
  const generationConfig = { temperature, topP, maxOutputTokens };
  if (!usesTools && !plainText) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = ANALYSIS_SCHEMA;
  }
  return generationConfig;
}
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
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(text);
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
    summary: String(raw?.summary || '').trim(),
    hook_insight: String(raw?.hook_insight || '').trim(),
    retention_insight: String(raw?.retention_insight || '').trim(),
    shareability_insight: String(raw?.shareability_insight || '').trim(),
    platform_fit_insight: String(raw?.platform_fit_insight || '').trim(),
    improved_hook: String(raw?.improved_hook || '').trim(),
    improved_caption: String(raw?.improved_caption || '').trim(),
    improved_cta: String(raw?.improved_cta || '').trim()
  };
}

function normalizeAnalysisId(value) {
  const text = String(value || '').trim();
  return text.slice(0, 128);
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
  const modeGuides = russian
    ? {
        quick: 'Дай короткую, понятную оценку для автора с практичными правками.',
        pro: 'Дай подробный creator-анализ с максимально конкретными действиями.',
        ad: 'Оцени как рекламный креатив: важнее всего хук, удержание, ясность, убеждение и конверсия.'
      }
    : {
        quick: 'Give a crisp, creator-friendly assessment with practical fixes.',
        pro: 'Give a detailed creator analysis with strong actionability.',
        ad: 'Evaluate like a paid creative: hook, retention, clarity, persuasion, and conversion matter most.'
      };
  const sourceGuides = russian
    ? {
        'video-file': 'Анализируй само загруженное видео. Сфокусируйся на первых секундах, темпе, визуальной ясности, тексте на экране, эмоции и шеринге. Если ролик длинный — смотри в первую очередь первые 30–45 секунд.',
        'video-url': 'Анализируй публичное видео или страницу по ссылке. Если URL context доступен, используй его; иначе опирайся на ссылку и контекст пользователя.',
        'text': 'Анализируй переданный текст, caption, транскрипт или сценарий как концепт поста.'
      }
    : {
        'video-file': 'Analyze the uploaded video itself. Focus on the opening seconds, pacing, visual clarity, on-screen text, emotion, and shareability. If the clip is long, prioritize the first 30–45 seconds only.',
        'video-url': 'Analyze the linked public video or page. If URL context is available, use it; otherwise reason from the URL and provided context.',
        'text': 'Analyze the supplied text, caption, transcript, or script as a post concept.'
      };
  return [
    russian ? `Ты senior-стратег коротких видео для ${platform}. Отвечай на русском языке.` : `You are a senior short-form content strategist for ${platform}.`,
    modeGuides[mode] || modeGuides.pro,
    sourceGuides[sourceType] || sourceGuides.text,
    russian ? 'Верни только валидный JSON по заданной схеме. Все оценки должны быть целыми числами от 0 до 100.' : 'Return only valid JSON that matches the provided schema. All scores must be integers from 0 to 100.',
    russian ? 'Все текстовые поля должны быть короткими: одна фраза для insight, максимум 4 suggestions, без markdown.' : 'Keep every text field short: one sentence for insights, no more than 4 suggestions, no markdown.',
    russian ? 'Массивы strengths и risks обязательны: в каждом минимум 2 конкретных пункта, не оставляй пустыми.' : 'strengths and risks are required: include at least 2 specific items in each array, never leave them empty.',
    russian ? 'Рекомендации должны улучшать удержание, шеры и клики.' : 'Base recommendations on what most improves watch time, shares, and click-through.',
    russian
      ? 'Все строковые поля JSON (summary, hook_insight, retention_insight, shareability_insight, platform_fit_insight, strengths, risks, suggestions, next_actions, improved_hook, improved_caption, improved_cta) пиши только на русском — без английских фраз.'
      : 'Write every string field in the JSON (summary, insights, strengths, risks, suggestions, next_actions, improved_*) in English only — no mixed languages.'
  ].join(' ');
}

async function translateAnalysisResult(result, language) {
  const russian = language === 'ru';
  const instruction = russian
    ? 'Переведи на русский язык все текстовые поля в JSON ниже. Числовые оценки (0–100) не меняй. Верни только валидный JSON той же структуры.'
    : 'Translate all text fields in the JSON below to English. Do not change numeric scores (0–100). Return only valid JSON with the same structure.';
  const requestBody = {
    contents: [{
      parts: [{ text: `${instruction}\n\n${JSON.stringify(result)}` }]
    }]
  };
  const data = await callGemini(requestBody, 'quick', { isVideo: false });
  return normalizeResult(parseModelJson(extractModelText(data)));
}

const ANALYSIS_ASK_MAX_QUESTION = 600;
const ANALYSIS_ASK_MAX_HISTORY = 6;

function compactAnalysisForAsk(result, meta = {}) {
  return {
    viral_score: result.viral_score,
    scores: {
      hook_strength: result.hook_strength,
      retention_score: result.retention_score,
      clarity_score: result.clarity_score,
      shareability_score: result.shareability_score,
      cta_score: result.cta_score,
      platform_fit_score: result.platform_fit_score,
      first_three_seconds_score: result.first_three_seconds_score
    },
    summary: result.summary,
    insights: {
      hook: result.hook_insight,
      retention: result.retention_insight,
      shareability: result.shareability_insight,
      platform_fit: result.platform_fit_insight
    },
    strengths: result.strengths,
    risks: result.risks,
    suggestions: result.suggestions,
    next_actions: result.next_actions,
    improved_hook: result.improved_hook,
    improved_caption: result.improved_caption,
    improved_cta: result.improved_cta,
    context: {
      platform: meta.platform || '',
      mode: meta.mode || '',
      sourceType: meta.sourceType || '',
      sourceLabel: meta.sourceLabel || '',
      analysisDegraded: Boolean(meta.analysisDegraded)
    }
  };
}

function buildAnalysisAskSystemPrompt(language) {
  const russian = language === 'ru';
  return russian
    ? [
      'Ты помощник Viral Score после анализа контента.',
      'Отвечай ТОЛЬКО на вопросы про этот конкретный ролик/пост и его разбор (хук, удержание, закадровый текст, caption, CTA, превью, хештеги, структура, монтаж, первые секунды).',
      'Не веди общий чат, не отвечай на оффтоп (погода, код, другие темы). Если вопрос не про контент — вежливо откажи одной фразой и предложи переформулировать.',
      'Давай готовые формулировки, которые можно сразу снять/вставить. Без markdown-заголовков. Коротко: 2–6 предложений или маркированный список до 5 пунктов.',
      'Язык ответа: русский.'
    ].join(' ')
    : [
      'You are the Viral Score assistant after a content analysis.',
      'Answer ONLY questions about this specific piece of content and its report (hook, retention, voiceover script, caption, CTA, thumbnail, hashtags, structure, edit, opening seconds).',
      'No general chat or off-topic answers. If the question is unrelated, politely refuse in one sentence and ask to rephrase.',
      'Give ready-to-use copy the creator can film or paste. No markdown headings. Keep answers short: 2–6 sentences or up to 5 bullet points.',
      'Reply in English.'
    ].join(' ');
}

async function askAboutAnalysis({ question, result, meta, language, history }) {
  const russian = language === 'ru';
  const q = String(question || '').trim().slice(0, ANALYSIS_ASK_MAX_QUESTION);
  if (q.length < 2) {
    const error = new Error(russian ? 'Вопрос слишком короткий.' : 'Question is too short.');
    error.statusCode = 400;
    throw error;
  }
  if (!result || typeof result !== 'object') {
    const error = new Error(russian ? 'Нет результата анализа.' : 'Analysis result is required.');
    error.statusCode = 400;
    throw error;
  }
  const normalized = normalizeResult(result);
  const contextJson = JSON.stringify(compactAnalysisForAsk(normalized, meta || {}), null, 2);
  const system = buildAnalysisAskSystemPrompt(language);
  const safeHistory = Array.isArray(history) ? history : [];
  const historyLines = safeHistory.slice(-ANALYSIS_ASK_MAX_HISTORY).map((item) => {
    const speaker = item?.role === 'assistant'
      ? (russian ? 'Ассистент' : 'Assistant')
      : (russian ? 'Пользователь' : 'User');
    const text = String(item?.text || '').trim().slice(0, ANALYSIS_ASK_MAX_QUESTION);
    return text ? `${speaker}: ${text}` : '';
  }).filter(Boolean);
  const promptParts = [
    system,
    '',
    russian ? 'Контекст анализа (JSON):' : 'Analysis context (JSON):',
    contextJson
  ];
  if (historyLines.length) {
    promptParts.push('', russian ? 'Предыдущие сообщения:' : 'Previous messages:', historyLines.join('\n'));
  }
  promptParts.push(
    '',
    russian ? `Вопрос: ${q}` : `Question: ${q}`,
    '',
    russian
      ? 'Ответь обычным текстом (plain text). Не возвращай JSON и не повторяй весь отчёт целиком.'
      : 'Reply in plain text only. Do not return JSON and do not repeat the full report.'
  );
  const requestBody = {
    contents: [{ parts: [{ text: promptParts.join('\n') }] }]
  };
  const data = await callGemini(requestBody, 'quick', { isVideo: false, plainText: true });
  const answer = extractModelText(data).trim();
  if (!answer) {
    const error = new Error(russian ? 'Пустой ответ модели.' : 'Empty model response.');
    error.statusCode = 502;
    throw error;
  }
  return { answer, language: russian ? 'ru' : 'en' };
}

function isDirectVideoUrl(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.toLowerCase();
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

function buildPaymentPayload(clientId, method = 'stars') {
  return `clientId:${normalizeClientId(clientId)};method:${String(method || 'stars')}`;
}

function extractClientIdFromPayload(payload) {
  if (!payload) return '';
  const text = String(payload).trim();
  if (text.includes(';')) {
    const match = text.split(';').find(part => part.startsWith('clientId:'));
    if (match) return normalizeClientId(match.slice('clientId:'.length));
  }
  if (text.startsWith('clientId:')) {
    return normalizeClientId(text.slice('clientId:'.length));
  }
  return normalizeClientId(text);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Poll Gemini file state: immediate first check, then backoff up to ~2.8s (faster than fixed 2s). */
async function waitGeminiFileProcessed(uploadName, mimeType, partial = {}, maxWaitMs = 120000) {
  let state = partial.state || 'ACTIVE';
  if (!uploadName || state === 'ACTIVE') {
    return { ...partial, mimeType: mimeType || partial.mimeType, state: 'ACTIVE' };
  }
  const started = Date.now();
  let delayMs = 0;
  while (Date.now() - started < maxWaitMs) {
    if (delayMs) await sleep(delayMs);
    delayMs = delayMs ? Math.min(Math.round(delayMs * 1.55), 2800) : 400;
    const statusUrl = geminiFileStatusUrl(uploadName);
    if (!statusUrl) break;
    const statusResponse = await fetch(statusUrl);
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

/** Gemini expects path /v1beta/files/ID — do not encode the slash as %2F. */
function normalizeGeminiFileResource(nameOrUri) {
  const fromPath = geminiFileResourcePath(nameOrUri);
  if (fromPath) return fromPath;
  const s = String(nameOrUri || '').trim();
  if (!s) return '';
  if (/^files\/[^/?]+/i.test(s)) return s.split('?')[0];
  if (/^file:/i.test(s)) return `files/${s.slice(5).replace(/^\/+/, '')}`;
  if (!s.includes('/')) return `files/${s}`;
  return s.replace(/^files?\//i, 'files/');
}

function geminiFileStatusUrl(resourcePath) {
  const resource = normalizeGeminiFileResource(resourcePath);
  if (!resource) return '';
  return `https://generativelanguage.googleapis.com/v1beta/${resource}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
}

async function getApiError(response, fallback) {
  try {
    const data = await response.clone().json();
    // Handle both {error: "string"} and {error: {message: "string"}} formats
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

async function deleteGeminiFile(fileUri) {
  const resource = geminiFileResourcePath(fileUri);
  if (!resource) return { ok: false, skipped: true };
  if (!GEMINI_API_KEY) return { ok: false, skipped: true };
  const deleteRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${resource}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': GEMINI_API_KEY }
  });
  if (!deleteRes.ok && deleteRes.status !== 404) {
    throw new Error(await getApiError(deleteRes, `Gemini delete failed: ${deleteRes.status}`));
  }
  return { ok: true, resource };
}

async function cleanupTransientUploadArtifacts({ fileUri = '', videoBlobUrl = '' } = {}) {
  const results = { gemini: null, blob: null };
  const tasks = [];
  if (fileUri) {
    tasks.push((async () => {
      try {
        results.gemini = await deleteGeminiFile(fileUri);
      } catch (error) {
        results.gemini = { ok: false, error: error?.message || 'Gemini delete failed.' };
      }
    })());
  }
  if (videoBlobUrl) {
    if (!BLOB_READ_WRITE_TOKEN) {
      results.blob = { ok: false, skipped: true };
    } else {
      tasks.push((async () => {
        try {
          await del(videoBlobUrl);
          results.blob = { ok: true };
        } catch (error) {
          results.blob = { ok: false, error: error?.message || 'Blob delete failed.' };
        }
      })());
    }
  }
  await Promise.all(tasks);
  return results;
}

async function uploadVideoFile(file) {
  const body = file?.body || file;
  const fileName = file?.name || 'video.mp4';
  // Normalize content-type: if octet-stream, infer from extension
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

const BLOB_TO_GEMINI_CHUNK_BYTES = 8 * 1024 * 1024;

function inferMimeTypeFromBlobUrl(videoUrl, contentTypeHeader = '') {
  const ct = contentTypeHeader || 'video/mp4';
  if (ct !== 'application/octet-stream') return ct.split(';')[0].trim() || 'video/mp4';
  const lower = videoUrl.toLowerCase();
  if (lower.includes('.mov')) return 'video/quicktime';
  if (lower.includes('.webm')) return 'video/webm';
  return 'video/mp4';
}

function displayNameFromBlobUrl(videoUrl) {
  try { return new URL(videoUrl).pathname.split('/').filter(Boolean).pop() || 'video.mp4'; }
  catch { return 'video.mp4'; }
}

async function startGeminiResumableUpload(fileName, mimeType, contentLength) {
  const startResponse = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(contentLength),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: fileName } })
  });
  if (!startResponse.ok) {
    throw new Error(await getApiError(startResponse, `Upload start failed: ${startResponse.status}`));
  }
  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini did not return an upload URL.');
  return uploadUrl;
}

async function uploadVideoFromBlobUrlChunked(videoUrl, totalSize, mimeType, fileName, options = {}) {
  const waitForActive = options.waitForActive !== false;
  const maxWaitMs = Number(options.maxWaitMs) || 90000;
  const uploadUrl = await startGeminiResumableUpload(fileName, mimeType, totalSize);
  let offset = 0;
  let uploadedFile = null;
  while (offset < totalSize) {
    const end = Math.min(offset + BLOB_TO_GEMINI_CHUNK_BYTES - 1, totalSize - 1);
    const rangeRes = await fetch(videoUrl, { headers: { Range: `bytes=${offset}-${end}` } });
    if (!rangeRes.ok && rangeRes.status !== 206) {
      throw new Error(`Could not read video chunk from storage: ${rangeRes.status}`);
    }
    const chunk = Buffer.from(await rangeRes.arrayBuffer());
    const isLast = end >= totalSize - 1;
    const command = isLast ? 'upload, finalize' : 'upload';
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': String(offset),
        'X-Goog-Upload-Command': command,
        'Content-Length': String(chunk.length)
      },
      body: chunk
    });
    if (!uploadResponse.ok) {
      throw new Error(await getApiError(uploadResponse, `File upload to Gemini failed: ${uploadResponse.status}`));
    }
    if (isLast) {
      const text = await uploadResponse.text();
      if (text) {
        const uploadData = JSON.parse(text);
        uploadedFile = uploadData.file || uploadData;
      }
    }
    offset = end + 1;
  }
  if (!uploadedFile?.uri) throw new Error('Missing file URI from Gemini after Blob upload.');
  const uploadName = uploadedFile.name;
  if (waitForActive && uploadName && uploadedFile.state !== 'ACTIVE') {
    return waitGeminiFileProcessed(uploadName, mimeType, uploadedFile, maxWaitMs);
  }
  return { ...uploadedFile, mimeType };
}

/** Blob/CDN URL → Gemini (chunked when size known; keeps /api/analyze under Vercel maxDuration). */
async function uploadVideoFromBlobUrl(videoUrl, options = {}) {
  const waitForActive = options.waitForActive !== false;
  const maxWaitMs = Number(options.maxWaitMs) || 90000;
  const fileName = displayNameFromBlobUrl(videoUrl);
  let mimeType = 'video/mp4';
  let totalSize = 0;
  try {
    const headRes = await fetch(videoUrl, { method: 'HEAD' });
    if (headRes.ok) {
      totalSize = Number(headRes.headers.get('content-length') || 0);
      mimeType = inferMimeTypeFromBlobUrl(videoUrl, headRes.headers.get('content-type') || '');
    }
  } catch {
    // HEAD may be blocked; fall back to full download below.
  }
  if (totalSize > BLOB_TO_GEMINI_CHUNK_BYTES) {
    try {
      return await uploadVideoFromBlobUrlChunked(videoUrl, totalSize, mimeType, fileName, { waitForActive, maxWaitMs });
    } catch (chunkErr) {
      console.warn('Chunked Blob→Gemini failed, trying single request:', chunkErr?.message || chunkErr);
    }
  }
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) throw new Error(`Could not fetch video from storage: ${videoResponse.status}`);
  mimeType = inferMimeTypeFromBlobUrl(videoUrl, videoResponse.headers.get('content-type') || mimeType);
  const buffer = Buffer.from(await videoResponse.arrayBuffer());
  const contentLength = buffer.length;
  const uploadUrl = await startGeminiResumableUpload(fileName, mimeType, contentLength);
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Length': String(contentLength)
    },
    body: buffer
  });
  if (!uploadResponse.ok) {
    throw new Error(await getApiError(uploadResponse, `File upload to Gemini failed: ${uploadResponse.status}`));
  }
  const uploadData = await uploadResponse.json();
  const uploadedFile = uploadData.file || uploadData;
  const uploadName = uploadedFile.name || uploadData.name;
  const fileState = uploadedFile.state || 'ACTIVE';
  if (waitForActive && uploadName && fileState !== 'ACTIVE') {
    return waitGeminiFileProcessed(uploadName, mimeType, uploadedFile, maxWaitMs);
  }
  return { ...uploadedFile, mimeType };
}

const GEMINI_GENERATE_TIMEOUT_MS = 90000;
const GEMINI_VIDEO_GENERATE_TIMEOUT_MS = 130000;

function shouldUseTextFallback(error) {
  const msg = String(error?.message || error || '');
  return /timed out|timeout/i.test(msg) || isRetryableGeminiError(msg);
}

function buildTextOnlyFallbackBody({ prompt, context, language, platform, url, text, reason }) {
  const russian = language === 'ru';
  const reasonNote = reason === 'overload'
    ? (russian
      ? 'Полный просмотр видео через Gemini сейчас недоступен (перегрузка API). Дай оценку по тексту, ссылке и контексту ниже + best practices для коротких роликов. В summary явно укажи, что оценка без просмотра видео.'
      : 'Full Gemini video scan is unavailable right now (API capacity). Score from text, link, and context below plus short-form best practices. State clearly in summary that the score is without watching the video.')
    : (russian
      ? 'Полный просмотр видео не успел завершиться в срок. Дай осторожную оценку по контексту и best practices; в summary укажи, что разбор видео был усечён по времени.'
      : 'Full video scan timed out. Give a conservative score using context and short-form best practices; note in summary that the video scan was time-limited.');
  const chunks = [prompt, `[${reasonNote}]`];
  if (context) chunks.push(russian ? `Контекст:\n${context}` : `Context:\n${context}`);
  if (text?.trim()) chunks.push(russian ? `Текст:\n${text.trim()}` : `Text:\n${text.trim()}`);
  if (url?.trim()) chunks.push(russian ? `Ссылка:\n${url.trim()}` : `Link:\n${url.trim()}`);
  if (platform) chunks.push(russian ? `Платформа: ${platform}` : `Platform: ${platform}`);
  return {
    contents: [{
      parts: [{ text: chunks.filter(Boolean).join('\n\n') }]
    }]
  };
}

async function runTextFallbackGemini({ prompt, context, language, platform, url, text, reason }) {
  const fallbackBody = buildTextOnlyFallbackBody({ prompt, context, language, platform, url, text, reason });
  return callGemini(fallbackBody, 'quick', { isVideo: false, liteOnly: true });
}

async function callGemini(requestBody, mode = 'pro', options = {}) {
  const isVideo = options.isVideo === true;
  const liteOnly = options.liteOnly === true;
  const plainText = options.plainText === true;
  const recoveryPass = options.recoveryPass === true;
  const quick = mode === 'quick' || isVideo;
  const ad = mode === 'ad';
  const temperature = quick ? 0.22 : ad ? 0.34 : 0.36;
  const maxOutputTokens = isVideo ? 3072 : (quick ? 3072 : 4096);
  const modelsOverride = Array.isArray(options.modelsOverride) && options.modelsOverride.length
    ? options.modelsOverride
    : null;
  const models = liteOnly
    ? ['gemini-2.5-flash-lite']
    : (modelsOverride
      || (isVideo
        ? MODEL_CANDIDATES_VIDEO
        : (quick ? MODEL_CANDIDATES.slice(0, 2) : MODEL_CANDIDATES)));
  const maxAttempts = liteOnly ? 1 : (isVideo ? GEMINI_MAX_VIDEO_ATTEMPTS_PER_MODEL : GEMINI_MAX_ATTEMPTS_PER_MODEL);
  const retryDelays = recoveryPass
    ? GEMINI_VIDEO_RECOVERY_RETRY_DELAYS_MS
    : (isVideo ? GEMINI_VIDEO_RETRY_DELAYS_MS : GEMINI_RETRY_DELAYS_MS);
  const timeoutMs = isVideo ? GEMINI_VIDEO_GENERATE_TIMEOUT_MS : GEMINI_GENERATE_TIMEOUT_MS;
  const usesTools = requestUsesTools(requestBody);
  const geminiBody = usesTools ? withJsonOutputHint(requestBody) : requestBody;
  let lastError = null;
  for (const model of models) {
    let skipModel = false;
    const tokenCaps = maxOutputTokens >= 4096 ? [maxOutputTokens] : [maxOutputTokens, 4096];
    for (let capIdx = 0; capIdx < tokenCaps.length; capIdx += 1) {
      if (skipModel) break;
      const tokenCap = tokenCaps[capIdx];
      // Only escalate to the next token cap when a response was cut off (MAX_TOKENS).
      let escalateTokens = false;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const generationConfig = buildGenerationConfig({
            temperature,
            topP: 0.92,
            maxOutputTokens: tokenCap,
            usesTools,
            plainText
          });
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({
              ...geminiBody,
              generationConfig
            })
          });
          if (response.ok) {
            const data = await response.json();
            const finishReason = data?.candidates?.[0]?.finishReason;
            if (finishReason === 'MAX_TOKENS' && tokenCap < 4096) {
              lastError = new Error(`Model ${model} response was cut off.`);
              escalateTokens = true;
              break;
            }
            return data;
          }
          const status = response.status;
          const errMsg = await getApiError(response, `Model ${model} failed: ${status}`);
          lastError = new Error(errMsg);
          if (isMissingFileError(errMsg)) {
            const fileError = new Error(errMsg);
            fileError.code = 'UPLOADED_FILE_MISSING';
            throw fileError;
          }
          if (isUnavailableModelError(errMsg)) {
            skipModel = true;
            break;
          }
          if (!liteOnly && isRetryableGeminiError(errMsg, status) && attempt < maxAttempts - 1) {
            await sleep(retryDelays[attempt] ?? (isVideo ? 5000 : 900));
            continue;
          }
          break;
        } catch (error) {
          if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            lastError = new Error(`Model ${model} timed out after ${Math.round(timeoutMs / 1000)}s.`);
            break;
          }
          throw error;
        }
      }
      // A higher token cap only helps for MAX_TOKENS cutoffs, not overload/timeout/errors.
      if (!escalateTokens) break;
    }
  }
  throw lastError || new Error('All Gemini models failed.');
}

async function ensureGeminiFileActive(fileUri, mimeType, maxWaitMs = 45000) {
  const resource = geminiFileResourcePath(fileUri);
  if (!resource) return { uri: fileUri, mimeType };
  const statusUrl = geminiFileStatusUrl(resource);
  if (!statusUrl) return { uri: fileUri, mimeType };
  const statusResponse = await fetch(statusUrl);
  if (!statusResponse.ok) return { uri: fileUri, mimeType };
  const meta = await statusResponse.json();
  if (!meta.state || meta.state === 'ACTIVE') {
    return { uri: meta.uri || fileUri, mimeType: mimeType || meta.mimeType };
  }
  if (meta.state === 'FAILED') throw new Error('Video processing failed on Gemini.');
  return waitGeminiFileProcessed(resource, mimeType, meta, maxWaitMs);
}

async function callGeminiForVideoAnalysis(requestBody, mode, fallbackCtx) {
  const startedAt = Date.now();
  const passes = [
    { label: 'primary', run: () => callGemini(requestBody, mode, { isVideo: true }) },
    {
      label: 'recovery',
      run: async () => {
        await sleep(GEMINI_VIDEO_RECOVERY_PAUSE_MS);
        return callGemini(requestBody, mode, {
          isVideo: true,
          recoveryPass: true,
          modelsOverride: MODEL_CANDIDATES_VIDEO_RECOVERY
        });
      }
    },
    {
      label: 'flash-lite',
      run: () => callGemini(requestBody, 'quick', {
        isVideo: true,
        modelsOverride: ['gemini-2.5-flash-lite', 'gemini-flash-lite-latest']
      })
    }
  ];

  let lastError = null;
  for (const pass of passes) {
    // Stay within the function budget: if time is nearly spent, skip to fast degraded text
    // so the user always gets a response instead of a hard timeout.
    if (pass.label !== 'primary' && Date.now() - startedAt > GEMINI_VIDEO_PIPELINE_BUDGET_MS) {
      console.info('[analyze] video pipeline budget exhausted, skipping', pass.label);
      break;
    }
    try {
      const data = await pass.run();
      if (pass.label !== 'primary') {
        console.info('[analyze] video Gemini succeeded on', pass.label, 'pass');
      }
      return { data, degraded: false };
    } catch (error) {
      lastError = error;
      const msg = String(error?.message || '');
      if (error?.code === 'UPLOADED_FILE_MISSING' || isMissingFileError(msg)) {
        const fileError = new Error(userFacingGeminiError(error));
        fileError.statusCode = 409;
        fileError.code = 'UPLOADED_FILE_MISSING';
        throw fileError;
      }
      // Keep going to the next pass on overload, timeout, OR an unavailable model — only a
      // genuinely fatal, non-recoverable error should abort the whole pipeline.
      const recoverable = isRetryableGeminiError(msg)
        || /timed out|timeout/i.test(msg)
        || isUnavailableModelError(msg);
      if (!recoverable) {
        throw error;
      }
      console.info('[analyze] video Gemini', pass.label, 'pass failed:', msg.slice(0, 120));
    }
  }

  if (!shouldUseTextFallback(lastError)) throw lastError;
  const reason = isRetryableGeminiError(String(lastError?.message || '')) ? 'overload' : 'timeout';
  console.info('[analyze] all video passes failed, degraded text analysis:', reason);
  const data = await runTextFallbackGemini({ ...fallbackCtx, reason });
  return { data, degraded: true, degradationReason: reason };
}

async function callGeminiWithTextFallback(requestBody, mode, fallbackCtx) {
  try {
    const data = await callGemini(requestBody, mode, { isVideo: false });
    return { data, degraded: false };
  } catch (error) {
    if (!shouldUseTextFallback(error)) throw error;
    const reason = isRetryableGeminiError(String(error?.message || '')) ? 'overload' : 'timeout';
    console.info('[analyze] Gemini unavailable, degraded text analysis:', reason, error?.message);
    const data = await runTextFallbackGemini({ ...fallbackCtx, reason });
    return { data, degraded: true, degradationReason: reason };
  }
}

function extractModelText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  if (!parts.length) throw new Error('Gemini returned an empty response.');
  const text = parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (text) return text;
  const inline = parts.find((part) => typeof part?.inlineData?.data === 'string');
  if (inline) return inline.inlineData.data.trim();
  return JSON.stringify(parts[0]);
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

/**
 * Fetch video from VK using VK API access_token, then upload to Gemini.
 */
async function fetchVkVideoAndUploadToGemini(vkUrl, accessToken) {
  const videoIdMatch = vkUrl.match(/video(-?\d+)_(\d+)/);
  if (!videoIdMatch) throw new Error('Could not parse VK video ID from URL.');
  const ownerId = videoIdMatch[1];
  const videoId = videoIdMatch[2];
  const videos = `${ownerId}_${videoId}`;
  const apiUrl = `https://api.vk.com/method/video.get?videos=${encodeURIComponent(videos)}&access_token=${encodeURIComponent(accessToken)}&v=5.131`;
  const apiRes = await fetch(apiUrl);
  if (!apiRes.ok) throw new Error(`VK API request failed: ${apiRes.status}`);
  const apiData = await apiRes.json();
  if (apiData.error) throw new Error(`VK API error: ${apiData.error.error_msg || apiData.error.error_code}`);
  const item = apiData?.response?.items?.[0];
  if (!item) throw new Error('VK API returned no video items.');
  const files = item.files || {};
  const qualityOrder = ['mp4_1080', 'mp4_720', 'mp4_480', 'mp4_360', 'mp4_240'];
  let directUrl = '';
  for (const q of qualityOrder) {
    if (files[q] && files[q].startsWith('http')) { directUrl = files[q]; break; }
  }
  if (!directUrl) throw new Error('No direct video URL in VK API response (may be private or restricted).');
  return uploadVideoFromBlobUrl(directUrl);
}

/**
 * Fetch a social video using a session cookie (Instagram/TikTok sessionid),
 * extract direct video URL from page HTML, then upload to Gemini.
 */
async function fetchSocialVideoWithCookieAndUploadToGemini(pageUrl, platform, sessionCookie) {
  const htmlRes = await fetch(pageUrl, {
    headers: {
      'Cookie': `sessionid=${sessionCookie}`,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!htmlRes.ok) throw new Error(`${platform} page fetch failed: ${htmlRes.status}`);
  const html = await htmlRes.text();
  let videoUrl = '';
  if (platform === 'instagram') {
    const m1 = html.match(/"video_url":"(https:[^"]+)"/);
    if (m1) videoUrl = m1[1].replace(/\u0026/g, '&').replace(/\\/g, '');
    if (!videoUrl) {
      const m2 = html.match(/<meta property="og:video"[^>]+content="([^"]+)"/);
      if (m2) videoUrl = m2[1];
    }
  } else if (platform === 'tiktok') {
    const m1 = html.match(/"playAddr":"(https:[^"]+)"/);
    if (m1) videoUrl = m1[1].replace(/\u0026/g, '&').replace(/\\/g, '');
    if (!videoUrl) {
      const m2 = html.match(/<meta property="og:video"[^>]+content="([^"]+)"/);
      if (m2) videoUrl = m2[1];
    }
  }
  if (!videoUrl) throw new Error(`Could not extract direct video URL from ${platform} page. Session may have expired or content is truly private.`);
  return uploadVideoFromBlobUrl(videoUrl);
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
  const prompt = String(formData.get('prompt') || getPromptBase({ platform, mode, sourceType, language, context }));
  const video = formData.get('video');
  const url = String(formData.get('url') || '');
  const text = String(formData.get('text') || '');
  const socialPlatform = String(formData.get('socialPlatform') || '').toLowerCase().trim(); // 'vk' | 'instagram' | 'tiktok'
  const socialToken = String(formData.get('socialToken') || '').trim(); // access_token or session cookie

  const client = await ensureClientRecord(clientId);
  if (!client) throw new Error('clientId is required.');
  await assertRateLimit(clientId, 'analyze');
  client.lastSeenAt = new Date().toISOString();

  if (!hasPremiumAccess(client, clientId) && freeLimit > 0 && client.usageCount >= freeLimit) {
    const error = new Error('Free quota ended.');
    error.statusCode = 402;
    throw error;
  }

  if (analysisId && client.analysisIds.has(analysisId) && client.lastAnalysis?.result) {
    await saveClient(client);
    return {
      result: client.lastAnalysis.result,
      usageCount: client.usageCount,
      accessUnlocked: hasPremiumAccess(client, clientId),
      freeLimit
    };
  }

  let requestBody;
  let cleanupFileUri = '';
  let cleanupBlobUrl = '';
  if (sourceType === 'video-file') {
    const fileUri = String(formData.get('fileUri') || '').trim();
    const fileMimeType = String(formData.get('fileMimeType') || 'video/mp4').trim();
    const videoBlobUrl = String(formData.get('videoBlobUrl') || '').trim();
    let uploadedFile = null;
    if (fileUri) {
      uploadedFile = { uri: fileUri, mimeType: fileMimeType };
      cleanupFileUri = fileUri;
      cleanupBlobUrl = videoBlobUrl;
    } else if (videoBlobUrl) {
      throw new Error('Video is still transferring to AI. Wait a moment and tap Analyze again.');
    } else if (video && typeof video !== 'string') {
      // Last resort: file in formdata (limited to 4.5MB)
      uploadedFile = await uploadVideoFile(video);
      cleanupFileUri = uploadedFile?.uri || '';
    }
    if (!uploadedFile) throw new Error('Missing uploaded video file.');
    if (!uploadedFile.uri) throw new Error('Missing file URI. Upload may have failed.');
    uploadedFile = await ensureGeminiFileActive(uploadedFile.uri, uploadedFile.mimeType, 45000);
    requestBody = {
      contents: [{
        parts: [
          { file_data: { file_uri: uploadedFile.uri, mime_type: uploadedFile.mimeType || 'video/mp4' } },
          { text: prompt }
        ]
      }]
    };
  } else if (sourceType === 'video-url') {
    const normalizedUrl = normalizePasteableLink(url);
    if (normalizedUrl && isDirectVideoUrl(normalizedUrl)) {
      try {
        const uploadedFile = await uploadVideoFromBlobUrl(normalizedUrl, { waitForActive: false, maxWaitMs: 45000 });
        if (!uploadedFile?.uri) throw new Error('Missing uploaded file URI from direct video URL.');
        cleanupFileUri = uploadedFile.uri || '';
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
      // If user provided a social auth token, try to fetch the video content server-side
      let socialVideoUploaded = null;
      if (socialToken && (socialPlatform === 'vk' || urlPlatform === 'vk')) {
        try {
          socialVideoUploaded = await fetchVkVideoAndUploadToGemini(normalizedUrl, socialToken);
        } catch (e) {
          console.warn('VK video fetch failed, falling back to url_context:', e.message);
        }
      } else if (socialToken && (socialPlatform === 'instagram' || socialPlatform === 'tiktok' || urlPlatform === 'instagram' || urlPlatform === 'tiktok')) {
        try {
          socialVideoUploaded = await fetchSocialVideoWithCookieAndUploadToGemini(normalizedUrl, socialPlatform || urlPlatform, socialToken);
        } catch (e) {
          console.warn(`${socialPlatform || urlPlatform} cookie fetch failed, falling back to url_context:`, e.message);
        }
      }
      if (socialVideoUploaded?.uri) {
        cleanupFileUri = socialVideoUploaded.uri;
        requestBody = {
          contents: [{
            parts: [
              { file_data: { file_uri: socialVideoUploaded.uri, mime_type: socialVideoUploaded.mimeType || 'video/mp4' } },
              { text: prompt }
            ]
          }]
        };
      } else {
        const videoLinkHint = linkVideoHint(urlPlatform, mode);
        requestBody = {
          contents: [{
            parts: [{ text: `${prompt}\n\n${videoLinkHint}\n\nPublic URL:\n${normalizedUrl}` }]
          }],
          tools: [{ url_context: {} }]
        };
      }
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
  const fallbackCtx = { prompt, context, language, platform, url, text };
  const geminiResult = sourceType === 'video-file' || hasUploadedVideo
    ? await callGeminiForVideoAnalysis(requestBody, mode, fallbackCtx)
    : await callGeminiWithTextFallback(requestBody, mode, fallbackCtx);
  let data = geminiResult.data;
  const analysisDegraded = Boolean(geminiResult.degraded);
  let result;
  try {
    result = normalizeResult(parseModelJson(extractModelText(data)));
  } catch (parseError) {
    if (sourceType === 'video-url' && requestUsesTools(requestBody)) {
      const fallbackBody = {
        contents: requestBody.contents
      };
      data = await callGemini(fallbackBody, mode, { isVideo: false });
      result = normalizeResult(parseModelJson(extractModelText(data)));
    } else {
      throw parseError;
    }
  }

  if (shouldBillFreeAnalysis(client, clientId, { analysisDegraded })) {
    client.usageCount += 1;
  }
  const savedAnalysis = {
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
    suggestions: result.suggestions,
    result
  };
  client.lastAnalysis = savedAnalysis;
  client.analysisIds.add(savedAnalysis.id);
  client.history = [normalizeHistoryEntry(savedAnalysis), ...((client.history || []).map(normalizeHistoryEntry))].slice(0, 8);
  await saveClient(client);

  // Keep the uploaded file + blob when the analysis degraded, so a retry can still
  // reach the video once Gemini capacity returns. Only clean up on a real success.
  if (!analysisDegraded) {
    try {
      await cleanupTransientUploadArtifacts({
        fileUri: cleanupFileUri,
        videoBlobUrl: cleanupBlobUrl || String(formData.get('videoBlobUrl') || '').trim()
      });
    } catch (cleanupError) {
      console.warn('Transient upload cleanup failed:', cleanupError);
    }
  }

  return {
    result,
    usageCount: client.usageCount,
    accessUnlocked: hasPremiumAccess(client, clientId),
    freeLimit,
    analysisDegraded,
    degradationReason: geminiResult.degradationReason || null
  };
}

async function getClientStatus(clientId) {
  const client = await ensureClientRecord(clientId);
  return {
    clientId: normalizeClientId(clientId),
    usageCount: client?.usageCount || 0,
    accessUnlocked: hasPremiumAccess(client, clientId),
    lastSeenAt: client?.lastSeenAt || null,
    lastAnalysis: client?.lastAnalysis || null
  };
}

function assertUnlockAuthorized(req, body = {}) {
  if (!UNLOCK_SECRET) {
    const error = new Error('UNLOCK_SECRET is not configured on the server.');
    error.statusCode = 503;
    throw error;
  }
  const headerSecret = String(req.headers['x-unlock-secret'] || req.headers['X-Unlock-Secret'] || '').trim();
  const bodySecret = String(body?.unlockSecret || '').trim();
  if (headerSecret === UNLOCK_SECRET || bodySecret === UNLOCK_SECRET) return;
  const error = new Error('Unauthorized unlock request.');
  error.statusCode = 401;
  throw error;
}

async function unlockClientAccess(clientId, method = 'stars', options = {}) {
  const client = await ensureClientRecord(clientId);
  if (!client) throw new Error('clientId is required.');
  client.accessUnlocked = true;
  if (options.resetUsage) client.usageCount = 0;
  client.lastPaymentMethod = method;
  client.lastSeenAt = new Date().toISOString();
  await saveClient(client);
  return {
    clientId: normalizeClientId(clientId),
    accessUnlocked: true,
    usageCount: client.usageCount,
    lastPaymentMethod: method
  };
}

function getPaymentPayload(clientId, method = 'stars') {
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

async function sendTgMessage(chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra })
  });
}

async function handleTelegramUpdate(update) {
  // Telegram requires pre_checkout_query to be answered within 10s, otherwise
  // the payment is cancelled and successful_payment never fires.
  const preCheckout = update?.pre_checkout_query;
  if (preCheckout) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: preCheckout.id, ok: true })
    }).catch(() => {});
    return { ok: true, handled: true, preCheckout: true };
  }

  const payment = update?.message?.successful_payment;
  if (payment) {
    const clientId = extractClientIdFromPayload(payment.invoice_payload);
    if (!clientId) return { ok: false, error: 'Missing client payload in successful payment.' };
    const unlocked = await unlockClientAccess(clientId, 'stars');
    const chatId = update?.message?.chat?.id;
    if (chatId) {
      await sendTgMessage(chatId,
        '✅ Оплата получена! Премиум-доступ разблокирован. Вернись в приложение — все функции уже открыты.'
      ).catch(() => {});
    }
    return { ok: true, handled: true, ...unlocked };
  }

  // Handle video uploads via bot chat
  const msg = update?.message;
  if (msg) {
    const chatId = msg.chat?.id;
    // Extract video file info
    const videoObj = msg.video || msg.document;
    if (videoObj) {
      const fileId = videoObj.file_id;
      const mimeType = videoObj.mime_type || 'video/mp4';
      // Extract clientId from caption or use chatId as fallback key
      const caption = String(msg.caption || msg.text || '');
      const clientMatch = caption.match(/client[_:]?([a-zA-Z0-9_-]{8,})/i);
      const userId = msg.from?.id;
      const clientId = clientMatch
        ? clientMatch[1]
        : (userId ? `tg:${userId}` : `tg:${chatId}`);
      storeTgVideo(clientId, fileId, mimeType);
      if (userId && chatId && String(userId) !== String(chatId)) {
        storeTgVideo(`tg:${chatId}`, fileId, mimeType);
      }
      if (chatId) {
        await sendTgMessage(chatId,
          `✅ Видео получено!

Теперь вернись в приложение и нажми <b>Analyze</b> — анализ начнётся автоматически.

<i>Твой код: <code>${clientId}</code></i>`
        );
      }
      return { ok: true, handled: true, clientId, fileId };
    }

    // appss.pro catalog ownership verification: reply to the verify command
    // with the exact code shown in the appss listing draft.
    const appssVerifyCmd = (process.env.APPSS_VERIFY_COMMAND || '/appss_verify').trim();
    const appssVerifyResponse = (process.env.APPSS_VERIFY_RESPONSE || '').trim();
    if (appssVerifyResponse && msg.text) {
      const cmd = msg.text.trim().split(/\s+/)[0].split('@')[0];
      if (cmd === appssVerifyCmd) {
        if (chatId) await sendTgMessage(chatId, appssVerifyResponse, { parse_mode: undefined }).catch(() => {});
        return { ok: true, handled: true, appssVerify: true };
      }
    }

    // /start command — show instructions
    if (msg.text?.startsWith('/start')) {
      if (chatId) {
        await sendTgMessage(chatId,
          '👋 Привет! Отправь мне видео (до 2GB) и я передам его в Viral Score для анализа. После отправки вернись в приложение и нажми Analyze.'
        );
      }
      return { ok: true, handled: true };
    }
  }

  return { ok: true, handled: false };
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, url) {
  const buffer = await readRawBody(req);
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (e) {
    throw e;
  }
}

/** Buffer body first — Readable.toWeb(req) + formData() hangs on Vercel (same as blob upload). */
async function readFormData(req, url) {
  const buffer = await readRawBody(req);
  const request = new Request(url.toString(), {
    method: req.method,
    headers: req.headers,
    body: buffer
  });
  return request.formData();
}

async function handleBlobClientUpload(req, url) {
  if (!BLOB_READ_WRITE_TOKEN) {
    const error = new Error('BLOB_READ_WRITE_TOKEN is not configured on the server.');
    error.statusCode = 500;
    throw error;
  }
  // Read body once from the Node stream — Readable.toWeb(req) + request.json() can hang on Vercel.
  const body = await readJson(req, url);
  const request = new Request(url.toString(), {
    method: req.method || 'POST',
    headers: req.headers
  });
  return handleUpload({
    body,
    request,
    token: BLOB_READ_WRITE_TOKEN,
    onBeforeGenerateToken: async () => ({
      allowedContentTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'application/octet-stream'],
      addRandomSuffix: true,
      callbackUrl: `${url.origin}/api/blob/upload`
    }),
    onUploadCompleted: async ({ blob }) => {
      try { console.log('Blob upload completed:', blob?.url || ''); } catch {}
    }
  });
}

async function createBlobClientToken(req, url) {
  if (!BLOB_READ_WRITE_TOKEN) {
    const error = new Error('BLOB_READ_WRITE_TOKEN is not configured on the server.');
    error.statusCode = 500;
    throw error;
  }
  const body = await readJson(req, url).catch(() => ({}));
  const pathname = String(body?.pathname || body?.fileName || 'video.mp4')
    .trim()
    .replace(/^\/+/, '')
    .slice(0, 200) || 'video.mp4';
  const contentType = String(body?.contentType || body?.mimeType || 'video/mp4').trim() || 'video/mp4';
  const clientToken = await generateClientTokenFromReadWriteToken({
    token: BLOB_READ_WRITE_TOKEN,
    pathname,
    validUntil: new Date(Date.now() + 15 * 60 * 1000),
    addRandomSuffix: true,
    allowedContentTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'application/octet-stream'],
    onUploadCompleted: {
      callbackUrl: `${url.origin}/api/blob/upload`,
      tokenPayload: JSON.stringify({ contentType })
    }
  });
  return { clientToken, pathname, contentType };
}

export default async function handler(req, res) {
  try {
    // Reconstruct public URL from forwarded headers (Vercel sets x-forwarded-host)
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const baseUrl = host ? `${proto}://${host}` : 'https://viral-score.vercel.app';
    const url = new URL(req.url || '/', baseUrl);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Mime-Type, x-mime-type, X-File-Size, X-File-Name, X-Upload-Url, X-Upload-Session-Id, x-upload-session-id, X-Chunk-Offset, x-chunk-offset, X-Goog-Upload-Command, x-goog-upload-command'
      );
      return res.end();
    }

    if (req.method === 'GET' && path === '/api/public-config') {
      return sendJson(res, 200, {
        posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY || process.env.POSTHOG_KEY || '',
        posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'
      });
    }

    if (req.method === 'GET' && (path === '/health' || path === '/api/health')) {
      return sendJson(res, 200, {
        ok: true,
        geminiConfigured: Boolean(GEMINI_API_KEY),
        botConfigured: Boolean(BOT_TOKEN),
        blobConfigured: Boolean(BLOB_READ_WRITE_TOKEN),
        redisConfigured: isKvConfigured(),
        kvConfigured: isKvConfigured(),
        storeBackend: getStoreBackend(),
        botUsername: BOT_USERNAME || ''
      });
    }

    // ── Social Auth ─────────────────────────────────────────────────────────
    // VK OAuth2 callback: exchange code for access_token
    if (req.method === 'GET' && path === '/api/social-auth/vk-callback') {
      const code = url.searchParams.get('code') || '';
      const redirectUri = url.searchParams.get('redirect_uri') || `${baseUrl}/api/social-auth/vk-callback`;
      if (!code) return sendJson(res, 400, { error: 'code required' });
      if (!VK_APP_ID || !VK_APP_SECRET) return sendJson(res, 500, { error: 'VK_APP_ID / VK_APP_SECRET not configured.' });
      try {
        const tokenRes = await fetch(
          `https://oauth.vk.com/access_token?client_id=${encodeURIComponent(VK_APP_ID)}&client_secret=${encodeURIComponent(VK_APP_SECRET)}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`
        );
        const tokenData = await tokenRes.json();
        if (!tokenRes.ok || tokenData.error) throw new Error(tokenData.error_description || tokenData.error || 'VK OAuth failed');
        const { access_token, user_id, email } = tokenData;
        // Return token to the frontend via postMessage-friendly HTML page
        const html = `<!DOCTYPE html><html><body><script>
          const payload = ${JSON.stringify({ ok: true, platform: 'vk', access_token, user_id, email })};
          if (window.opener) { window.opener.postMessage({ type: 'social_auth_callback', ...payload }, '*'); window.close(); }
          else { document.body.textContent = JSON.stringify(payload); }
        <\/script></body></html>`;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.end(html);
      } catch (error) {
        return sendJson(res, 500, { error: error?.message || 'VK OAuth failed.' });
      }
    }

    // Return the VK OAuth authorization URL for the frontend to open
    if (req.method === 'GET' && path === '/api/social-auth/vk-url') {
      if (!VK_APP_ID) return sendJson(res, 500, { error: 'VK_APP_ID not configured.' });
      const redirectUri = `${baseUrl}/api/social-auth/vk-callback`;
      const scope = 'video,offline'; // video scope for API access
      const authUrl = `https://oauth.vk.com/authorize?client_id=${encodeURIComponent(VK_APP_ID)}&display=popup&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&response_type=code&v=5.131`;
      return sendJson(res, 200, { authUrl, redirectUri });
    }

    // Social auth status / VK video fetch test
    if (req.method === 'GET' && path === '/api/social-auth/status') {
      return sendJson(res, 200, {
        vk: { configured: Boolean(VK_APP_ID && VK_APP_SECRET) },
        instagram: { configured: true, method: 'cookie' },
        tiktok: { configured: true, method: 'cookie' }
      });
    }

    if (req.method === 'POST' && path === '/api/blob/upload') {
      try {
        return sendJson(res, 200, await handleBlobClientUpload(req, url));
      } catch (error) {
        const status = Number(error?.statusCode) || 400;
        return sendJson(res, status, { error: error?.message || 'Blob upload handler failed.' });
      }
    }

    if (req.method === 'POST' && path === '/api/blob/client-token') {
      return sendJson(res, 200, await createBlobClientToken(req, url));
    }

    if ((req.method === 'POST' || req.method === 'DELETE') && path === '/api/blob/delete') {
      if (!BLOB_READ_WRITE_TOKEN) {
        return sendJson(res, 200, { ok: true, skipped: true });
      }
      const body = req.method === 'DELETE'
        ? Object.fromEntries(url.searchParams.entries())
        : await readJson(req, url).catch(() => ({}));
      const urlToDelete = String(body?.url || body?.blobUrl || body?.pathname || '').trim();
      if (!urlToDelete) return sendJson(res, 400, { error: 'url required' });
      try {
        await del(urlToDelete);
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, 500, { error: error?.message || 'Blob delete failed.' });
      }
    }

    // Start a Gemini resumable upload session so the browser can upload
    // directly to Google without going through Vercel (no 4.5MB limit).
    if (req.method === 'POST' && path === '/api/upload-session') {
      if (!GEMINI_API_KEY) return sendJson(res, 500, { error: 'GEMINI_API_KEY is not configured.' });
      const body = await readJson(req, url).catch(() => ({}));
      const mimeType = String(body?.mimeType || 'video/mp4').trim();
      const fileSize = Number(body?.fileSize || 0);
      const fileName = String(body?.fileName || 'video.mp4').trim().slice(0, 200);
      const startRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(GEMINI_API_KEY)}`,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': GEMINI_API_KEY,
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(fileSize),
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ file: { display_name: fileName } })
        }
      );
      if (!startRes.ok) {
        return sendJson(res, 502, { error: await getApiError(startRes, `Upload session failed: ${startRes.status}`) });
      }
      const uploadUrl = startRes.headers.get('x-goog-upload-url');
      if (!uploadUrl) return sendJson(res, 502, { error: 'Gemini did not return an upload URL.' });
      const sessionId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      storeGeminiUploadSession(sessionId, uploadUrl);
      return sendJson(res, 200, { uploadUrl, uploadSessionId: sessionId, mimeType, fileName });
    }

    // Proxy one chunk of a Gemini resumable upload (keeps browser off Google; each body < Vercel limit).
    if (req.method === 'POST' && path === '/api/upload-chunk') {
      if (!GEMINI_API_KEY) return sendJson(res, 500, { error: 'GEMINI_API_KEY is not configured.' });
      const CHUNK_MAX = 2.5 * 1024 * 1024;
      const contentType = String(req.headers['content-type'] || '');
      let uploadUrl = '';
      let offset = 0;
      let command = 'upload';
      let mimeType = 'application/octet-stream';
      let buffer = Buffer.alloc(0);
      let sessionId = '';

      if (contentType.includes('application/json')) {
        const body = await readJson(req, url).catch(() => ({}));
        uploadUrl = String(body?.uploadUrl || '').trim();
        offset = Number(body?.offset || 0);
        command = String(body?.command || 'upload').trim();
        mimeType = String(body?.mimeType || 'video/mp4').trim();
        const b64 = String(body?.chunkBase64 || '');
        if (!uploadUrl || !b64) return sendJson(res, 400, { error: 'uploadUrl and chunkBase64 are required.' });
        buffer = Buffer.from(b64, 'base64');
      } else {
        sessionId = String(req.headers['x-upload-session-id'] || '').trim();
        uploadUrl = String(req.headers['x-upload-url'] || '').trim();
        if (sessionId) {
          const entry = geminiUploadSessionStore.get(sessionId);
          if (!entry) return sendJson(res, 404, { error: 'Upload session expired. Start a new upload.' });
          uploadUrl = entry.uploadUrl;
        }
        if (!uploadUrl) return sendJson(res, 400, { error: 'uploadUrl required (JSON body or X-Upload-Url header).' });
        offset = Number(req.headers['x-chunk-offset'] || 0);
        command = String(req.headers['x-goog-upload-command'] || 'upload').trim();
        mimeType = String(req.headers['x-mime-type'] || req.headers['content-type'] || 'application/octet-stream').trim();
        const chunks = [];
        await new Promise((resolve, reject) => {
          req.on('data', c => chunks.push(c));
          req.on('end', resolve);
          req.on('error', reject);
        });
        buffer = Buffer.concat(chunks);
      }

      if (!buffer.length) return sendJson(res, 400, { error: 'Empty chunk body.' });
      if (buffer.length > CHUNK_MAX) {
        return sendJson(res, 413, { error: 'Chunk too large. Use 1.5MB chunks.' });
      }
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Offset': String(offset),
          'X-Goog-Upload-Command': command,
          'Content-Length': String(buffer.length),
          'Content-Type': mimeType
        },
        body: buffer,
        signal: AbortSignal.timeout(/finalize/i.test(command) ? 120000 : 55000)
      });
      if (!uploadRes.ok) {
        return sendJson(res, 502, { error: await getApiError(uploadRes, `Gemini chunk upload failed: ${uploadRes.status}`) });
      }
      let text = await uploadRes.text();
      if (!text && /finalize/i.test(command)) {
        const queryOffset = String(offset + buffer.length);
        for (let attempt = 0; attempt < 12 && !text; attempt += 1) {
          if (attempt) await new Promise((r) => setTimeout(r, Math.min(500 + attempt * 400, 3000)));
          const queryRes = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              'X-Goog-Upload-Offset': queryOffset,
              'X-Goog-Upload-Command': 'query'
            },
            signal: AbortSignal.timeout(45000)
          });
          if (queryRes.ok) text = await queryRes.text();
        }
      }
      if (!text) {
        if (/finalize/i.test(command)) {
          return sendJson(res, 502, { error: 'Gemini finalize completed without file metadata. Retry upload.' });
        }
        return sendJson(res, 200, { ok: true, offset: offset + buffer.length });
      }
      try {
        const data = JSON.parse(text);
        const uploadedFile = data.file || data;
        const uploadName = uploadedFile?.name || data?.name;
        if (sessionId && /finalize/i.test(command)) geminiUploadSessionStore.delete(sessionId);
        return sendJson(res, 200, { file: uploadedFile, mimeType });
      } catch {
        return sendJson(res, 200, { ok: true, offset: offset + buffer.length });
      }
    }

    // Blob URL → Gemini (used after client Blob upload in Telegram / Mini App).
    if (req.method === 'POST' && path === '/api/proxy-upload') {
      if (!GEMINI_API_KEY) return sendJson(res, 500, { error: 'GEMINI_API_KEY not configured.' });
      const body = await readJson(req, url).catch(() => ({}));
      const blobUrl = String(body?.blobUrl || '').trim();
      const mimeType = String(body?.mimeType || 'video/mp4').trim();
      const fileName = String(body?.fileName || 'video.mp4').trim().slice(0, 200);
      if (!blobUrl) return sendJson(res, 400, { error: 'blobUrl required' });
      try {
        const uploadedFile = await uploadVideoFromBlobUrl(blobUrl, { waitForActive: false });
        if (!uploadedFile?.uri) return sendJson(res, 502, { error: 'Missing file URI from Gemini.' });
        return sendJson(res, 200, { file: uploadedFile, mimeType: uploadedFile.mimeType || mimeType, fileName });
      } catch (e) {
        return sendJson(res, 502, { error: e?.message || 'proxy-upload failed' });
      }
    }

    // Proxy video upload to Gemini — client POSTs raw video body here,
    // server streams it to Gemini Files API (bypasses CORS restriction).
    if (req.method === 'POST' && path === '/api/upload-video') {
      if (!GEMINI_API_KEY) return sendJson(res, 500, { error: 'GEMINI_API_KEY is not configured.' });
      const mimeType = String(req.headers['x-mime-type'] || 'video/mp4').trim();
      const declaredSize = Number(req.headers['x-file-size'] || req.headers['content-length'] || 0);
      const VERCEL_BODY_SAFE = 3 * 1024 * 1024;
      if (declaredSize > VERCEL_BODY_SAFE) {
        return sendJson(res, 413, {
          error: 'Video is too large for direct upload (Vercel 4.5MB limit). Use client Blob upload and send videoBlobUrl to /api/analyze instead.'
        });
      }
      const fileSize = String(declaredSize || '0');
      const fileName = String(req.headers['x-file-name'] || 'video.mp4').trim().slice(0, 200);
      // Step 1: start resumable upload session
      const startRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(GEMINI_API_KEY)}`,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': GEMINI_API_KEY,
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': fileSize,
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ file: { display_name: fileName } })
        }
      );
      if (!startRes.ok) return sendJson(res, 502, { error: await getApiError(startRes, `Upload start failed: ${startRes.status}`) });
      const uploadUrl = startRes.headers.get('x-goog-upload-url');
      if (!uploadUrl) return sendJson(res, 502, { error: 'Gemini did not return an upload URL.' });
      // Step 2: buffer incoming body and upload to Gemini
      const chunks = [];
      await new Promise((resolve, reject) => {
        req.on('data', c => chunks.push(c));
        req.on('end', resolve);
        req.on('error', reject);
      });
      const buffer = Buffer.concat(chunks);
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
          'Content-Length': String(buffer.length),
          'Content-Type': mimeType
        },
        body: buffer
      });
      if (!uploadRes.ok) return sendJson(res, 502, { error: await getApiError(uploadRes, `Gemini upload failed: ${uploadRes.status}`) });
      const uploadData = await uploadRes.json();
      const uploadedFile = uploadData.file || uploadData;
      const uploadName = uploadedFile?.name || uploadData?.name;
      if (uploadName && uploadedFile?.state !== 'ACTIVE') {
        const ready = await waitGeminiFileProcessed(uploadName, mimeType, uploadedFile);
        return sendJson(res, 200, { file: ready, mimeType: ready.mimeType || mimeType });
      }
      return sendJson(res, 200, { file: uploadedFile, mimeType });
    }

    // Download video from Telegram CDN and upload to Gemini
    if (req.method === 'GET' && path === '/api/tg-file') {
      if (!BOT_TOKEN) return sendJson(res, 500, { error: 'BOT_TOKEN not configured.' });
      if (!GEMINI_API_KEY) return sendJson(res, 500, { error: 'GEMINI_API_KEY not configured.' });
      const clientId = url.searchParams.get('clientId') || '';
      if (!clientId) return sendJson(res, 400, { error: 'clientId required.' });
      const altRaw = String(url.searchParams.get('altClientIds') || '');
      const lookupIds = [clientId, ...altRaw.split(',').map(s => s.trim()).filter(Boolean)];
      let entry = null;
      for (const id of lookupIds) {
        entry = tgVideoStore.get(normalizeClientId(id) || id);
        if (entry) break;
      }
      if (!entry) return sendJson(res, 404, { error: 'No video found for this clientId. Send video to bot first.' });
      const { fileId, mimeType } = entry;
      const { buffer, filePath } = await downloadTgFile(fileId);
      const fileName = filePath.split('/').pop() || 'video.mp4';
      // Upload to Gemini
      const startRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(GEMINI_API_KEY)}`,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': GEMINI_API_KEY,
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(buffer.length),
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ file: { display_name: fileName } })
        }
      );
      if (!startRes.ok) return sendJson(res, 502, { error: await getApiError(startRes, `Gemini start failed: ${startRes.status}`) });
      const uploadUrl = startRes.headers.get('x-goog-upload-url');
      if (!uploadUrl) return sendJson(res, 502, { error: 'No upload URL from Gemini.' });
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
          'Content-Length': String(buffer.length),
          'Content-Type': mimeType
        },
        body: buffer
      });
      if (!uploadRes.ok) return sendJson(res, 502, { error: await getApiError(uploadRes, `Gemini upload failed: ${uploadRes.status}`) });
      const uploadData = await uploadRes.json();
      const uploadedFile = uploadData.file || uploadData;
      tgVideoStore.delete(clientId); // cleanup after use
      return sendJson(res, 200, { file: uploadedFile, mimeType });
    }

    // Proxy Gemini file status so the browser can poll without the API key.
    if (req.method === 'GET' && path === '/api/file-status') {
      if (!GEMINI_API_KEY) return sendJson(res, 500, { error: 'GEMINI_API_KEY is not configured.' });
      const fileName = url.searchParams.get('name');
      if (!fileName) return sendJson(res, 400, { error: 'name is required.' });
      const statusUrl = geminiFileStatusUrl(fileName);
      if (!statusUrl) return sendJson(res, 400, { error: 'Invalid file name.' });
      const statusRes = await fetch(statusUrl);
      if (!statusRes.ok) return sendJson(res, statusRes.status, { error: 'Could not get file status.' });
      return sendJson(res, 200, await statusRes.json());
    }

    if (req.method === 'GET' && path === '/api/status') {
      return sendJson(res, 200, await getClientStatus(url.searchParams.get('clientId')));
    }

    if (req.method === 'GET' && path === '/api/history') {
      const client = await ensureClientRecord(url.searchParams.get('clientId'));
      return sendJson(res, 200, {
        clientId: normalizeClientId(url.searchParams.get('clientId')),
        history: Array.isArray(client?.history) ? client.history.map(normalizeHistoryEntry) : []
      });
    }

    if (req.method === 'GET' && path === '/api/payment-payload') {
      return sendJson(res, 200, getPaymentPayload(url.searchParams.get('clientId'), url.searchParams.get('method') || 'stars'));
    }

    if (req.method === 'POST' && path === '/api/stars-invoice-link') {
      const body = await readJson(req, url);
      return sendJson(res, 200, await createStarsInvoiceLink(body || {}));
    }

    if (req.method === 'POST' && path === '/api/unlock') {
      const body = await readJson(req, url);
      try {
        assertUnlockAuthorized(req, body);
      } catch (authError) {
        return sendJson(res, authError.statusCode || 401, { error: authError.message });
      }
      const clientId = normalizeClientId(body?.clientId);
      if (!clientId) return sendJson(res, 400, { error: 'clientId is required.' });
      return sendJson(res, 200, await unlockClientAccess(clientId, body?.method, {
        resetUsage: Boolean(body?.resetUsage)
      }));
    }

    if (req.method === 'POST' && path === '/api/telegram-webhook') {
      const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
      if (webhookSecret) {
        const provided = String(req.headers['x-telegram-bot-api-secret-token'] || '');
        if (provided !== webhookSecret) {
          return sendJson(res, 401, { ok: false, error: 'Unauthorized webhook request.' });
        }
      }
      const update = await readJson(req, url);
      return sendJson(res, 200, await handleTelegramUpdate(update));
    }

        if (req.method === 'POST' && path === '/api/generate') {
      if (!GEMINI_API_KEY) return sendJson(res, 500, { error: 'GEMINI_API_KEY is not configured.' });
      const body = await readJson(req, url);
      const { requestBody, mode } = body || {};
      if (!requestBody) return sendJson(res, 400, { error: 'requestBody is required.' });
      const data = await callGemini(requestBody, mode || 'pro');
      return sendJson(res, 200, data);
    }

    if (req.method === 'POST' && path === '/api/translate-result') {
      if (!GEMINI_API_KEY) return sendJson(res, 500, { error: 'GEMINI_API_KEY is not configured.' });
      const body = await readJson(req, url);
      const result = body?.result;
      const language = String(body?.language || 'en');
      if (!result || typeof result !== 'object') {
        return sendJson(res, 400, { error: 'result object is required.' });
      }
      const translated = await translateAnalysisResult(normalizeResult(result), language);
      return sendJson(res, 200, { result: translated, language });
    }

    if (req.method === 'POST' && path === '/api/ask-analysis') {
      if (!GEMINI_API_KEY) return sendJson(res, 500, { error: 'GEMINI_API_KEY is not configured.' });
      const body = await readJson(req, url);
      try {
        const payload = await askAboutAnalysis({
          question: body?.question,
          result: body?.result,
          meta: body?.meta || {},
          language: body?.language,
          history: body?.history
        });
        return sendJson(res, 200, payload);
      } catch (askError) {
        return sendJson(res, askError.statusCode || 500, { error: askError.message || 'ask-analysis failed' });
      }
    }

    if (req.method === 'POST' && path === '/api/analyze') {
      if (!GEMINI_API_KEY) {
        return sendJson(res, 500, { error: 'GEMINI_API_KEY is not configured on the server.' });
      }
      const formData = await readFormData(req, url);
      const result = await analyzeMultipart(formData);
      return sendJson(res, 200, result);
    }

    return sendText(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    const message = userFacingGeminiError(error);
    const statusCode = error?.statusCode
      || (isRetryableGeminiError(message) ? 503 : 500);
    return sendJson(res, statusCode, { error: message });
  }
}
