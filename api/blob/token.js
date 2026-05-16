export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not configured on server' });

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const fileName = (body.fileName || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
  const mimeType = body.mimeType || 'video/mp4';

  // Vercel Blob REST API — create a new blob with a signed upload URL
  const apiRes = await fetch(
    `https://blob.vercel-storage.com/?filename=${encodeURIComponent(fileName)}`,
    {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'x-api-version': '7',
        'content-type': mimeType,
        'x-add-random-suffix': '1',
        'x-cache-control-max-age': '3600',
      },
    }
  );

  const text = await apiRes.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!apiRes.ok) return res.status(502).json({ error: data.error?.message || data.error || text });

  return res.status(200).json(data);
}
