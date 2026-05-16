export const config = {
  runtime: 'nodejs',
  maxDuration: 300,
  api: { bodyParser: false, responseLimit: false },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-mime-type,x-file-name');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not configured' });

  const mimeType = req.headers['x-mime-type'] || 'video/mp4';
  const fileName = (req.headers['x-file-name'] || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileSize = req.headers['content-length'] || '0';

  const apiRes = await fetch(
    `https://blob.vercel-storage.com/${encodeURIComponent(fileName)}`,
    {
      method: 'PUT',
      headers: {
        'authorization': `Bearer ${token}`,
        'x-api-version': '7',
        'content-type': mimeType,
        'content-length': fileSize,
        'x-add-random-suffix': '1',
        'x-cache-control-max-age': '3600',
        'x-access': 'private',
      },
      body: req,
      duplex: 'half',
    }
  );

  const text = await apiRes.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!apiRes.ok) return res.status(502).json({ error: data.error?.message || text.substring(0, 300) });

  // For private blobs we need a download URL — generate it via API
  const blobUrl = data.url || data.downloadUrl;
  if (!blobUrl) return res.status(502).json({ error: 'No URL in Blob response', raw: text.substring(0, 300) });

  return res.status(200).json({ url: blobUrl });
}
