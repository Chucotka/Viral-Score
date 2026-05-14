import { Readable } from 'node:stream';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const MODEL_CANDIDATES = ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.0-flash'];
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

const memoryKey = '__viralScoreMemory';
const memory = globalThis[memoryKey] || (globalThis[memoryKey] = { clients: new Map() });

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

function normalizeClientId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/\s+/g, '_').slice(0, 128);
}

function ensureClientRecord(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  if (!memory.clients.has(id)) {
    memory.clients.set(id, {
      clientId: id,
      usageCount: 0,
      accessUnlocked: false,
      lastSeenAt: null,
      lastPaymentMethod: '',
      lastAnalysis: null,
      history: [],
      analysisIds: new Set()
    });
  }
  return memory.clients.get(id);
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
        'video-file': 'Анализируй само загруженное видео. Сфокусируйся на первых секундах, темпе, визуальной ясности, тексте на экране, эмоции и шеринге.',
        'video-url': 'Анализируй публичное видео или страницу по ссылке. Если URL context доступен, используй его; иначе опирайся на ссылку и контекст пользователя.',
        'text': 'Анализируй переданный текст, caption, транскрипт или сценарий как концепт поста.'
      }
    : {
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

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.includes('youtube.com') || url.hostname.includes('youtu.be');
  } catch {
    return false;
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

async function getApiError(response, fallback) {
  try {
    const data = await response.clone().json();
    return data?.error?.message || fallback;
  } catch {
    try {
      const text = await response.clone().text();
      return text || fallback;
    } catch {
      return fallback;
    }
  }
}

async function uploadVideoFile(file) {
  const body = file?.body || file;
  const fileName = file?.name || 'video.mp4';
  const fileType = file?.type || body?.type || 'video/mp4';
  const fileSize = Number(file?.size || body?.size || 0);
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
    const started = Date.now();
    while (Date.now() - started < 120000) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const statusResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/${uploadName}?key=${encodeURIComponent(GEMINI_API_KEY)}`);
      if (!statusResponse.ok) continue;
      const statusData = await statusResponse.json();
      fileState = statusData.state;
      if (fileState === 'ACTIVE') return statusData;
      if (fileState === 'FAILED') throw new Error('Gemini file processing failed.');
    }
    throw new Error('Timed out waiting for uploaded video processing.');
  }
  return uploadedFile;
}

async function loadVideoFromUrl(videoUrl) {
  const response = await fetch(videoUrl);
  if (!response.ok) {
    throw new Error(`Could not load uploaded video from blob URL: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'video/mp4';
  const pathname = (() => {
    try {
      return new URL(videoUrl).pathname.split('/').filter(Boolean).pop() || 'video.mp4';
    } catch {
      return 'video.mp4';
    }
  })();
  return {
    name: pathname,
    type: contentType,
    size: buffer.length,
    body: buffer
  };
}

async function callGemini(requestBody) {
  let lastError = null;
  for (const model of MODEL_CANDIDATES) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...requestBody,
        generationConfig: {
          temperature: 0.4,
          topP: 0.95,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseSchema: ANALYSIS_SCHEMA
        }
      })
    });
    if (response.ok) return response.json();
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
    resultText = resultText.substring(7, resultText.length - 3).trim();
  } else if (resultText.startsWith('```')) {
    resultText = resultText.substring(3, resultText.length - 3).trim();
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

  const client = ensureClientRecord(clientId);
  if (!client) throw new Error('clientId is required.');
  client.lastSeenAt = new Date().toISOString();
  client.accessUnlocked = client.accessUnlocked || accessUnlocked;

  if (!client.accessUnlocked && freeLimit > 0 && client.usageCount >= freeLimit) {
    const error = new Error('Free quota ended.');
    error.statusCode = 402;
    throw error;
  }

  if (analysisId && client.analysisIds.has(analysisId) && client.lastAnalysis?.result) {
    return {
      result: client.lastAnalysis.result,
      usageCount: client.usageCount,
      accessUnlocked: client.accessUnlocked,
      freeLimit
    };
  }

  let requestBody;
  if (sourceType === 'video-file') {
    const videoBlobUrl = String(formData.get('videoBlobUrl') || '').trim();
    let sourceFile = null;
    if (videoBlobUrl) {
      sourceFile = await loadVideoFromUrl(videoBlobUrl);
    } else if (video && typeof video !== 'string') {
      sourceFile = video;
    }
    if (!sourceFile) throw new Error('Missing uploaded video file.');
    const uploadedFile = await uploadVideoFile(sourceFile);
    if (!uploadedFile?.uri) throw new Error('Missing uploaded file URI.');
    requestBody = {
      contents: [{
        parts: [
          { file_data: { file_uri: uploadedFile.uri, mime_type: uploadedFile.mimeType || video.type || 'video/mp4' } },
          { text: prompt }
        ]
      }]
    };
  } else if (sourceType === 'video-url') {
    const normalizedUrl = normalizePasteableLink(url);
    if (normalizedUrl && isYouTubeUrl(normalizedUrl)) {
      requestBody = {
        contents: [{
          parts: [
            { file_data: { file_uri: normalizedUrl } },
            { text: prompt }
          ]
        }]
      };
    } else if (normalizedUrl) {
      requestBody = {
        contents: [{
          parts: [{ text: `${prompt}\n\nPublic URL:\n${normalizedUrl}` }]
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
    requestBody = {
      contents: [{
        parts: [{ text: `${prompt}\n\nText:\n${text.trim()}` }]
      }]
    };
  }

  const data = await callGemini(requestBody);
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini response was cut off.');
  }
  const result = normalizeResult(parseModelJson(extractModelText(data)));

  client.usageCount += 1;
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

  return {
    result,
    usageCount: client.usageCount,
    accessUnlocked: client.accessUnlocked,
    freeLimit
  };
}

function getClientStatus(clientId) {
  const client = ensureClientRecord(clientId);
  return {
    clientId: normalizeClientId(clientId),
    usageCount: client?.usageCount || 0,
    accessUnlocked: Boolean(client?.accessUnlocked),
    lastSeenAt: client?.lastSeenAt || null,
    lastAnalysis: client?.lastAnalysis || null
  };
}

function unlockClientAccess(clientId, method = 'stars') {
  const client = ensureClientRecord(clientId);
  if (!client) throw new Error('clientId is required.');
  client.accessUnlocked = true;
  client.lastPaymentMethod = method;
  client.lastSeenAt = new Date().toISOString();
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

async function handleTelegramUpdate(update) {
  const payment = update?.message?.successful_payment;
  if (!payment) {
    return { ok: true, handled: false };
  }
  const clientId = extractClientIdFromPayload(payment.invoice_payload);
  if (!clientId) {
    return { ok: false, error: 'Missing client payload in successful payment.' };
  }
  const unlocked = unlockClientAccess(clientId, 'stars');
  return { ok: true, handled: true, ...unlocked };
}

async function readJson(req, url) {
  const request = new Request(url.toString(), {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: 'half'
  });
  return request.json();
}

async function readFormData(req, url) {
  const request = new Request(url.toString(), {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: 'half'
  });
  return request.formData();
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.end();
    }

    if (req.method === 'GET' && (path === '/health' || path === '/api/health')) {
      return sendJson(res, 200, {
        ok: true,
        geminiConfigured: Boolean(GEMINI_API_KEY),
        botConfigured: Boolean(BOT_TOKEN)
      });
    }

    if (req.method === 'GET' && path === '/api/status') {
      return sendJson(res, 200, getClientStatus(url.searchParams.get('clientId')));
    }

    if (req.method === 'GET' && path === '/api/history') {
      const client = ensureClientRecord(url.searchParams.get('clientId'));
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
      const clientId = normalizeClientId(body?.clientId);
      if (!clientId) return sendJson(res, 400, { error: 'clientId is required.' });
      return sendJson(res, 200, unlockClientAccess(clientId, body?.method));
    }

    if (req.method === 'POST' && path === '/api/telegram-webhook') {
      const update = await readJson(req, url);
      return sendJson(res, 200, await handleTelegramUpdate(update));
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
    return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Internal server error' });
  }
}
