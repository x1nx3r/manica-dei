#!/usr/bin/env bash
# Boot the service, upload a file, fetch it back, read the counters.
#
# The unit tests cannot see a service that is up but broken; this can. It runs
# against a scratch upload directory and a scratch port, so it is safe to run
# beside a live one.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

port="${SMOKE_PORT:-18891}"
work="$(mktemp -d)"
pid=""

cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "smoke: building"
go build -o "$work/cdn" ./cmd/server

echo "smoke: starting on :$port"
UPLOAD_DIR="$work/uploads" SERVER_PORT="$port" "$work/cdn" >"$work/server.log" 2>&1 &
pid=$!

up=""
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$port/metrics" >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 0.2
done
if [ -z "$up" ]; then
  echo "smoke: the service never came up on :$port"
  cat "$work/server.log"
  exit 1
fi

payload="$(find uploads -name '*.jpg' | head -1)"
if [ -z "$payload" ]; then
  echo "smoke: no sample file under uploads/ to send"
  exit 1
fi

echo "smoke: uploading $payload"
body="$(curl -fsS -F "file=@$payload" "http://127.0.0.1:$port/upload")"
url="$(printf '%s' "$body" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
if [ -z "$url" ]; then
  echo "smoke: the upload returned no url: $body"
  exit 1
fi

name="${url##*/}"
if [ ! -f "$work/uploads/$name" ]; then
  echo "smoke: the upload reported $url but nothing is at $work/uploads/$name"
  exit 1
fi

echo "smoke: fetching it back"
code="$(curl -s -o "$work/fetched" -w '%{http_code}' "http://127.0.0.1:$port/files/$name")"
if [ "$code" != "200" ]; then
  echo "smoke: the fetch returned $code"
  exit 1
fi
if ! cmp -s "$payload" "$work/fetched"; then
  echo "smoke: the fetched bytes differ from the uploaded bytes"
  exit 1
fi

echo "smoke: reading the counters"
metrics="$(curl -fsS "http://127.0.0.1:$port/metrics")"
for name in upload_bytes_total upload_mime_total; do
  if ! printf '%s' "$metrics" | grep -q "^$name"; then
    echo "smoke: $name is missing from /metrics"
    exit 1
  fi
done

echo "smoke: ok"
