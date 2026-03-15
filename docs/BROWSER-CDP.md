# Host Browser Integration

Two mechanisms let container agents access sites that block the sandboxed Chromium:

1. **Auth state auto-loading** — login sessions from the dedicated NanoClaw Chrome are exported and automatically loaded into the sandboxed browser. Best for logged-in sites.
2. **CDP relay** — agents connect to the host Chrome directly via CDP. Best for captcha solving where the user needs to interact with the browser.

## Quick Setup

Run the setup skill:

```
/add-host-browser
```

This handles Chrome detection, dedicated profile creation, auth export, .env config, and runs end-to-end tests.

## Manual Setup

### 1. Start the dedicated Chrome

```bash
./scripts/start-chrome-cdp.sh
# Chrome opens with a visible window — log into sites your agents need
```

Chrome runs with a dedicated profile at `data/chrome-cdp/`, completely isolated from your personal Chrome.

### 2. Export login sessions

After logging into sites in the dedicated Chrome:

```bash
./scripts/export-chrome-auth.sh
```

This saves cookies and storage to `data/chrome-cdp/auth-state.json`. Container agents automatically load this file via `AGENT_BROWSER_STATE` — no manual steps needed at runtime.

### 3. Enable CDP relay (optional, for captchas)

```bash
echo 'CDP_ENABLED=1' >> .env
echo 'CDP_PORT=9222' >> .env
```

With Chrome running, agents can connect via `agent-browser connect http://localhost:9222` to control the host Chrome directly. The browser window is visible so you can solve captchas.

### 4. Test

```bash
# Test CDP connectivity from inside a container
./scripts/test-chrome-cdp.sh
```

## How It Works

### Mechanism 1: Auth State (Login Sessions)

```
Host Chrome (data/chrome-cdp/ profile)
  │
  │  ./scripts/export-chrome-auth.sh
  │
  ▼
data/chrome-cdp/auth-state.json
  │
  │  Mounted read-only at /workspace/browser-auth/
  │  AGENT_BROWSER_STATE=/workspace/browser-auth/auth-state.json
  │
Container sandboxed Chromium:
  agent-browser open https://example.com  ← already logged in
```

The sandboxed browser loads cookies and storage from the auth state file on launch. Sites see the same session as the dedicated Chrome — no CDP connection needed at runtime.

**Re-export after logging in/out**: Run `./scripts/export-chrome-auth.sh` again to update the auth state. New containers will pick up the updated state automatically.

### Mechanism 2: CDP Relay (Captchas)

```
Host Chrome (data/chrome-cdp/ profile, visible window, port 9222)
  │
  │  Node.js TCP proxy (0.0.0.0:9222, host-side)
  │
  │  Docker network
  │
  │  socat (container: localhost:9222 → host.docker.internal:9222)
  │
Container agent:
  agent-browser connect http://localhost:9222
  agent-browser open https://protected-site.com  ← visible on your screen
  # User solves captcha in the Chrome window
  agent-browser snapshot -i  ← reads result
```

The relay chain uses #832's socat forwarding approach: container-side socat makes `localhost:9222` forward to the host Chrome. This means Chrome's WebSocket discovery URL (`ws://localhost:9222/...`) works correctly inside the container without URL rewriting.

CDP creates an incognito-like context — login cookies are NOT shared. Use CDP only for captcha solving, not for accessing logged-in sites.

**Important**: Do NOT use `agent-browser close` when connected via CDP — it kills the host Chrome. Just stop issuing commands.

## Agent Decision Tree

Container agents follow this priority:

1. **Default**: Use the sandboxed `agent-browser` (isolated Chromium inside the container)
2. **Login needed**: If `AGENT_BROWSER_STATE` is set, the sandboxed browser already has login sessions — just use it normally
3. **Captcha/bot block**: If `CDP_ENABLED` is `1`, switch to CDP to let the user solve the captcha

## Running

Start Chrome in a terminal (or via launchd auto-start):

```bash
./scripts/start-chrome-cdp.sh           # visible window (default)
./scripts/start-chrome-cdp.sh --headless # no window (background use)
```

Then start NanoClaw normally:

```bash
npm run dev
```

### Auto-start with launchd (macOS)

The setup skill installs `com.nanoclaw-chrome.plist` into `~/Library/LaunchAgents/` for auto-start on login.

```bash
# Manual management
launchctl load ~/Library/LaunchAgents/com.nanoclaw-chrome.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw-chrome.plist
```

## Security

- **Dedicated profile**: Chrome runs with its own profile at `data/chrome-cdp/`, completely isolated from your personal Chrome. Your browsing history, passwords, and cookies are never exposed.
- **Auth state file**: `data/chrome-cdp/auth-state.json` contains cookies from the dedicated profile only. It's mounted read-only into containers.
- **Network exposure**: The TCP proxy binds to `0.0.0.0` so Docker containers can reach it. On macOS Docker Desktop, this is accessible from the local machine and Docker VM only. Do not expose port 9222 to the internet.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CDP_ENABLED` | (unset) | Set to `1` to enable CDP relay for captcha solving |
| `CDP_PORT` | `9222` | Chrome debugging port |

## Troubleshooting

Run the connectivity test:

```bash
./scripts/test-chrome-cdp.sh
```

If it fails, check:
1. Chrome is running: `curl -s http://localhost:9222/json/version`
2. TCP proxy is bound to `0.0.0.0`: `lsof -i :9222`
3. Container can reach host: `docker run --rm --entrypoint curl nanoclaw-agent:latest -s http://host.docker.internal:9222/json/version`
4. Container image has socat: `docker run --rm --entrypoint which nanoclaw-agent:latest socat`
5. Container image is built: `./container/build.sh`

**ERR_NETWORK_CHANGED**: The first navigation after `agent-browser connect` (CDP) sometimes fails with this error. A warmup `about:blank` navigation absorbs it. Agent skills document this pattern.
