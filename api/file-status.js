export const config = { runtime: 'nodejs', maxDuration: 30 };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const { fileName } = body;
  if (!fileName) return res.status(400).json({ error: 'fileName required' });

  const pollRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(GEMINI_API_KEY)}`
  );
  const data = await pollRes.json();
  return res.status(pollRes.ok ? 200 : 502).json(data);
}
