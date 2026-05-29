#!/usr/bin/env bash
# E2E large-video test against production.
# Exercises the real large-file path: public URL (>8MB, range-capable)
#   -> /api/proxy-upload (chunked Blob/CDN -> Gemini Files API)
#   -> /api/analyze (sourceType=video-file with the returned fileUri)
# Override VIDEO_URL to test other/larger files (up to ~100MB).
set -u
B="${B:-https://viral-score.vercel.app}"
VIDEO_URL="${VIDEO_URL:-https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_30MB.mp4}"

echo "size check..."
curl -s -I -m 20 "$VIDEO_URL" | grep -iE "content-length|accept-ranges"

echo "proxy-upload (chunked Blob/CDN -> Gemini)..."
PU=$(curl -s -m 290 -X POST "$B/api/proxy-upload" -H 'Content-Type: application/json' \
  -d "{\"blobUrl\":\"$VIDEO_URL\",\"mimeType\":\"video/mp4\",\"fileName\":\"qa_big.mp4\"}")
echo "  $(printf '%s' "$PU" | head -c 220)"
URI=$(printf '%s' "$PU" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.file&&(j.file.uri||j.file.name))||'')}catch(e){console.log('')}})")
echo "  uri: $URI"
[ -z "$URI" ] && { echo "FAIL: no fileUri"; exit 1; }

echo "analyze (video-file, quick)..."
R=$(curl -s -m 295 -w $'\n%{http_code}|%{time_total}s' -X POST "$B/api/analyze" \
  -F "clientId=qa_big_$(date +%s)" -F "analysisId=big-$(date +%s)" -F "platform=YouTube" \
  -F "mode=quick" -F "sourceType=video-file" -F "language=en" -F "freeLimit=999" \
  -F "fileUri=$URI" -F "fileMimeType=video/mp4" -F "text=large video analysis test")
echo "  $(printf '%s' "$R" | tail -n1)"
printf '%s' "$R" | sed '$d' | grep -oE '("viral_score"[^,]*|"analysisDegraded":[a-z]*|"error":"[^"]*")' | head -5
