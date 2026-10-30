#!/usr/bin/env bash
#
# Shelfmark Post-Download Custom Script Hook
#
# Follows Shelfmark v1.5.1 specification (docs/custom-scripts.md):
# 1. Shelfmark ALWAYS passes the target file path as $1.
# 2. When CUSTOM_SCRIPT_JSON_PAYLOAD=true, Shelfmark ALSO writes a versioned,
#    nested JSON payload to stdin containing task metadata and path structures.
# 3. Timeout is bounded by Shelfmark at 300 seconds.
# 4. Shelfmark marks the download task as "Error" if this script exits non-zero!
#    Therefore, if the companion bridge is temporarily unavailable or network
#    fails, we log a warning and exit 0 so Shelfmark's completed download is not
#    corrupted. The companion bridge's periodic reconciliation strategy
#    discovers and fulfills the completed task from Shelfmark /api/status.
#
# Docker Networking:
#   Inside Docker, 'localhost' refers to the Shelfmark container itself.
#   Point BRIDGE_WEBHOOK_URL to your companion container name or host address:
#   e.g. http://bookorbit-companion:8085/webhook/shelfmark or http://host.docker.internal:8085/...

set -u

TARGET_PATH="${1:-}"

# Docker-friendly default: check container hostname or fallback to localhost
DEFAULT_BRIDGE_HOST="${BRIDGE_HOST:-bookorbit-companion}"
DEFAULT_BRIDGE_PORT="${BRIDGE_PORT:-8085}"
BRIDGE_URL="${BRIDGE_WEBHOOK_URL:-http://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}/webhook/shelfmark}"
BRIDGE_SECRET="${BRIDGE_SECRET:-bookorbit-shelfmark-secret}"

PAYLOAD=""

# Check if data is piped to stdin (Shelfmark JSON payload mode)
if [ ! -t 0 ]; then
  STDIN_DATA=$(cat || true)
  if [ -n "$STDIN_DATA" ]; then
    PAYLOAD="$STDIN_DATA"
  fi
fi

# If stdin was empty, construct structured payload using $1
if [ -z "$PAYLOAD" ]; then
  if [ -n "$TARGET_PATH" ]; then
    FILE_NAME=$(basename "$TARGET_PATH")
    # Include task_id when Shelfmark provides it via environment; otherwise null.
TASK_ID_VAL="${SHELFMARK_TASK_ID:-}"
if [ -z "$TASK_ID_VAL" ]; then
  TASK_JSON="null"
else
  TASK_JSON="\"$TASK_ID_VAL\""
fi
PAYLOAD=$(TASK_JSON="$TASK_JSON" FILE_NAME="$FILE_NAME" TARGET_PATH="$TARGET_PATH" node -e '
  const tj = process.env.TASK_JSON;
  const fn = process.env.FILE_NAME || "";
  const tp = process.env.TARGET_PATH || "";
  const task_id = tj === "null" ? null : tj.replace(/^"|"$/g, "");
  const obj = {
    version: 1,
    phase: "post_transfer",
    task: { task_id, title: fn },
    metadata: { source: "shelfmark_hook", destination: tp },
    paths: { target: tp, final_paths: [tp], destination: tp },
    target_path: tp,
    destination: tp,
  };
  process.stdout.write(JSON.stringify(obj));
')
  else
    echo "[Shelfmark Hook] Warning: No target path in \$1 and no stdin JSON received." >&2
    exit 0
  fi
fi

echo "[Shelfmark Hook] Delivering completion notification to $BRIDGE_URL (target: $TARGET_PATH)..."

# Deliver notification with a 15-second timeout
DELIVERY_SUCCESS=0
HTTP_STATUS=""
HTTP_BODY=""

if command -v curl >/dev/null 2>&1; then
  set +e
  RESPONSE=$(curl -s -S --max-time 15 -w "\nHTTP_STATUS:%{http_code}" \
    -X POST "$BRIDGE_URL" \
    -H "Content-Type: application/json" \
    -H "X-Bridge-Secret: $BRIDGE_SECRET" \
    -d "$PAYLOAD" 2>&1)
  CURL_EXIT=$?
  set -e

  if [ $CURL_EXIT -eq 0 ]; then
    HTTP_BODY=$(echo "$RESPONSE" | sed -e '$d')
    HTTP_STATUS=$(echo "$RESPONSE" | tail -n 1 | sed -e 's/HTTP_STATUS://')
    if [ -n "$HTTP_STATUS" ] && [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
      DELIVERY_SUCCESS=1
    fi
  else
    HTTP_BODY="$RESPONSE"
  fi
else
  # Node.js fallback (used when curl is unavailable). Configuration and the
  # exact stdin payload are passed through the environment and stdin; nothing
  # is interpolated into JavaScript source.
  set +e
  NODE_OUT=$(printf '%s' "$PAYLOAD" | BRIDGE_URL="$BRIDGE_URL" BRIDGE_SECRET="$BRIDGE_SECRET" node -e '
    const http = require("http");
    const url = new URL(process.env.BRIDGE_URL);
    const secret = process.env.BRIDGE_SECRET || "";
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const payload = chunks.join("");
      const req = http.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Secret": secret,
          "Content-Length": Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            process.exit(0);
          } else {
            console.error("HTTP " + res.statusCode + ": " + data);
            process.exit(2);
          }
        });
      });
      req.on("error", (e) => {
        console.error(e.message);
        process.exit(3);
      });
      req.on("timeout", () => {
        req.destroy();
        process.exit(4);
      });
      req.write(payload);
      req.end();
    });
  ' 2>&1)
  NODE_EXIT=$?
  set -e

  if [ $NODE_EXIT -eq 0 ]; then
    DELIVERY_SUCCESS=1
  else
    HTTP_BODY="$NODE_OUT"
  fi
fi

if [ $DELIVERY_SUCCESS -eq 1 ]; then
  echo "[Shelfmark Hook] Successfully notified companion bridge."
  exit 0
else
  # CRITICAL SAFETY: Shelfmark marks tasks as Error if the custom script exits with non-zero.
  # If the companion service is temporarily down, unreachable, or restarts, we must NOT fail the
  # download in Shelfmark. Log a clear warning and exit 0; companion reconciliation will recover it.
  echo "[Shelfmark Hook] Warning: Companion bridge unreachable or returned error ($HTTP_BODY)." >&2
  echo "[Shelfmark Hook] Exiting 0 to preserve completed task in Shelfmark. Reconciliation will recover." >&2
  exit 0
fi
