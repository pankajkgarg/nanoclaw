---
name: fal-video
description: Generate videos from images using fal.ai Kling v3 Pro (image-to-video). Use when the user asks to create a video from an image or animate an image.
allowed-tools: Bash(python3:*)
source: https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/llms.txt
---

# Video Generation with fal.ai Kling v3 Pro

## Quick start

```bash
python3 -c "
import fal_client
result = fal_client.subscribe('fal-ai/kling-video/v3/pro/image-to-video', arguments={
    'start_image_url': 'https://example.com/photo.jpg',
    'prompt': 'gentle wind blowing through the scene'
})
print(result['video']['url'])
"
```

The `FAL_KEY` environment variable is automatically available as a placeholder. Real authentication is injected by OneCLI on outbound fal.ai requests. Video generation typically takes 1-3 minutes.

## Parameters

**Required:**
- `start_image_url` (string): URL of the starting image. Must be publicly accessible (e.g. a fal.ai CDN URL from image generation, or any public image URL).

**Optional:**
- `prompt` (string): Text description guiding the video motion and style
- `duration` (integer): Video length in seconds, 3-15. Default `5`
- `generate_audio` (boolean): Generate audio track. Default `true`. Supports Chinese and English voice output
- `end_image_url` (string): URL for the ending frame (creates a transition video)
- `negative_prompt` (string): What to avoid. Default `"blur, distort, and low quality"`
- `cfg_scale` (float): Guidance scale, 0-1. Default `0.5`

## Response

```json
{
  "video": {
    "url": "https://fal.media/files/...",
    "content_type": "video/mp4",
    "file_name": "output.mp4",
    "file_size": 1234567
  }
}
```

## Full example

```bash
python3 -c "
import fal_client, json

result = fal_client.subscribe('fal-ai/kling-video/v3/pro/image-to-video', arguments={
    'start_image_url': 'https://fal.media/files/example/image.jpg',
    'prompt': 'camera slowly zooms in, cinematic lighting',
    'duration': 10,
    'generate_audio': True,
    'cfg_scale': 0.7
})

url = result['video']['url']
print(url)
"
```

## Image-to-video workflow

To generate a video from a text description (no existing image):

1. First generate an image using the **fal-image** skill
2. Use the resulting image URL as `start_image_url` for video generation

```bash
python3 -c "
import fal_client

# Step 1: Generate image
img = fal_client.subscribe('fal-ai/flux-2-pro', arguments={
    'prompt': 'a lighthouse on a cliff at sunset, dramatic clouds'
})
image_url = img['images'][0]['url']
print(f'Image: {image_url}')

# Step 2: Generate video from image
vid = fal_client.subscribe('fal-ai/kling-video/v3/pro/image-to-video', arguments={
    'start_image_url': image_url,
    'prompt': 'waves crashing against the cliff, clouds moving slowly',
    'duration': 5
})
print(f'Video: {vid[\"video\"][\"url\"]}')
"
```

## Saving the video

After generating, download the video to the agent workspace if the user needs a local copy:

```bash
python3 -c "
import fal_client, urllib.request

result = fal_client.subscribe('fal-ai/kling-video/v3/pro/image-to-video', arguments={
    'start_image_url': 'IMAGE_URL_HERE',
    'prompt': 'YOUR PROMPT HERE'
})
url = result['video']['url']
path = '/workspace/agent/generated.mp4'
urllib.request.urlretrieve(url, path)
print(path)
"
```

In NanoClaw v2 the persistent working directory is `/workspace/agent`; prefer saving generated files there, or in a project subfolder under it.

## Notes

- `fal_client.subscribe()` handles queue submission and polling automatically
- `start_image_url` must be publicly accessible — local files won't work
- Generated video URLs are temporary CDN links — download immediately
