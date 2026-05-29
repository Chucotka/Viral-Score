#!/usr/bin/env bash
set -u
B="${B:-https://viral-score.vercel.app}"
CID="qa_quota_$(date +%s)"
echo "clientId=$CID freeLimit=2"
for i in 1 2 3; do
  R=$(curl -s -m 120 -w $'\n%{http_code}' -X POST "$B/api/analyze" \
    -F "clientId=$CID" -F "analysisId=q$i" -F "platform=Instagram" \
    -F "mode=quick" -F "sourceType=text" -F "language=en" -F "freeLimit=2" \
    -F "text=Quick hook test number $i for quota counting.")
  code=$(printf '%s' "$R" | tail -n1)
  rest=$(printf '%s' "$R" | sed '$d')
  uc=$(printf '%s' "$rest" | grep -o '"usageCount":[0-9]*' | head -1)
  err=$(printf '%s' "$rest" | grep -o '"error":"[^"]*"' | head -1)
  echo "run #$i -> [$code] ${uc:-noUsage} ${err:-}"
done
echo "status: $(curl -s "$B/api/status?clientId=$CID")"
echo "unlock-no-secret: $(curl -s -w ' [%{http_code}]' -X POST "$B/api/unlock" -H 'Content-Type: application/json' -d "{\"clientId\":\"$CID\"}")"
