// Returns a Gemini resumable upload URL so the browser can upload directly
export const config = { runtime: 'nodejs', maxDuration: 30 };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

  const mimeType = body.mimeType || 'video/mp4';
  const fileSize = String(body.fileSize || 0);
  const fileName = (body.fileName || 'video.mp4').slice(0, 200);

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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: fileName } }),
    }
  );

  if (!startRes.ok) {
    const errText = await startRes.text();
    return res.status(502).json({ error: `Gemini start failed: ${startRes.status} ${errText}` });
  }

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) return res.status(502).json({ error: 'No upload URL from Gemini' });

  return res.status(200).json({ uploadUrl, mimeType, fileName });
}
