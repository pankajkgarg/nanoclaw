---
name: suno-music
description: Generate music with Suno AI via browser automation. Use when the user wants custom music, instrumentals, or songs created.
allowed-tools: Bash(agent-browser:*), Bash(curl:*), Bash(ffmpeg:*)
---

# Music Generation with Suno AI

Generate custom music tracks using Suno via browser automation. Always use the **host browser via CDP** for persistent login and CAPTCHA handling.

## Creative workflow

**Always include the user in creative decisions:**

1. Propose a music prompt describing genre, mood, instruments, tempo
2. Share the prompt with the user and ask for feedback before generating
3. After generation, save the track in the agent workspace
4. Ask if they want adjustments or a different variation

## Browser setup

Always connect to the **host browser** (CDP mode), not the container browser. This preserves login sessions and allows the user to solve CAPTCHAs if needed.

```bash
agent-browser open https://suno.com/create --cdp
```

## Generation workflow

1. Navigate to `https://suno.com/create`
2. Check login status — if logged out, inform the user they need to authenticate in the host browser
3. Enable **instrumental mode** if no vocals are needed
4. Enter the music prompt
5. Select **v5** model (requires Pro account, 2500 credits)
6. Click "Create" — generates 2 variations (~3-8 min each)
7. Wait for generation to complete (watch for progress indicators)
8. Extract song IDs from page links: `document.querySelectorAll('a[href*="/song/"]')`
9. Download via CDN: `curl -L https://cdn1.suno.ai/{SONG_ID}.mp3 -o /workspace/agent/music.mp3`
10. Tell the user where it was saved, or deliver it with the available file tool if they explicitly need it in chat

## Known issues

### CAPTCHA
hCaptcha frequently appears when clicking "Create". It sometimes auto-solves. If it persists:
- The user may need to solve it manually in the host browser
- Alternative: extract JWT via `window.Clerk.session.getToken()` in browser console and use the Suno API directly with curl

### Login expiry
Suno sessions expire periodically. If you see "Sign In" / "Sign Up" buttons, inform the user they need to re-authenticate in the host browser. Do not attempt to log in with stored credentials.

### Credit limits
- v5 requires Pro account (10 credits per generation = 2 songs)
- Check remaining credits on the Create page before generating
- If credits are low, inform the user

## Prompt patterns

Adapt these to the user's preferences:

- **Indian classical**: "Indian classical meditation music, tabla rhythm, bansuri flute melody, sitar accompaniment, raag yaman, peaceful and spiritual, no vocals, temple atmosphere"
- **Ambient/atmospheric**: "Ambient atmospheric soundscape, slow evolving pads, ethereal textures, peaceful and immersive, no vocals"
- **Cinematic**: "Cinematic orchestral score, sweeping strings, dramatic brass, building intensity, film trailer style"
- **Lo-fi**: "Lo-fi hip hop beat, mellow piano chords, vinyl crackle, relaxed jazzy vibes, study music"
- **Electronic**: "Electronic chillwave, retro synth arpeggios, smooth bassline, dreamy pads, 110 BPM"

## Saving

- Always download the .mp3 into `/workspace/agent` or a project subfolder
- Suno URLs and CDN links can expire, so keep a local copy
- If sending both variations, label them (e.g., "Variation 1" and "Variation 2") so the user can pick
