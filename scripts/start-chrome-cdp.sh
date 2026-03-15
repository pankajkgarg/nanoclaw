#!/bin/bash
# Start Chrome with CDP remote debugging for NanoClaw container agents.
# Uses a dedicated Chrome profile (never the user's default profile).
#
# Chrome runs HEADED (visible window) by default so you can:
# - Solve captchas when agents encounter them
# - Log into sites that need authentication
# - See what agents are doing in real-time
#
# Chrome only binds CDP to localhost, so a Node.js TCP proxy exposes it
# on 0.0.0.0 for Docker containers to reach via host.docker.internal.
#
# Usage:
#   ./scripts/start-chrome-cdp.sh              # visible window (default)
#   ./scripts/start-chrome-cdp.sh --headless   # no window (background use)
#
# Environment:
#   CDP_PORT  — external port for container access (default: 9222)

set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
HEADLESS=false

# Chrome binds to localhost only (ignores --remote-debugging-address on macOS).
# Use an internal port for Chrome, expose externally via TCP proxy.
CHROME_INTERNAL_PORT=$((CDP_PORT + 1))

for arg in "$@"; do
  case "$arg" in
    --headless) HEADLESS=true ;;
    --help|-h)
      echo "Usage: $0 [--headless]"
      echo ""
      echo "Start Chrome with CDP remote debugging on port \$CDP_PORT (default: 9222)."
      echo "Uses a dedicated profile at data/chrome-cdp/ (never your default Chrome profile)."
      echo "Runs with a visible window by default so you can interact (login, captcha)."
      echo ""
      echo "Options:"
      echo "  --headless   Run without a visible window"
      echo ""
      echo "Environment:"
      echo "  CDP_PORT   External debugging port (default: 9222)"
      exit 0
      ;;
  esac
done

# Resolve project root (parent of scripts/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_DIR="$PROJECT_ROOT/data/chrome-cdp"

# Create profile directory if needed
mkdir -p "$PROFILE_DIR"

# Detect Chrome binary
detect_chrome() {
  if [[ "$OSTYPE" == darwin* ]]; then
    local app="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if [[ -x "$app" ]]; then
      echo "$app"
      return
    fi
  fi

  # Linux / fallback
  for bin in google-chrome google-chrome-stable chromium-browser chromium; do
    if command -v "$bin" &>/dev/null; then
      echo "$bin"
      return
    fi
  done

  echo ""
}

CHROME="$(detect_chrome)"
if [[ -z "$CHROME" ]]; then
  echo "ERROR: Chrome/Chromium not found." >&2
  echo "Install Google Chrome or set the path manually." >&2
  exit 1
fi

# Check if port is already in use
if lsof -i ":$CDP_PORT" -sTCP:LISTEN &>/dev/null 2>&1; then
  echo "Port $CDP_PORT is already in use. Chrome CDP may already be running."
  echo "Check: curl -s http://localhost:$CDP_PORT/json/version"
  exit 1
fi

# Build Chrome flags
CHROME_FLAGS=(
  "--remote-debugging-port=$CHROME_INTERNAL_PORT"
  "--user-data-dir=$PROFILE_DIR"
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-background-networking"
  "--disable-default-apps"
)

if [[ "$HEADLESS" == "true" ]]; then
  # --no-startup-window prevents Chrome from opening a visible window.
  # Only used in headless mode; in headed mode we want the window.
  CHROME_FLAGS+=("--headless=new" "--no-startup-window")
fi

# Cleanup: kill Chrome (by port) and proxy on exit
cleanup() {
  # Kill proxy
  [[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null
  # Kill Chrome by finding the process on the internal port
  local chrome_pid
  chrome_pid=$(lsof -ti ":$CHROME_INTERNAL_PORT" -sTCP:LISTEN 2>/dev/null || true)
  [[ -n "$chrome_pid" ]] && kill "$chrome_pid" 2>/dev/null
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

MODE="headed (visible window)"
[[ "$HEADLESS" == "true" ]] && MODE="headless"

echo "Starting Chrome CDP..."
echo "  Binary:  $CHROME"
echo "  Profile: $PROFILE_DIR"
echo "  Port:    $CDP_PORT (external) -> $CHROME_INTERNAL_PORT (Chrome internal)"
echo "  Mode:    $MODE"
echo ""

# Launch Chrome (it may fork — the original PID might exit, but Chrome keeps running)
"$CHROME" "${CHROME_FLAGS[@]}" &

# Wait for Chrome CDP to become available on internal port
for i in $(seq 1 30); do
  if curl -s "http://localhost:$CHROME_INTERNAL_PORT/json/version" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -s "http://localhost:$CHROME_INTERNAL_PORT/json/version" > /dev/null 2>&1; then
  echo "ERROR: Chrome failed to start CDP on port $CHROME_INTERNAL_PORT" >&2
  exit 1
fi

# Start TCP proxy: 0.0.0.0:CDP_PORT -> localhost:CHROME_INTERNAL_PORT
# Chrome ignores --remote-debugging-address on macOS, so we proxy to expose
# the CDP port on all interfaces for Docker container access.
node -e "
const net = require('net');
const server = net.createServer((client) => {
  const target = net.connect($CHROME_INTERNAL_PORT, '127.0.0.1', () => {
    client.pipe(target);
    target.pipe(client);
  });
  target.on('error', () => client.destroy());
  client.on('error', () => target.destroy());
});
server.listen($CDP_PORT, '0.0.0.0', () => {
  console.log('TCP proxy: 0.0.0.0:$CDP_PORT -> 127.0.0.1:$CHROME_INTERNAL_PORT');
});
server.on('error', (err) => {
  console.error('Proxy error:', err.message);
  process.exit(1);
});
" &
PROXY_PID=$!
sleep 1

# Verify external port is accessible
if ! curl -s "http://localhost:$CDP_PORT/json/version" > /dev/null 2>&1; then
  echo "ERROR: TCP proxy failed to start on port $CDP_PORT" >&2
  exit 1
fi

VERSION=$(curl -s "http://localhost:$CDP_PORT/json/version" | grep -o '"Browser"[^,]*' | head -1)
echo "Chrome CDP ready: http://localhost:$CDP_PORT"
echo "  $VERSION"
echo ""
echo "Container agents connect via socat forwarding (localhost:$CDP_PORT inside container)."
echo ""
echo "Press Ctrl+C to stop."

# Keep the script alive by waiting on the proxy (Node.js stays alive reliably).
# If Chrome dies, the proxy will start failing connections but won't crash.
wait "$PROXY_PID"
