---
name: video-maker
description: Create meditation/ambient/devotional videos from text descriptions. Full pipeline from concept to YouTube-ready video. Orchestrates image generation (fal.ai), animation (Kling), music (Suno via user), and assembly (ffmpeg). Use when the user asks to make, create, or produce a video. Also handles post-production (YouTube title, description, thumbnail).
allowed-tools: Bash(python3:*), Bash(ffmpeg:*), Bash(ffprobe:*), Bash(pnpm:*), Bash(npx:*), Bash(remotion:*), Bash(agent-browser:*), Bash(curl:*)
---

# Video Maker

End-to-end pipeline for creating meditation, ambient, devotional, and nature videos. From concept to YouTube-ready output with thumbnail.

## Prerequisites

```bash
pip install fal-client
```
Also requires: ffmpeg, ffprobe (pre-installed in container).
For Ken Burns, slideshows, and title cards, use the **remotion-video** skill.

## Project Folder Structure

Every video gets its own folder. 
* All assets for one video live together:

```
/workspace/agent/<video_name>/
├── img1.jpg, img2.jpg         # Generated hero images (user picks one)
├── hero.jpg                   # The chosen image
├── animated_5s.mp4            # First 5s animated clip
├── last_frame.jpg             # Extracted last frame
├── bridge_5s.mp4              # Bridge clip (last_frame → hero.jpg)
├── seamless_loop.mp4          # Concatenated ~10s loop
├── music.mp3                  # Downloaded Suno track
├── preview_40s.mp4            # 40s preview for user approval
├── <video_name>_10min.mp4     # Full duration final video
├── thumbnail.jpg              # YouTube thumbnail (1280x720)
└── youtube_info.txt           # Title, description, tags for YouTube
```

Create the folder at the start: `mkdir -p /workspace/agent/<video_name>/`
* When you choose to create a new folder for a new video, mention in which folder you are placing the assets to the user. 


## Creative Workflow (CRITICAL)
**The user MUST be included in creative decision.** e.g. what kind of photo to make

Pattern: **propose → get approval → generate → share result → get approval → next step**

## Full Pipeline

### STEP 1: Concept — Ask Theme & Duration

Ask what kind of video, currently we make two kinds: Instrumental and hindi devotional. (Present these choices in hindi/hinglish depending upon how user is talking)

Be open-ended — suggest ideas tailored to context, NOT a fixed list. Draw on anything: deities, nature, seasons, places, festivals, moods, specific scenes. Always generate fresh, unique, varied suggestions.

After theme is decided, ask duration: 5 / 10 / 15 / 30 minutes.

### STEP 2: Static or Animated? (ALWAYS ASK)

**Before generating anything, ask:**

"Static image या Animated video?"
- 🖼️ **Static** — image + music (cheaper, faster)
- 🎬 **Animated** — AI motion: flames flicker, water ripples, leaves sway (more expensive, takes longer)


Video with static style should have two images and use Ken burns effect (in the past 18% zoom or 15s cycles worked, use remotion skill).


**Tool split:**
- **Remotion** — Ken Burns static path, title cards, animated text, compositing, and multi-image slideshows.
- **ffmpeg** — frame extraction, concat, looping a base clip to target duration, audio mux, preview transcode.

### STEP 3: Generate Hero Images

Generate 2 images using fal-image skill (fal-ai/flux-2-pro, landscape_16_9).

Craft vivid, specific prompts. See references/image-prompts.md for example templates — but always customize to the user's specific theme. Those are starting points, not a fixed set.

Share both images with user.
* In animated style: Ask which one they prefer, or new images should be generated.
* In static mode: At least 2 images are needed, so ask if both are ok to make video, otherwise generate more.

If user asks for more, generate additional options. Save all to the project folder.
Save the chosen image as `hero.jpg`.

**Image style guidance**: Cinematic, photorealistic, 8K. Warm color palettes work well for devotional/meditation themes (deep amber, gold, earth browns, magenta accents). Cool palettes for night/winter (indigo, silver, moonlight blue). Specify lightning/atmosphere etc. Though, when creating images with person/gods, photorealistic is not necessariliy the best choice. 

### STEP 4a: Animated Video Path — Seamless Loop

**NEVER use boomerang (ffmpeg -vf reverse). NEVER.** If fal.ai balance is empty, pause and inform user. Do not fall back to reverse.

