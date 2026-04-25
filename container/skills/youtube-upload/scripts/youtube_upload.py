#!/usr/bin/env python3
"""
Upload a video to YouTube using saved Google OAuth2 credentials.

Usage:
  python3 youtube_upload.py \
    --video /path/to/video.mp4 \
    --title "My Video Title" \
    --description "My description" \
    --privacy private \
    --category 22 \
    --tags "tag1,tag2,tag3"

Privacy options: private (default), unlisted, public
Category IDs: 1=Film, 10=Music, 17=Sports, 22=People&Blogs, 24=Entertainment, 28=Science
"""

import os, sys, json, argparse
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
    raw["expiry"] = creds.expiry.isoformat() if creds.expiry else None
    with open(CRED_PATH, "w") as f:
        json.dump(raw, f, indent=2)

def get_credentials():
    with open(CRED_PATH) as f:
        raw = json.load(f)

    if "installed" in raw or "web" in raw:
        print("ERROR: Credential file contains client secrets, not an authorized token.")
        print("Run get_youtube_token.py on your Mac first to complete OAuth setup.")
        sys.exit(1)

    creds = Credentials(
        token=raw.get("token") or raw.get("access_token"),
        refresh_token=raw.get("refresh_token"),
        token_uri=raw.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=raw.get("client_id"),
        client_secret=raw.get("client_secret"),
        scopes=raw.get("scopes", SCOPES),
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

def upload(video_path, title, description, privacy="private", category="22", tags=None):
    if not os.path.exists(video_path):
        print(f"ERROR: Video file not found: {video_path}")
        sys.exit(1)

    print("Authenticating...")
    creds = get_credentials()
    youtube = build("youtube", "v3", credentials=creds)

    size_mb = os.path.getsize(video_path) / (1024 * 1024)
    print(f"Video:   {os.path.basename(video_path)} ({size_mb:.1f} MB)")
    print(f"Title:   {title}")
    print(f"Privacy: {privacy}")
    print(f"Category ID: {category}")
    print()

    body = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags or [],
            "categoryId": category,
        },
        "status": {
            "privacyStatus": privacy,
        },
    }

    media = MediaFileUpload(
        video_path,
        chunksize=4 * 1024 * 1024,
        resumable=True,
        mimetype="video/mp4",
    )

    req = youtube.videos().insert(
        part=",".join(body.keys()),
        body=body,
        media_body=media,
    )

    print("Uploading...")
    response = None
    last_pct = -1
    while response is None:
        status, response = req.next_chunk()
        if status:
            pct = int(status.progress() * 100)
            if pct != last_pct:
                print(f"  Progress: {pct}%", end="\r", flush=True)
                last_pct = pct

    video_id = response["id"]
    print(f"\nUpload complete!")
    print(f"Video ID: {video_id}")
    print(f"URL:      https://www.youtube.com/watch?v={video_id}")
    print(f"Privacy:  {privacy}")
    return video_id

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Upload a video to YouTube")
    ap.add_argument("--video",       required=True,  help="Path to the video file")
    ap.add_argument("--title",       required=True,  help="YouTube video title")
    ap.add_argument("--description", default="",     help="Video description")
    ap.add_argument("--privacy",     default="private", choices=["private", "unlisted", "public"])
    ap.add_argument("--category",    default="22",   help="YouTube category ID (default: 22 People&Blogs)")
    ap.add_argument("--tags",        default="",     help="Comma-separated tags")
    args = ap.parse_args()

    tags = [t.strip() for t in args.tags.split(",") if t.strip()]
    upload(args.video, args.title, args.description, args.privacy, args.category, tags)
