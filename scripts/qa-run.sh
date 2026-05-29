#!/usr/bin/env bash
# Functional QA runner for Viral Score against a deployed backend.
# Usage: B=https://viral-score.vercel.app bash scripts/qa-run.sh
set -u
B="${B:-https://viral-score.vercel.app}"
PASS=0; FAIL=0
ts() { date +%s%N; }

# analyze <name> <clientId> <mode> <sourceType> <lang> <field=value...>
analyze() {
  local name="$1" cid="$2" mode="$3" stype="$4" lang="$5"; shift 5
  local args=(-F "clientId=$cid" -F "analysisId=qa-$(ts)" -F "platform=Instagram" \
    -F "mode=$mode" -F "sourceType=$stype" -F "language=$lang" -F "freeLimit=999")
  local kv
  for kv in "$@"; do args+=(-F "$kv"); done
  local out code body
  out=$(curl -s -m 280 -w $'\n%{http_code}' -X POST "$B/api/analyze" "${args[@]}")
  code=$(printf '%s' "$out" | tail -n1)
  body=$(printf '%s' "$out" | sed '$d')
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"viral_score"'; then
    local score deg
    score=$(printf '%s' "$body" | grep -o '"viral_score":[0-9]*' | head -1)
    deg=$(printf '%s' "$body" | grep -o '"analysisDegraded":[a-z]*' | head -1)
    echo "PASS  $name  [$code] $score ${deg:-}"
    PASS=$((PASS+1))
  else
    echo "FAIL  $name  [$code] $(printf '%s' "$body" | head -c 200)"
    FAIL=$((FAIL+1))
  fi
}

echo "### TEXT"
analyze "text/quick/en" qa_txt_qe quick text en "text=Day 1 of learning to code. I built my first app in 30 days and here is what nobody tells you."
analyze "text/pro/ru"   qa_txt_pr pro  text ru "text=Сегодня покажу как я за месяц набрал 100к подписчиков с нуля. Секрет в одной простой вещи которую никто не делает."
analyze "text/ad/en"    qa_txt_ae ad   text en "text=Tired of editing videos for hours? Our AI tool cuts your editing time by 90 percent. Try free today."

echo "### VIDEO-URL"
analyze "videourl/quick/en" qa_url_q quick video-url en "url=https://www.youtube.com/shorts/abc123"

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
