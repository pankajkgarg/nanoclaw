#!/usr/bin/env python3
"""
Set a thumbnail image on a YouTube video.

Usage:
  python3 set_thumbnail.py --video-id VIDEO_ID --image /path/to/thumbnail.jpg

Image requirements (YouTube spec):
  - JPG, GIF, or PNG
  - Max 2MB file size
  - 1280x720 recommended (16:9 aspect ratio)
  - Minimum width: 640px
  - Channel must be VERIFIED: https://www.youtube.com/verify
"""

import os, sys, json, argparse
from datetime import datetime, timezone
from google.auth.exceptions import RefreshError
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

CRED_PATH = "/workspace/secrets/mom_account_google_oauth_creds.json"
SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
]

def save_credentials(raw, creds):
    raw["token"] = creds.token
    raw["expiry"] = format_expiry(creds.expiry)
    with open(CRED_PATH, "w") as f:
        json.dump(raw, f, indent=2)

def parse_expiry(expiry_str):
    if not expiry_str:
        return None
    try:
        expiry = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
    except ValueError:
        return None
    if expiry.tzinfo is not None:
        expiry = expiry.astimezone(timezone.utc).replace(tzinfo=None)
    return expiry

def format_expiry(expiry):
    if not expiry:
        return None
    if expiry.tzinfo is not None:
        expiry = expiry.astimezone(timezone.utc).replace(tzinfo=None)
    return expiry.isoformat()

def get_credentials():
    with open(CRED_PATH) as f:
        raw = json.load(f)

    if "installed" in raw or "web" in raw:
        print("ERROR: Credential file is not yet authorized. Run get_youtube_token.py first.")
        sys.exit(1)

    expiry = parse_expiry(raw.get("expiry"))

    creds = Credentials(
        token=raw.get("token") or raw.get("access_token"),
        refresh_token=raw.get("refresh_token"),
        token_uri=raw.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=raw.get("client_id"),
        client_secret=raw.get("client_secret"),
        scopes=raw.get("scopes", SCOPES),
        expiry=expiry,
    )

    if not creds.valid:
        if not creds.refresh_token:
            print("ERROR: OAuth token is invalid and has no refresh_token.")
            print("Run get_youtube_token.py on your Mac to authorize YouTube upload again.")
            sys.exit(1)
        print("OAuth token invalid or expired, refreshing...")
        try:
            creds.refresh(Request())
        except RefreshError as err:
            print(f"ERROR: OAuth refresh failed: {err}")
            print("The saved Google refresh token is expired or revoked.")
            print("Run get_youtube_token.py on your Mac to authorize YouTube upload again.")
            sys.exit(1)
        save_credentials(raw, creds)
        print("OAuth token refreshed and saved.")

    return creds

def set_thumbnail(video_id, image_path):
    if not os.path.exists(image_path):
        print(f"ERROR: Image file not found: {image_path}")
        sys.exit(1)

    size_bytes = os.path.getsize(image_path)
    if size_bytes > 2 * 1024 * 1024:
        print(f"ERROR: Image is {size_bytes/1024/1024:.1f}MB - YouTube max is 2MB.")
        print("Resize with: ffmpeg -i input.jpg -vf scale=1280:720 thumbnail.jpg")
        sys.exit(1)

    ext = os.path.splitext(image_path)[1].lower()
    mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif"}
    mimetype = mime_map.get(ext, "image/jpeg")

    print("Authenticating...")
    creds = get_credentials()
    youtube = build("youtube", "v3", credentials=creds)

    print(f"Setting thumbnail for video: {video_id}")
    print(f"Image: {os.path.basename(image_path)} ({size_bytes/1024:.0f} KB)")

    media = MediaFileUpload(image_path, mimetype=mimetype)
    response = youtube.thumbnails().set(videoId=video_id, media_body=media).execute()

    print("Thumbnail set successfully!")
    print(f"Video URL: https://www.youtube.com/watch?v={video_id}")
    return response

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Set a custom thumbnail on a YouTube video")
    ap.add_argument("--video-id", required=True, help="YouTube video ID (e.g. NFkDw3SL3tc)")
    ap.add_argument("--image",    required=True, help="Path to thumbnail image (JPG/PNG, max 2MB, 1280x720 recommended)")
    args = ap.parse_args()

    set_thumbnail(args.video_id, args.image)
