import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not configured' });

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const fileName = (body.fileName || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
  const mimeType = body.mimeType || 'video/mp4';

  try {
    const clientToken = await generateClientTokenFromReadWriteToken({
      token,
      pathname: fileName,
      onUploadCompleted: {
        callbackUrl: `https://${req.headers.host}/api/blob/token`,
      },
      allowedContentTypes: [mimeType, 'video/mp4', 'video/quicktime', 'video/webm'],
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return res.status(200).json({ clientToken, pathname: fileName });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to generate token' });
  }
}