1. Generate 5s clip:
   ```python
   fal_client.subscribe('fal-ai/kling-video/v3/pro/image-to-video', arguments={
       'start_image_url': hero_url,
       'prompt': 'subtle motion matching scene — e.g. candle flames flicker gently, water ripples softly, leaves sway imperceptibly',
       'duration': 5,
       'generate_audio': False,
       'cfg_scale': 0.7
   })
   ```
   The motion prompt should describe ONLY the movement, not the scene. Keep it subtle — cinemagraph-style. See references/image-prompts.md for animation prompt examples.

2. Extract last frame:
   ```bash
   ffmpeg -sseof -0.1 -i animated_5s.mp4 -frames:v 1 last_frame.jpg
   ```

3. Generate bridge clip (last_frame → hero.jpg):
   ```python
   fal_client.subscribe('fal-ai/kling-video/v3/pro/image-to-video', arguments={
       'start_image_url': last_frame_url,
       'end_image_url': hero_url,
       'prompt': 'gentle continuing movement, smooth transition',
       'duration': 5,
       'generate_audio': False
   })
   ```

4. Concatenate into seamless loop:
   ```bash
   printf "file 'animated_5s.mp4'\nfile 'bridge_5s.mp4'" > concat.txt
   ffmpeg -f concat -safe 0 -i concat.txt -c copy seamless_loop.mp4
   ```

### STEP 4b: Static Video Path — Ken Burns via Remotion

For static videos, use the **remotion-video** skill to render `static_loop.mp4`.

Scaffold a small Remotion project in `/workspace/agent/<video_name>/`:
- `package.json` plus `src/index.tsx`
- one `Composition` at 1920x1080, 25fps, 30s
- render `hero.jpg` with slow `scale`/translate animation via `interpolate`

Render:
```bash
pnpm exec remotion render src/index.tsx Main static_loop.mp4 \
  --browser-executable=/usr/bin/chromium \
  --codec=h264
```

### STEP 5: Music via Suno

The agent does NOT generate music directly. The user generates on Suno and shares the link.

Provide a tailored Suno prompt. Include:
- Instruments suited to theme (bansuri flute, sitar, tabla, harmonium, tanpura drone, bells, conch shell, singing bowls, etc.)
- Mood (peaceful, devotional, meditative, serene)
- Style (Indian classical, ambient, nature sounds, devotional raga)
- Whether instrumental or with lyrics/chanting
- If vocal: suggest lyrics text (e.g. "Om... Om Shanti Om... Om Namah Shivaya...")

**Suno music characteristics to aim for:**
- BPM: 120-130 (measured, meditative — not fast)
- Key: F or C major (warm, devotional)
- Energy: consistent, no dramatic drops or peaks
- Suno can only generate ~3-5 min tracks; for longer videos, music will be looped

Example instruction to user:
```
🔗 https://suno.com/create पर जाएं
📝 Style: "Indian temple music, bells, harmonium, sitar, soft tabla, devotional, peaceful, instrumental"
📝 Lyrics blank रखें (instrumental)
🎵 Title: "Temple Morning"
Link share करें!
```

When user shares link, download automatically using this method:

### Suno Auto-Download Method (browser + python)

**Step 1:** Navigate to the share URL — it redirects and reveals the UUID:
```
https://suno.com/s/SHARE_ID  →  https://suno.com/song/UUID?sh=SHARE_ID
```
The UUID in the redirected URL is the song ID.

**Step 2:** Extract UUID from page HTML using browser_console:
```javascript
let html = document.documentElement.innerHTML;
let matches = html.match(/https:\/\/cdn1\.suno\.ai\/[a-f0-9\-]+\.mp3/g);
// Returns e.g. ["https://cdn1.suno.ai/0104af35-7db7-4904-8b8d-7ac9da4c11fa.mp3"]
```

**Step 3:** Download with Python urllib (must set Referer + Origin headers):
```python
import urllib.request
url = 'https://cdn1.suno.ai/UUID.mp3'
req = urllib.request.Request(url, headers={
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Referer': 'https://suno.com/',
    'Origin': 'https://suno.com'
})
with urllib.request.urlopen(req) as r:
    with open('/workspace/agent/.../music.mp3', 'wb') as f:
        f.write(r.read())
```

