---
name: fal-image
description: Generate images from text prompts using fal.ai Flux 2 Pro. Use when the user asks to create, generate, or draw an image.
allowed-tools: Bash(python3:*)
source: https://fal.ai/models/fal-ai/flux-2-pro/llms.txt
---

# Image Generation with fal.ai Flux 2 Pro

## Quick start

```bash
python3 -c "
import fal_client, os
result = fal_client.subscribe('fal-ai/flux-2-pro', arguments={'prompt': 'YOUR PROMPT HERE'})
print(result['images'][0]['url'])
"
```

The `FAL_KEY` environment variable is automatically available as a placeholder. Real authentication is injected by OneCLI on outbound fal.ai requests.

## Parameters

**Required:**
- `prompt` (string): Text description of the image to generate

**Optional:**
- `image_size` (string): Default `"landscape_4_3"`. Options: `landscape_4_3`, `portrait_4_3`, `square`, `square_hd`, `landscape_16_9`, `portrait_16_9`
- `seed` (integer): Seed for reproducible generation
- `output_format` (string): `"jpeg"` (default) or `"png"`
- `safety_tolerance` (string): `"1"` to `"5"`, default `"2"`

## Response

```json
{
  "images": [{"url": "https://fal.media/files/...", "content_type": "image/jpeg"}],
  "seed": 12345
}
```

## Full example

```bash
python3 -c "
import fal_client, json

result = fal_client.subscribe('fal-ai/flux-2-pro', arguments={
    'prompt': 'a serene mountain landscape at golden hour, photorealistic',
    'image_size': 'landscape_16_9',
    'output_format': 'png'
})

url = result['images'][0]['url']
print(url)
"
```

## Saving the image

After generating, download the image to the agent workspace if the user needs a local copy:

```bash
python3 -c "
import fal_client, urllib.request

result = fal_client.subscribe('fal-ai/flux-2-pro', arguments={'prompt': 'YOUR PROMPT HERE'})
url = result['images'][0]['url']
ext = 'png' if 'png' in url else 'jpg'
path = f'/workspace/agent/generated.{ext}'
urllib.request.urlretrieve(url, path)
print(path)
"
```

In NanoClaw v2 the persistent working directory is `/workspace/agent`; prefer saving generated files there, or in a project subfolder under it.

## Notes

- `fal_client.subscribe()` handles queue submission and polling automatically
- Generated image URLs are temporary CDN links — download immediately
