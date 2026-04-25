---
name: youtube-understand
description: Download and analyze YouTube videos for structure, content, and style. Use when asked to understand, analyze, or recreate a YouTube video.
allowed-tools: Bash(youtube-analyze:*), Bash(yt-dlp:*), Bash(python3:*), Bash(ffmpeg:*), Bash(ffprobe:*)
---

# YouTube Video Analysis

Use `youtube-analyze` to download and deeply analyze a YouTube video. It produces a structured JSON report with transcript, scene boundaries, keyframes, OCR text, and audio analysis.

## Quick start

```bash
youtube-analyze "https://www.youtube.com/watch?v=VIDEO_ID"
# Output: temp/youtube/<video-id>/analysis.json
```

The tool prints the path to `analysis.json` on stdout. Read that file for the full report.

## What it produces

All output lands in `temp/youtube/<video-id>/`:

| File | Content |
|------|---------|
| `analysis.json` | Structured report (see format below) |
| `video.mp4` | Downloaded video (max 1080p) |
| `audio.wav` | Full-quality audio |
| `audio_16k.wav` | 16kHz mono audio (used by whisper) |
| `metadata.json` | Raw yt-dlp metadata |
| `keyframes/` | JPEG at each scene boundary |

### analysis.json structure

```json
{
  "video_id": "abc123",
  "title": "Video Title",
  "duration_seconds": 120.5,
  "resolution": "1920x1080",
  "fps": 30.0,
  "metadata": {
    "uploader": "Channel Name",
    "upload_date": "20230415",
    "description": "...",
    "tags": ["tag1", "tag2"]
  },
  "transcript": [
    {"start": 0.0, "end": 2.5, "text": "Hello and welcome"}
  ],
  "scenes": [
    {
      "index": 0,
      "start_time": 0.0,
      "end_time": 8.3,
      "duration": 8.3,
      "keyframe": "keyframes/scene_000.jpg",
      "ocr_text": "Text visible on screen"
    }
  ],
  "audio_analysis": {
    "bpm": 120.0,
    "key_estimate": "C major",
    "has_speech": true,
    "has_music": true,
    "loudness_profile": [{"time": 0.0, "db": -12.5}]
  }
}
```

## Options

```
youtube-analyze <url> [options]

--output-dir DIR        Custom output directory
--max-duration SECS     Skip videos longer than this (default: 600)
--no-transcribe         Skip speech transcription (saves time)
--no-ocr                Skip OCR on keyframes
--no-audio-analysis     Skip librosa audio analysis
```

## Individual commands

When you need finer control, run each step manually:

### Download only

```bash
yt-dlp -f "bestvideo[height<=1080]+bestaudio/best" --merge-output-format mp4 \
  -o "temp/youtube/%(id)s/video.%(ext)s" "URL"
```

### Download specific segments only (great for long videos — analyze just beginning/middle/end)

```bash
# Download first 2 min, 1 min at midpoint, last 2 min of a 47-min video
yt-dlp --download-sections "*0:00-2:00" -f "bestvideo[height<=720]+bestaudio/best" \
  --merge-output-format mp4 -o "segment_start.%(ext)s" "URL"

yt-dlp --download-sections "*23:00-24:00" -f "bestvideo[height<=720]+bestaudio/best" \
  --merge-output-format mp4 -o "segment_middle.%(ext)s" "URL"

yt-dlp --download-sections "*44:00-46:00" -f "bestvideo[height<=720]+bestaudio/best" \
  --merge-output-format mp4 -o "segment_end.%(ext)s" "URL"
```

This is far faster than downloading the full video when you only need a style/structure analysis.

### Extract audio

```bash
ffmpeg -y -i video.mp4 -ar 16000 -ac 1 -vn audio_16k.wav   # for whisper
ffmpeg -y -i video.mp4 -vn audio.wav                         # for librosa
```

### Transcribe

```bash
python3 -c "
from faster_whisper import WhisperModel
model = WhisperModel('small', device='cpu', compute_type='int8')
segments, info = model.transcribe('audio_16k.wav', beam_size=5)
for seg in segments:
    print(f'[{seg.start:.1f}-{seg.end:.1f}] {seg.text.strip()}')
"
```

### Scene detection

Note: if yt-dlp downloaded in AV1 codec, transcode first:
```bash
ffmpeg -i video.mp4 -c:v libx264 -preset ultrafast -crf 28 -an video_h264.mp4
```

