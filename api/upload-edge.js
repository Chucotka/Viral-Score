export const config = { runtime: 'edge' };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Mime-Type,X-File-Size,X-File-Name',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (!GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const mimeType = req.headers.get('x-mime-type') || req.headers.get('content-type') || 'video/mp4';
  const fileSize = req.headers.get('x-file-size') || '0';
  const fileName = (req.headers.get('x-file-name') || 'video.mp4').slice(0, 200);

  // Step 1: start resumable upload session with Gemini
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
    return new Response(JSON.stringify({ error: `Gemini start failed: ${startRes.status} ${errText}` }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    return new Response(JSON.stringify({ error: 'No upload URL from Gemini' }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Step 2: stream body directly to Gemini
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
      'Content-Length': fileSize,
      'Content-Type': mimeType,
    },
    body: req.body,
    duplex: 'half',
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    return new Response(JSON.stringify({ error: `Gemini upload failed: ${uploadRes.status} ${errText}` }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const uploadData = await uploadRes.json();
  const uploadedFile = uploadData.file || uploadData;

  return new Response(JSON.stringify({ file: uploadedFile, mimeType }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
