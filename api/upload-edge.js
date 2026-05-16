// Node.js runtime — receives a Vercel Blob URL, downloads it, pushes to Gemini
export const config = {
  runtime: 'nodejs',
  maxDuration: 300,
  api: {
    bodyParser: { sizeLimit: '8mb' },
    responseLimit: false,
  },
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Mime-Type,X-File-Size,X-File-Name');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const body = req.body || {};
  const blobUrl = body.blobUrl;
  const mimeType = body.mimeType || 'video/mp4';
  const fileName = (body.fileName || 'video.mp4').slice(0, 200);

  if (!blobUrl) {
    return res.status(400).json({ error: 'blobUrl is required' });
  }

  // Download from Vercel Blob
  let buffer;
  try {
    const blobRes = await fetch(blobUrl);
    if (!blobRes.ok) throw new Error(`Blob fetch failed: ${blobRes.status}`);
    const ab = await blobRes.arrayBuffer();
    buffer = Buffer.from(ab);
  } catch (e) {
    return res.status(502).json({ error: `Could not download blob: ${e.message}` });
  }

  const actualSize = String(buffer.length);

  // Step 1: start resumable upload session with Gemini
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

  // Step 2: upload buffer to Gemini
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Length': actualSize,
      'Content-Type': mimeType,
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    return res.status(502).json({ error: `Gemini upload failed: ${uploadRes.status} ${errText}` });
  }

  const uploadData = await uploadRes.json();
  const uploadedFile = uploadData.file || uploadData;

  return res.status(200).json({ file: uploadedFile, mimeType });
}
