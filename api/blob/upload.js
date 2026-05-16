// Server-side blob upload — browser sends file here, server puts it to Vercel Blob
// Bypasses CORS/Telegram WebView restrictions on direct blob.vercel-storage.com access
import { put } from '@vercel/blob';

export const config = {
  runtime: 'nodejs',
  maxDuration: 120,
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-File-Name,X-Mime-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not configured' });

  const fileName = (req.headers['x-file-name'] || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
  const mimeType = req.headers['x-mime-type'] || req.headers['content-type'] || 'video/mp4';

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const blob = await put(fileName, buffer, {
      access: 'public',
      token,
      contentType: mimeType,
      addRandomSuffix: false,
    });

    return res.status(200).json({ url: blob.url });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Upload failed' });
  }
}
