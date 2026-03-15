#!/bin/bash
# End-to-end test: verify a container agent can reach the host Chrome via CDP
# using the full relay chain:
#   Host Chrome → TCP proxy (0.0.0.0) → Docker network → socat (container) → agent-browser
#
# Usage:
#   ./scripts/test-chrome-cdp.sh
#
# Prerequisites:
#   - Chrome CDP running (./scripts/start-chrome-cdp.sh)
#   - Container image built (./container/build.sh)

set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Detect container runtime
RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "=== Chrome CDP Connectivity Test ==="
echo ""

# Step 1: Check host Chrome is running
echo "1. Checking host Chrome CDP on port $CDP_PORT..."
if ! curl -s --connect-timeout 3 "http://localhost:$CDP_PORT/json/version" > /dev/null 2>&1; then
  echo "   FAIL: Chrome CDP not running on port $CDP_PORT"
  echo "   Start it with: ./scripts/start-chrome-cdp.sh"
  exit 1
fi
VERSION=$(curl -s "http://localhost:$CDP_PORT/json/version" | grep -o '"Browser"[^,]*' | head -1)
echo "   OK: $VERSION"
echo ""

# Step 2: Determine gateway and runtime args
if [[ "$RUNTIME" == "container" ]]; then
  GATEWAY="192.168.64.1"
else
  GATEWAY="host.docker.internal"
fi

echo "2. Container runtime: $RUNTIME"
echo "   Host gateway: $GATEWAY"
echo ""

# Build runtime-specific args
EXTRA_ARGS=()
if [[ "$RUNTIME" != "container" ]] && [[ "$(uname -s)" == "Linux" ]]; then
  # On Linux Docker, host.docker.internal isn't built-in — add it explicitly.
  EXTRA_ARGS=(--add-host=host.docker.internal:host-gateway)
fi

# Step 3: Run agent-browser connect inside a container with socat forwarding
echo "3. Testing CDP connection from inside container..."
echo ""

CONTAINER_NAME="nanoclaw-cdp-test-$$"

TEST_SCRIPT="
set -e
echo '  Starting socat forwarding (localhost:$CDP_PORT -> $GATEWAY:$CDP_PORT)...'
socat TCP-LISTEN:$CDP_PORT,fork,reuseaddr TCP:$GATEWAY:$CDP_PORT &
SOCAT_PID=\$!
sleep 1

# Verify socat is forwarding
if ! curl -s --connect-timeout 3 http://localhost:$CDP_PORT/json/version > /dev/null 2>&1; then
  echo '  FAIL: socat forwarding not working'
  echo '  Cannot reach host Chrome at $GATEWAY:$CDP_PORT'
  kill \$SOCAT_PID 2>/dev/null || true
  exit 1
fi
echo '  socat forwarding OK'

echo '  Connecting to host Chrome via CDP...'
agent-browser connect 'http://localhost:$CDP_PORT' 2>&1

echo '  Warmup navigation (first request after CDP connect may fail)...'
agent-browser open 'about:blank' 2>/dev/null || true
sleep 1

echo '  Opening https://example.com...'
agent-browser open 'https://example.com' 2>&1

echo '  Reading page title...'
TITLE=\$(agent-browser get title 2>&1)
echo \"  Title: \$TITLE\"

kill \$SOCAT_PID 2>/dev/null || true
echo 'CDP_TEST_PASSED'
"

RESULT=$($RUNTIME run -i --rm \
  --name "$CONTAINER_NAME" \
  -e "NODE_OPTIONS=--dns-result-order=ipv4first" \
  -e "CDP_ENABLED=1" \
  -e "CDP_PORT=$CDP_PORT" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} \
  --entrypoint /bin/bash \
  nanoclaw-agent:latest \
  -c "$TEST_SCRIPT" 2>&1) || true

echo "$RESULT"
echo ""

if echo "$RESULT" | grep -q "CDP_TEST_PASSED"; then
  echo "=== TEST PASSED ==="
  echo ""
  echo "Container agents can successfully reach host Chrome via CDP."
  echo "The full relay chain works:"
  echo "  Host Chrome -> TCP proxy (0.0.0.0:$CDP_PORT) -> Docker -> socat (container) -> agent-browser"
  echo ""
  if ! grep -q 'CDP_ENABLED=1' "$PROJECT_ROOT/.env" 2>/dev/null; then
    echo "To enable for NanoClaw, add to .env:"
    echo "  CDP_ENABLED=1"
    echo "  CDP_PORT=$CDP_PORT"
  fi
else
  echo "=== TEST FAILED ==="
  echo ""
  echo "Troubleshooting:"
  echo "  1. Is Chrome running? curl -s http://localhost:$CDP_PORT/json/version"
  echo "  2. Is the TCP proxy exposing port $CDP_PORT on 0.0.0.0?"
  echo "     Check: lsof -i :$CDP_PORT"
  echo "  3. Can the container reach the host?"
  echo "     Try: $RUNTIME run --rm --entrypoint curl nanoclaw-agent:latest -s http://$GATEWAY:$CDP_PORT/json/version"
  echo "  4. Is the container image built?"
  echo "     Run: ./container/build.sh"
  exit 1
fi
