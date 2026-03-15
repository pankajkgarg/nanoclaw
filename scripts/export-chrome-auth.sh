#!/bin/bash
# Export auth state from the dedicated NanoClaw Chrome (data/chrome-cdp/ profile)
# into a state file that container agents can use.
#
# Prerequisites: Chrome CDP running (./scripts/start-chrome-cdp.sh)
#
# Usage:
#   ./scripts/export-chrome-auth.sh

set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AUTH_STATE="$PROJECT_ROOT/data/chrome-cdp/auth-state.json"

# Check Chrome CDP is running
if ! curl -s --connect-timeout 3 "http://localhost:$CDP_PORT/json/version" > /dev/null 2>&1; then
  echo "ERROR: Chrome CDP not running on port $CDP_PORT" >&2
  echo "Start it with: ./scripts/start-chrome-cdp.sh" >&2
  exit 1
fi

echo "Exporting auth state from dedicated NanoClaw Chrome..."
agent-browser connect "http://localhost:$CDP_PORT" 2>&1
agent-browser state save "$AUTH_STATE" 2>&1

SIZE=$(wc -c < "$AUTH_STATE" | tr -d ' ')
COOKIES=$(python3 -c "import json; d=json.load(open('$AUTH_STATE')); print(len(d.get('cookies',[])))" 2>/dev/null || echo "?")

echo ""
echo "Auth state exported:"
echo "  File:    $AUTH_STATE"
echo "  Size:    $SIZE bytes"
echo "  Cookies: $COOKIES"
echo ""
echo "Container agents will automatically load this on next launch."
