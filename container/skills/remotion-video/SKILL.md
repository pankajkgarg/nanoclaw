---
name: remotion-video
description: Render videos using Remotion with React compositions, Ken Burns effects, slideshows, audio, title cards, and HD output.
allowed-tools: Bash(node:*), Bash(pnpm:*), Bash(npx:*), Bash(remotion:*), Bash(ffmpeg:*), Bash(ffprobe:*)
---

# Remotion Video Rendering

Use Remotion for programmatic video composition inside the container:
- Ken Burns effects and image slideshows
- Animated title cards and text overlays
- Scene sequencing, fades, transforms, and audio placement

## Environment

Remotion and Chromium are installed in the container image.

```bash
export CHROME_PATH=/usr/bin/chromium
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

If a project cannot resolve global packages, add local project deps:

```bash
pnpm add remotion @remotion/cli react react-dom typescript @types/react zod
```

## Minimal Project

Create the project under `/workspace/agent/<project>/` so outputs persist.

```bash
mkdir -p /workspace/agent/<project>/src
cd /workspace/agent/<project>
pnpm init
pnpm add remotion @remotion/cli react react-dom typescript @types/react zod
```

`src/index.tsx`:

```tsx
import React from 'react';
import { Composition, Img, staticFile, useCurrentFrame, interpolate, Easing } from 'remotion';

const Video = () => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 750], [1, 1.15], {
    easing: Easing.inOut(Easing.ease),
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'hidden', backgroundColor: 'black' }}>
      <Img
        src={staticFile('hero.jpg')}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${scale})`,
        }}
      />
    </div>
  );
};

export const RemotionRoot = () => (
  <Composition id="Main" component={Video} durationInFrames={750} fps={25} width={1920} height={1080} />
);
```

Render:

```bash
pnpm exec remotion render src/index.tsx Main static_loop.mp4 \
  --browser-executable=/usr/bin/chromium \
  --codec=h264
```

## Patterns

- Use absolute paths or `public/` plus `staticFile()` for images/audio.
- For a 5s title card, animate opacity with `interpolate(frame, [0, 12, 113, 125], [0, 1, 1, 0])`.
- For multi-image slideshows, segment by frame ranges, overlap 30-40 frames, and crossfade opacity.
- For long ambient videos, render only a short loop tile: normally 30-180s, hard max 300s. Use ffmpeg after render to stream-copy that tile to the target duration.
- Use ffmpeg after render for long loops, compression, and final audio muxing.

## Pitfalls

- Render into `/workspace/agent/<project>/`, not `/tmp`.
- Use `--browser-executable=/usr/bin/chromium` if Chromium is not auto-detected.
- Never render the full 30-60 minute ambient video in Remotion. Render a short clean loop in Remotion, then loop with `ffmpeg -stream_loop -1 -c copy`.
- Check file size before sending over messaging channels.
