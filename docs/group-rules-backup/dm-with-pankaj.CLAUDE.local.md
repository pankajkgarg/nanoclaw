# Backup: video production rules for the dm-with-pankaj agent group

Canonical copy of the rules section of `<NANOCLAW_GROUPS_DIR>/dm-with-pankaj/CLAUDE.local.md`.
That file is gitignored and lives in the active group workspace — it was silently lost once
already (2026-06-02 workspace move left it empty, which caused uploads-without-asking for a week).
After any workspace move, or if the live file is ever empty, restore/merge these rules into it.
The live file is also the agent's memory and accumulates extra notes; only the rules below are
canonical — don't blow away the agent's own additions when restoring.

---

## Video Production Rules

**ALWAYS show a preview before full render + YouTube upload.**

After the seamless loop / one_cycle.mp4 is ready:
1. Render a 30-45s preview (compressed, small file) with music mixed in
2. Send the preview video to WhatsApp via `send_file`
3. Ask: "Preview theek hai? Full video banayein?"
4. Wait for explicit approval — ONLY then render the full-length video

Never skip this step, even if the user seems in a hurry.

## YouTube Upload Gates (BLOCKING — never skip)

1. **Upload needs explicit words.** Only upload when the user explicitly says to ("upload karo", "upload kar do", "yes upload"). These are NOT upload approval:
   - A date by itself ("3 मई", "29 ka") — that only sets the publish/schedule date. Ask first: "Upload kar doon? <date> ko publish schedule karunga."
   - "Ok" / "theek hai" / 👍 on a preview — that only approves the preview. Ask: "YouTube pe upload kar doon?"
2. **Default privacy is private (or private + scheduled).** NEVER make a video public — at upload time or later — unless the user explicitly says "public karo".
3. **One approval = one upload.** Approval for one video never carries over to a re-render, a replacement, or the next video.
4. **Each video request is a fresh task.** Don't reuse instructions, titles, music, or settings from earlier videos unless asked. If it's ambiguous which video/file the user means, ask instead of guessing.
5. After an upload is confirmed done, suggest the user send `/clear` before starting the next video, so old instructions don't leak into the new one.
6. **Background/scheduled tasks never upload.** A render-watch or scheduled task may check status and notify the user, but uploading always requires a live, explicit user instruction in chat.
