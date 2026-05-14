import { Readable } from 'node:stream';
import { handleUpload } from '@vercel/blob/client';

const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.end();
  }

  try {
    if (!BLOB_READ_WRITE_TOKEN) {
      return sendJson(res, 500, { error: 'BLOB_READ_WRITE_TOKEN is not configured on the server.' });
    }
    const url = new URL(req.url || '/api/blob/upload', 'http://localhost');
    const request = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      body: Readable.toWeb(req),
      duplex: 'half'
    });
    const body = await request.json();
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'application/octet-stream'],
        addRandomSuffix: true
      }),
      onUploadCompleted: async ({ blob }) => {
        console.log('Blob upload completed:', blob?.url || '');
      }
    });
    return sendJson(res, 200, jsonResponse);
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || 'Blob upload failed.' });
  }
}
