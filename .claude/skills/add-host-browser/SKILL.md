---
name: add-host-browser
description: Set up a dedicated host Chrome browser with CDP for container agents. Use when the user wants agents to control a real Chrome browser for captcha solving or sites requiring login sessions.
---

# Add Host Browser (Chrome CDP)

This skill sets up a dedicated Chrome instance on the host machine so container agents can:
- **Access logged-in sites** via auth state auto-loading (cookies exported from Chrome -> loaded into sandboxed browser)
- **Solve captchas** via CDP relay (agent controls the visible Chrome window, user solves captcha)

Chrome runs **headed** (visible window) so the user can see what agents are doing and interact when needed.

**Principle:** Do the work — don't tell the user to run commands themselves. Only pause for actions that genuinely require their input.

## Phase 1: Pre-flight

### Check if already configured

```bash
test -d data/chrome-cdp && echo "CDP_PROFILE_EXISTS=true" || echo "CDP_PROFILE_EXISTS=false"
test -f data/chrome-cdp/auth-state.json && echo "AUTH_STATE_EXISTS=true" || echo "AUTH_STATE_EXISTS=false"
grep -q 'CDP_ENABLED=1' .env 2>/dev/null && echo "CDP_ENV_CONFIGURED=true" || echo "CDP_ENV_CONFIGURED=false"
```

If all are true, skip to Phase 5 (Test).

### Detect Chrome

```bash
if [[ "$OSTYPE" == darwin* ]]; then
  test -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" && echo "CHROME_FOUND=true" || echo "CHROME_FOUND=false"
else
  (command -v google-chrome || command -v chromium-browser || command -v chromium) && echo "CHROME_FOUND=true" || echo "CHROME_FOUND=false"
fi
```

If Chrome is not found, tell the user:
> Chrome is required for host browser CDP. Please install Google Chrome and re-run this setup.

Stop here if Chrome is not installed.

## Phase 2: Create Dedicated Chrome Profile

Create the profile directory and do a test launch to initialize it:

```bash
mkdir -p data/chrome-cdp
./scripts/start-chrome-cdp.sh &
CDP_PID=$!
sleep 5

# Verify CDP is running
curl -s http://localhost:${CDP_PORT:-9222}/json/version

# Kill the test instance
kill $CDP_PID 2>/dev/null
wait $CDP_PID 2>/dev/null || true
```

The profile is now initialized at `data/chrome-cdp/`.

## Phase 3: Configure .env

Add CDP settings to `.env` (if not already present):

```bash
grep -q 'CDP_ENABLED' .env 2>/dev/null || cat >> .env << 'EOF'

# Host Chrome CDP for container agents
CDP_ENABLED=1
CDP_PORT=9222
EOF
```

## Phase 4: Login Sessions

Use `AskUserQuestion`: Would you like to open Chrome now to log into websites your agents will need? (You can do this later by running `./scripts/start-chrome-cdp.sh`)

If yes, tell the user:

> Starting Chrome with the dedicated NanoClaw profile. Log into any sites your agents need to access (GitHub, Suno, etc.). When done, come back here and tell me.

```bash
./scripts/start-chrome-cdp.sh &
CDP_PID=$!
```

Wait for user to confirm they're done logging in.

### Export auth state

After the user is done (or if they skip login):

```bash
./scripts/export-chrome-auth.sh
```

This exports cookies and storage to `data/chrome-cdp/auth-state.json`. Container agents automatically load this file — no manual steps needed at runtime.

```bash
# Stop the Chrome instance
kill $CDP_PID 2>/dev/null
wait $CDP_PID 2>/dev/null || true
```

## Phase 5: End-to-end Test

This is the critical step — verify everything works from inside a container.

### Ensure container image is built

```bash
docker images nanoclaw-agent:latest --format '{{.Repository}}' | grep -q nanoclaw-agent || ./container/build.sh
```

### Start Chrome CDP

```bash
./scripts/start-chrome-cdp.sh &
CDP_PID=$!
sleep 5
```

### Run the CDP connectivity test

```bash
./scripts/test-chrome-cdp.sh
```

This test:
1. Checks host Chrome is listening on the CDP port
2. Spawns a Docker container with socat forwarding
3. Runs `agent-browser connect http://localhost:9222` inside the container
4. Opens `https://example.com` and reads the page title
5. Reports PASS or FAIL with troubleshooting steps

### Stop test Chrome

```bash
kill $CDP_PID 2>/dev/null
wait $CDP_PID 2>/dev/null || true
```

**If the test fails**, check:
1. Chrome is bound to `0.0.0.0` via the TCP proxy (check `lsof -i :9222`)
2. Container image has socat installed (`./container/build.sh` to rebuild)
3. No firewall blocking port 9222
4. Docker Desktop is running

**Do not proceed if the test fails.** Debug the connectivity issue first.

## Phase 6: Launchd Auto-start & Done

### Install launchd plist (macOS only)

If on macOS, offer to install the Chrome CDP launchd plist for auto-start:

```bash
if [[ "$OSTYPE" == darwin* ]]; then
  # Fill in template placeholders
  NODE_PATH=$(which node)
  PROJECT_ROOT=$(pwd)
  HOME_DIR=$HOME

  sed -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
      -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
      -e "s|{{HOME}}|$HOME_DIR|g" \
      launchd/com.nanoclaw-chrome.plist > ~/Library/LaunchAgents/com.nanoclaw-chrome.plist

  launchctl load ~/Library/LaunchAgents/com.nanoclaw-chrome.plist
  echo "Chrome CDP will now start automatically on login."
fi
```

### Summary

Tell the user:

> Host browser integration is ready! Two mechanisms are now available to your agents:
>
> **Login sessions** (automatic): Cookies from the dedicated Chrome are loaded into the sandboxed browser. Sites you logged into will be accessible without any extra steps.
>
> **Captcha solving** (fallback): When a site blocks the agent, it can switch to controlling your host Chrome via CDP. The browser window is visible so you can solve captchas.
>
> To use it:
> 1. Start Chrome: `./scripts/start-chrome-cdp.sh` (or auto-starts via launchd)
> 2. Start NanoClaw: `npm run dev`
>
> To update login sessions after logging into new sites: `./scripts/export-chrome-auth.sh`
