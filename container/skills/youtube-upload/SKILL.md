---
name: youtube-upload
description: Upload any local video file to YouTube using Google OAuth2 credentials, with optional custom thumbnail. Use this skill whenever the user asks to upload a video to YouTube, regardless of where the video is stored.
required_credential_files:
  - path: mom_account_google_oauth_creds.json
    description: Google OAuth2 token for YouTube upload (stored in /workspace/secrets/)
tags:
  - youtube
  - video
  - google
  - upload
  - thumbnail
---

# YouTube Video Upload

## Upload Gate (BLOCKING — check before anything else)

1. Confirm the user explicitly asked to upload **this** video in their recent messages ("upload karo", "upload kar do"). These are NOT upload approval:
   - a publish date by itself ("3 May", "29 ka") — that only sets the schedule; ask "Upload kar doon? <date> ko publish schedule karunga"
   - "Ok" / "theek hai" / 👍 on a preview — that only approves the preview; ask "YouTube pe upload kar doon?"
2. Privacy defaults to `private`. NEVER use `--privacy public`, and never flip an already-uploaded video to public, unless the user explicitly says to make it public. When the user gives a date, prefer private + scheduled publish.
3. One approval covers one upload. Re-uploads, replacements, and new versions each need fresh approval.

## Bundled Scripts

Two scripts live inside this skill under scripts/:

  scripts/youtube_upload.py  - Upload a video file to YouTube
  scripts/set_thumbnail.py   - Set a custom thumbnail on an uploaded video

Do not assume the skill is under `~/.claude/skills`; NanoClaw mounts shared container skills at `/app/skills`, with Claude-visible symlinks under `/home/node/.claude/skills`.

The bundled scripts are available at:
```bash
/app/skills/youtube-upload/scripts/youtube_upload.py
/app/skills/youtube-upload/scripts/set_thumbnail.py
```

If you want local working copies in /workspace:
```bash
cp /app/skills/youtube-upload/scripts/youtube_upload.py /workspace/
cp /app/skills/youtube-upload/scripts/set_thumbnail.py /workspace/
```

If those paths ever fail, locate them first instead of guessing:
```bash
find / -name youtube_upload.py 2>/dev/null
find / -name set_thumbnail.py 2>/dev/null
```

## Dependencies (install once)

The NanoClaw container image installs the required Google API packages. If running in an older container image, rebuild it or install them once:

```bash
pip3 install --break-system-packages google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client
```

Then run the uploader with Python:
```bash
python3 /workspace/youtube_upload.py ...
```

## Full Workflow

### STEP 1: Check token

```bash
python3 -c "import json; d=json.load(open('/workspace/secrets/mom_account_google_oauth_creds.json')); print('READY' if 'refresh_token' in d else 'NEEDS OAUTH')"
```

If NEEDS OAUTH -> see OAuth Setup section below.

### STEP 2: Find video (if user hasn't specified a path)

```bash
find /workspace -maxdepth 3 -type f \( -name '*.mp4' -o -name '*.mov' -o -name '*.mkv' \) \
  -printf "%T@ %s %p\n" | sort -rn | head -20 | awk '{printf "%.1f MB  %s\n", $2/1048576, $3}'
```

### STEP 3: Collect metadata from user (if not already provided)

- Title
- Description
- Privacy: private / unlisted / public (default: private)
- Category (default: 22; use 10 for music/meditation)
- Tags (optional, comma-separated)
- Thumbnail image path (optional)

### STEP 4: Upload the video

```bash
python3 /workspace/youtube_upload.py \
  --video "/path/to/video.mp4" \
  --title "My Title" \
  --description "My description" \
  --privacy private \
  --category 22 \
  --tags "tag1,tag2"
```

Note the returned Video ID. Use timeout=600 for large files (>500MB).

### STEP 5: Set thumbnail (optional)

```bash
python3 /workspace/set_thumbnail.py \
  --video-id VIDEO_ID \
  --image /path/to/thumbnail.jpg
```

Image requirements: JPG/PNG, max 2MB, 1280x720 recommended.
Resize if needed: `ffmpeg -i input.jpg -vf scale=1280:720 thumbnail.jpg`
Custom thumbnails require a VERIFIED YouTube channel: https://www.youtube.com/verify

### STEP 6: Confirm result

Report: title, YouTube URL, thumbnail status, privacy, file size.

## Category IDs

10=Music, 22=People&Blogs, 1=Film&Animation, 17=Sports, 24=Entertainment, 28=Science

## OAuth Setup (one-time only)

Only needed if token check says NEEDS OAUTH, or if refresh fails with `invalid_grant`.

Important: the OAuth setup script needs a Google OAuth CLIENT SECRET JSON (Desktop app), not an already-authorized token file.

On the user's Mac:
1. In Google Cloud Console, create/download an OAuth client ID of type **Desktop app**.
2. Save that JSON somewhere local and private, for example:
   `data/secrets/mom_account_google_client_secret.json`
3. Then run:
```
cd data/secrets
pip3 install google-auth-oauthlib google-api-python-client
python3 get_youtube_token.py
```

The script at `/workspace/secrets/get_youtube_token.py` opens the browser, completes OAuth, and writes the authorized token to:
`data/secrets/mom_account_google_oauth_creds.json`

Set `NANOCLAW_GOOGLE_OAUTH_CREDS_PATH` to that token file on the host so NanoClaw mounts it at `/workspace/secrets/mom_account_google_oauth_creds.json` inside the agent container.

If the existing `mom_account_google_oauth_creds.json` already contains keys like `token` / `refresh_token`, that file is a token file and cannot be used as the `from_client_secrets_file(...)` input.

"This app isn't verified" -> click Advanced -> Go to app (unsafe). Normal for self-created projects.
Token should auto-refresh afterward as long as the refresh token remains valid.

## Pitfalls

- Token expired -> scripts may auto-refresh and save back to file if the refresh token is still valid
- `invalid_grant: Token has been expired or revoked` -> the saved OAuth token is no longer usable; user must re-run OAuth locally:
  ```bash
  cd data/secrets
  python3 get_youtube_token.py
  ```
  Then retry the upload.
- Large files (700MB+) -> use timeout=600
- Thumbnail 403 forbidden -> channel not verified (https://www.youtube.com/verify)
- Thumbnail > 2MB -> resize with ffmpeg
- Quota: 10,000 units/day, 1,600 per upload (~6/day), resets midnight Pacific
