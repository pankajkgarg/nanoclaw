---
name: browser-cdp
description: Control the host Chrome browser via CDP for login sessions and captcha solving. After the user logs in via CDP, export auth state so future runs use the sandboxed browser automatically.
allowed-tools: Bash(agent-browser:*)
---

# Host Browser Integration

## Decision tree

1. **`$AGENT_BROWSER_STATE` is set** → login sessions already loaded, use sandboxed browser normally, skip CDP entirely
2. **Site needs login / hits captcha** → use CDP to open in host Chrome, let user interact, then export auth state
3. **Future runs** → auth state is loaded automatically, no CDP needed

## Using CDP (login + captcha)

CDP is available when `$CDP_ENABLED=1`. Connect to host Chrome, let the user log in or solve the captcha, then immediately export state so future runs are fully automatic.

```bash
# 1. Connect to host Chrome
agent-browser connect "http://localhost:${CDP_PORT:-9222}"

# 2. Warmup (first navigation after connect may fail with ERR_NETWORK_CHANGED)
agent-browser open "about:blank" 2>/dev/null || true
sleep 1

# 3. Open the target site — user sees it and can log in / solve captcha
agent-browser open https://example.com
agent-browser snapshot -i
```

Tell the user: "I've opened [site] in your Chrome browser. Please log in (or solve the captcha) and let me know when you're done."

Wait for confirmation, then:

```bash
# 4. Export auth state so future containers load it automatically
AUTH_STATE="${AGENT_BROWSER_STATE:-/workspace/browser-auth/auth-state.json}"
agent-browser state save "$AUTH_STATE"
echo "Auth state saved to $AUTH_STATE"
```

Tell the user: "Login saved. Future agents will access [site] automatically without needing Chrome."

## After exporting state

Switch back to the sandboxed browser for any remaining work in this session:

```bash
# agent-browser automatically starts a fresh sandboxed instance on next open
agent-browser open https://example.com
agent-browser snapshot -i  # should show logged-in state via loaded auth
```

## Important CDP notes

- The host Chrome uses a **dedicated NanoClaw profile** (`data/chrome-cdp/`) — not the user's personal Chrome
- Pages opened via CDP are visible on the host machine's display
- **Do NOT use `agent-browser close` when connected via CDP** — it kills the host Chrome
- Cookies set during a CDP session persist to the profile and are exported with `state save`
- After calling `agent-browser state save`, the exported file is automatically loaded into future containers via `$AGENT_BROWSER_STATE`