⚠️ NOTE: curl (command not found in container) — use Python urllib instead.
⚠️ NOTE: Plain urllib without Referer/Origin headers may get 403 — always include them.
⚠️ FALLBACK: If CDN still returns 403, ask user to manually download and send the MP3 file.

### STEP 6: Assemble Final Video

**Critical performance rule:** never render Ken Burns, xfade, zoompan, or Remotion over the full target duration. Render a short visual loop tile only, normally 30-180s and hard max 300s, then extend that tile with FFmpeg stream copy. A 30-60 minute video should spend minutes on visual rendering, not half an hour re-encoding frames.

#### 6a. Send a preview
* Prepare a 30-45s (round off to integer multiple of video length) preview with looping as needed and confirm with user that it looks good and should full video be uploaded. Only then prepare a full length video and upload to youtube. 
* Mix with music before sending the video. 

#### 6b. Render the short loop tile

For static/Ken Burns videos:
- Use Remotion only for `loop_tile.mp4`, not the final duration.
- If there are multiple images, include the image sequence, zoom/pan, and crossfades inside this short tile.
- Keep `loop_tile.mp4` to 30-180s; use 300s only when the user explicitly needs a longer visual cycle.
- Do not use ffmpeg `zoompan`, `xfade`, or PIL frame generation for the full final length.

For animated videos:
- Build `seamless_loop.mp4` from the generated animation and bridge clip, then optionally add a static hold inside the tile.

* If the video is of "animated" style and not built using effects on static images, then between video loops, keep an equal length of static chosen hero image. 
  * So one whole loop would be => (two videos generated through AI joined) + hero image (time length = one part of video generated through fal)

#### 6c. Loop video to target duration

If the source is already a rendered static/seamless H.264 MP4 from Remotion or Kling, do **not** use Remotion to extend its duration and do **not** re-encode the video. Use FFmpeg stream copy.

This is much faster in CPU-only Docker on MacBook Air M processor series because it remuxes/copies encoded packets instead of rendering every frame again.

```bash
DURATION=$((10 * 60))       # target duration in seconds
SOURCE="loop_tile.mp4"      # or static_loop.mp4 / seamless_loop.mp4
OUT="video_looped.mp4"

ffmpeg -y \
  -stream_loop -1 -i "$SOURCE" \
  -t "$DURATION" \
  -map 0:v:0 -map 0:a? \
  -c copy \
  -movflags +faststart \
  "$OUT"
```

This command should finish quickly. If it is still running after a few minutes for a 30-60 minute video, stop and inspect the command; it is probably re-encoding.

#### 6d. Add title card (first 5 seconds)

Use the **remotion-video** skill for title cards. Render `title_card.mp4` as a 5s composition over `hero.jpg`, with title/subtitle opacity fade-in/out. Then prepend it to `video_looped.mp4` using ffmpeg concat demuxer/remotion. Result: `video_titled.mp4`.

#### 6e. Mix with music
Example command

```bash
ffmpeg -i video_titled.mp4 -stream_loop -1 -i music.mp3 \
  -t $DURATION -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k \
  -af "afade=t=out:st=$((DURATION-5)):d=5" \
  -shortest \
  <video_name>_10min.mp4
```

The `-af afade` ensures a gentle audio fade-out in the last 5 seconds.



### STEP 8: Post-Production (AUTOMATIC after video approval)

#### 8a. YouTube Title & Description

Proactively provide SEO-optimized title and description.

**Example Title pattern**: `<Theme Name> | <Duration>-Min Instrumental` 
Example: `Himalayan Serenity | 15-Min Instrumental | Sitar, Bansuri Flute & Tabla`

**Description** should include:
- Evocative 2-sentence opening about the experience
- (If instrumental) "Perfect for:" list (Meditation, Sleep, Yoga, Study, Morning Rituals, Breathwork)
- Instruments list with brief poetic descriptions (e.g. "Bansuri Flute — bamboo voice of the mountains")
- Duration and genre
- Subscribe CTA
- 15-20 relevant hashtags

Save to `youtube_info.txt` in the project folder.

#### 8b. Thumbnail

Use the hero image and do text overlay representing the video in an artistic/good-looking manner. 

