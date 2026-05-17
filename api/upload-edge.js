// Dedicated route (not catch-all): full video body → Gemini. Used for 15MB+ in Telegram Mini App.
export const config = {
  runtime: 'nodejs',
  maxDuration: 300,
  api: {
    bodyParser: false,
    responseLimit: false
  }
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

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
    delayMs = delayMs ? Math.min(Math.round(delayMs * 1.55), 2800) : 500;
    const statusRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${encodeURIComponent(uploadName)}?key=${encodeURIComponent(GEMINI_API_KEY)}`
    );
    if (!statusRes.ok) continue;
    const meta = await statusRes.json();
    state = meta.state || state;
    if (state === 'ACTIVE') return { ...partial, ...meta, mimeType: meta.mimeType || mimeType };
    if (state === 'FAILED') throw new Error('Gemini file processing failed.');
  }
  throw new Error('Timed out waiting for Gemini file processing.');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Mime-Type,X-File-Size,X-File-Name');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const mimeType = req.headers['x-mime-type'] || req.headers['content-type'] || 'video/mp4';
  const fileName = (req.headers['x-file-name'] || 'video.mp4').slice(0, 200);

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) return res.status(400).json({ error: 'Empty body' });
    const actualSize = String(buffer.length);

    const startRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': GEMINI_API_KEY,
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': actualSize,
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file: { display_name: fileName } })
      }
    );

    if (!startRes.ok) {
      const errText = await startRes.text();
      return res.status(502).json({ error: `Gemini start failed: ${startRes.status} ${errText}` });
    }

    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) return res.status(502).json({ error: 'No upload URL from Gemini' });

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
        'Content-Length': actualSize,
        'Content-Type': mimeType
      },
      body: buffer
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      return res.status(502).json({ error: `Gemini upload failed: ${uploadRes.status} ${errText}` });
    }

    const uploadData = await uploadRes.json();
    const uploadedFile = uploadData.file || uploadData;
    const uploadName = uploadedFile?.name || uploadData?.name;
    if (uploadName && uploadedFile?.state && uploadedFile.state !== 'ACTIVE') {
      const ready = await waitGeminiFileProcessed(uploadName, mimeType, uploadedFile);
      return res.status(200).json({ file: ready, mimeType: ready.mimeType || mimeType });
    }
    return res.status(200).json({ file: uploadedFile, mimeType });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Upload failed' });
  }
}