```bash
python3 -c "
from scenedetect import open_video, SceneManager
from scenedetect.detectors import ContentDetector
video = open_video('video_h264.mp4')  # must be h264, not AV1
sm = SceneManager()
sm.add_detector(ContentDetector(threshold=27.0))
sm.detect_scenes(video)
for i, (s, e) in enumerate(sm.get_scene_list()):
    print(f'Scene {i}: {s.get_seconds():.1f}s - {e.get_seconds():.1f}s')
"
```

### Extract keyframe at timestamp

```bash
ffmpeg -y -ss 5.0 -i video.mp4 -frames:v 1 -q:v 2 keyframe.jpg
```

### OCR a frame

```bash
python3 -c "
import pytesseract
from PIL import Image
print(pytesseract.image_to_string(Image.open('keyframe.jpg')))
"
```

### Audio analysis

```bash
python3 -c "
import librosa, numpy as np
y, sr = librosa.load('audio.wav', sr=None)
tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
print(f'BPM: {np.atleast_1d(tempo)[0]:.0f}')

chroma = librosa.feature.chroma_stft(y=y, sr=sr)
keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
print(f'Key: {keys[np.argmax(chroma.mean(axis=1))]}')
"
```

## Recreation workflow

After analyzing a video, use the results to recreate it:

1. **Read `analysis.json`** — understand structure, pacing, visual content
2. **Generate visuals** — for each scene, use the keyframe as reference to describe what fal-image should generate (or use the original keyframe directly)
3. **Create voiceover/subtitles** — use the transcript segments
4. **Match audio style** — use BPM and key from audio_analysis to select or generate music
5. **Assemble with Remotion/ffmpeg** — map scenes to Remotion sequences or ffmpeg concat/xfade timing from the analysis

### Example: Inspect scene timing for recreation

```bash
python3 -c "
import json
with open('temp/youtube/<id>/analysis.json') as f:
    a = json.load(f)
for s in a['scenes']:
    print(f'Scene {s[\"index\"]}: {s[\"duration\"]:.1f}s — keyframe: {s.get(\"keyframe\", \"none\")}')
    if s.get('ocr_text'):
        print(f'  Text on screen: {s[\"ocr_text\"][:100]}')
# Use scene durations and keyframes to build Remotion sequences or ffmpeg xfade timings
"
```

## Troubleshooting

- **Age-restricted videos**: yt-dlp may fail. Try passing cookies: `yt-dlp --cookies-from-browser chromium "URL"`
- **Long videos**: Default limit is 600s (10 min). Override with `--max-duration 3600`
- **First transcription is slow**: faster-whisper downloads the `small` model (~500MB) on first use. Subsequent runs use the cached model.
- **No scenes detected**: Some videos (single continuous shot) have no scene cuts. The tool falls back to extracting keyframes at 10-second intervals.
- **OCR returns garbage**: Tesseract works best on clear, high-contrast text. Low-res or stylized text may produce poor results.
- **AV1 codec breaks scenedetect/opencv**: yt-dlp often downloads in AV1 (av1 codec). scenedetect and opencv-python cannot decode it without hardware support and will silently detect 0 scenes or crash with "Missing Sequence Header". Fix: transcode to h264 first with `ffmpeg -i video.mp4 -c:v libx264 -preset ultrafast -crf 28 -an segment_h264.mp4` before running scene detection.
- **scenedetect backend still fails after transcode**: Fall back to direct opencv histogram comparison, which is more robust:
  ```python
  import cv2
  cap = cv2.VideoCapture('segment_h264.mp4')
  prev_hist, changes = None, []
  frame_num = 0
  while True:
      ret, frame = cap.read()
      if not ret: break
      if frame_num % int(cap.get(cv2.CAP_PROP_FPS)) == 0:  # once per second
          gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
          hist = cv2.normalize(cv2.calcHist([gray],[0],None,[256],[0,256]), None).flatten()
          if prev_hist is not None:
              diff = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_BHATTACHARYYA)
              if diff > 0.3: changes.append((frame_num / cap.get(cv2.CAP_PROP_FPS), diff))
          prev_hist = hist
      frame_num += 1
  cap.release()
  print(f'Scene changes: {len(changes)}')  # 0 = static single-shot video
  ```
- **vision_analyze rejects local file paths**: The tool only accepts HTTP/HTTPS URLs. To analyze local keyframe images, upload them to catbox.moe first: `curl -s -F "reqtype=fileupload" -F "fileToUpload=@frame.jpg" https://catbox.moe/user/api.php` — returns a public URL immediately. No account needed.