Text overlay method:
```bash
ffmpeg -i hero.jpg -vf "scale=1280:720,\
  drawtext=text='Title':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-30:shadowcolor=black:shadowx=3:shadowy=3,\
  drawtext=text='Instrument • Instrument • Instrument':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2+50:shadowcolor=black:shadowx=2:shadowy=2,\
  drawtext=text='10 Min':fontsize=28:fontcolor=white:x=w-text_w-30:y=30:box=1:boxcolor=black@0.5:boxborderw=8" \
  -frames:v 1 thumbnail.jpg
```

Thumbnail must be: JPG/PNG, max 2MB, 1280x720.

### STEP 9: YouTube Upload (optional)

If user wants to upload, use the **youtube-upload** skill:
```bash
cp ~/.claude/skills/youtube-upload/scripts/youtube_upload.py /workspace/
cp ~/.claude/skills/youtube-upload/scripts/set_thumbnail.py /workspace/

python3 /workspace/youtube_upload.py \
  --video "/workspace/agent/<video_name>/<video_name>_10min.mp4" \
  --title "..." --description "..." --privacy private --category 10 --tags "..."

python3 /workspace/set_thumbnail.py \
  --video-id VIDEO_ID --image "/workspace/agent/<video_name>/thumbnail.jpg"
```

## Quality Defaults

| Setting | Value | Notes |
|---------|-------|-------|
| Resolution | 1920x1080 | Standard YouTube HD |
| Video codec | libx264 crf 18 | High quality for final |
| Audio codec | AAC 192kbps | Standard YouTube |
| FPS | 25 | Matches ambient/meditation style |
| Preview | 854x480, crf 28, 128kbps | Quick sharing |
| Image model | fal-ai/flux-2-pro | landscape_16_9 |
| Video model | fal-ai/kling-video/v3/pro/image-to-video | 5s duration, cfg_scale 0.7 |
| Thumbnail | 1280x720 | YouTube spec |
| Loop unit | ~10s | 2x 5s Kling clips |
| Target BPM | 120-130 | Meditative pace |
| Target key | F or C major | Warm, devotional |

## Pipeline Types

| Type | When | Approach |
|------|------|----------|
| Ambient/instrumental | Looping visuals + music (meditation, relaxation) | Hero image → seamless loop → Suno music → loop to duration |
| Static image video | User chooses cheaper option | Hero image(s) → short Ken Burns loop tile → stream-copy to duration → music |
| Multi-scene montage | Multiple distinct scenes with transitions | Generate N images → short montage loop tile with transitions → stream-copy to duration → music |
| YouTube-style recreation | Recreate style of a reference video | youtube-understand skill → analyze → recreate visuals + matching music |

## Image Generation Pitfalls (fal.ai content policy)

- Describing Krishna as "blue-skinned divine form" triggers content_policy_violation (422 error). Use neutral phrasing like "traditional Hindu deity Krishna" or describe the attire/scene without explicit skin color references.
- If content policy triggers, retry with `safety_tolerance: '3'` and rephrase the flagged description.
- Religious deity imagery generally works fine — it's specific body description phrases that get flagged.

## Pitfalls

- **NEVER use boomerang/reverse** — always proper bridge clip via Kling
- **NEVER reuse a fixed list of theme ideas** — always fresh, contextual
- **NEVER proceed without user approval** at image, animation, and music steps
- Kling v3 Pro takes 1-3 min per 5s clip — inform user
- fal.ai balance can run out — check before generating, inform user if empty
- Suno tracks max ~3-8 min; loop with crossfade for longer videos
- For 30min+ videos, ffmpeg `stream_loop -1 -c copy` avoids re-encoding; this is mandatory for final visual extension
- Never run `xfade`, `zoompan`, Remotion, or frame-by-frame Python over the full target duration
- If an MP4 is killed before finalization it may be huge but unusable because the `moov` atom is missing; use short tiles and stream-copy loops to avoid this
- Always `generate_audio: false` in Kling when adding separate music
- Title card: use Remotion opacity animation over the hero image, NOT a separate black frame
- Audio: always add fade-out in last 5 seconds with `-af afade`
- cfg_scale 0.7 in Kling produces more natural, less aggressive motion
- Large videos (500MB+): keep in `/workspace/agent/` or a project subfolder, which persists across sessions
- If uploading to YouTube, use category 10 (Music) for meditation/instrumental videos
- Remotion is slow for looping videos. It is chromium based, slow by nature.
