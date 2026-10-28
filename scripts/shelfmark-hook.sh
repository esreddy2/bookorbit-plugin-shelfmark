#!/usr/bin/env bash
#
# Shelfmark Post-Download Custom Script Hook
#
# Configured in Shelfmark via:
#   CUSTOM_SCRIPT=/path/to/shelfmark-hook.sh
#   CUSTOM_SCRIPT_PATH_MODE=absolute
#   CUSTOM_SCRIPT_JSON_PAYLOAD=true
#
# Reads JSON from stdin when CUSTOM_SCRIPT_JSON_PAYLOAD=true,
# or reads $1 (file path) when disabled.
# Sends authenticated HTTP notification to the BookOrbit-Shelfmark companion bridge.

set -euo pipefail

BRIDGE_URL="${BRIDGE_WEBHOOK_URL:-http://localhost:8085/webhook/shelfmark}"
BRIDGE_SECRET="${BRIDGE_SECRET:-bookorbit-shelfmark-secret}"

PAYLOAD=""

# Mode 1: Argument mode (Shelfmark passes $1 when CUSTOM_SCRIPT_JSON_PAYLOAD=false)
if [ $# -gt 0 ] && [ -n "${1:-}" ]; then
  FILE_PATH="$1"
  FILE_NAME=$(basename "$FILE_PATH")
  PAYLOAD=$(printf '{"download_path":"%s","file_name":"%s","status":"completed"}' "$FILE_PATH" "$FILE_NAME")
fi

# Mode 2: Stdin JSON mode (Shelfmark pipes JSON payload when CUSTOM_SCRIPT_JSON_PAYLOAD=true)
if [ -z "$PAYLOAD" ] && [ ! -t 0 ]; then
  STDIN_DATA=$(cat || true)
  if [ -n "$STDIN_DATA" ]; then
    PAYLOAD="$STDIN_DATA"
  fi
fi

if [ -z "$PAYLOAD" ]; then
  echo "[Shelfmark Hook] Error: No payload received via stdin or arguments." >&2
  exit 1
fi

echo "[Shelfmark Hook] Delivering completion notification to $BRIDGE_URL..."

# Send authenticated POST request to Companion Bridge
if command -v curl >/dev/null 2>&1; then
  RESPONSE=$(curl -s -S -w "\nHTTP_STATUS:%{http_code}" \
    -X POST "$BRIDGE_URL" \
    -H "Content-Type: application/json" \
    -H "X-Bridge-Secret: $BRIDGE_SECRET" \
    -d "$PAYLOAD")

  HTTP_BODY=$(echo "$RESPONSE" | sed -e '$d')
  HTTP_STATUS=$(echo "$RESPONSE" | tail -n 1 | sed -e 's/HTTP_STATUS://')

  if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
    echo "[Shelfmark Hook] Success (HTTP $HTTP_STATUS): $HTTP_BODY"
    exit 0
  else
    echo "[Shelfmark Hook] Failed (HTTP $HTTP_STATUS): $HTTP_BODY" >&2
    exit 1
  fi
else
  # Fallback to Node.js if curl is not installed in the container
  node -e "
    const http = require('http');
    const url = new URL('$BRIDGE_URL');
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Secret': '$BRIDGE_SECRET',
        'Content-Length': Buffer.byteLength(process.env.PAYLOAD)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('[Shelfmark Hook] Success (HTTP ' + res.statusCode + '): ' + data);
          process.exit(0);
        } else {
          console.error('[Shelfmark Hook] Failed (HTTP ' + res.statusCode + '): ' + data);
          process.exit(1);
        }
      });
    });
    req.on('error', (e) => {
      console.error('[Shelfmark Hook] Request failed: ' + e.message);
      process.exit(1);
    });
    req.write(process.env.PAYLOAD);
    req.end();
  " PAYLOAD="$PAYLOAD"
fi
