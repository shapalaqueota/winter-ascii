# NIGHT — ASCII Winter

A real-time 3D snowy forest at night, rendered entirely in ASCII on an HTML canvas.
Walk around in first person: an endless procedural pine forest, 3D snowfall and a
flickering campfire.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173.

## The game

Keep the campfire alive. It burns down over time, and as it does the flames
shrink and the dark closes in. Go out into the forest, walk over sticks to pick
them up (you can carry 5), bring them back and press `e` at the fire to feed it.
If it goes out, the night wins: press `r` to relight it and try to last longer.

The dead come out of the forest, more of them the longer you last. They will not
step into the firelight, so a strong fire keeps a wide safe circle around you,
but the sticks are out in the dark. Shoot them: three body shots or one to the head.

## Controls

Click the scene to capture the mouse and look around; `esc` releases it.

| Key       | Action                 |
|-----------|------------------------|
| `w a s d` | walk                   |
| `shift`   | run                    |
| `space`   | jump                   |
| click     | shoot                  |
| `r`       | reload / relight       |
| `e`       | feed the fire          |
| arrows    | walk / turn            |
| `p`       | pause / resume         |
| `f`       | fullscreen             |
| `1` / `2` | snow less / more       |
| `3` / `4` | wind left / right      |
| `5` / `6` | speed slower / faster  |
| `7` / `8` | glow dimmer / brighter |
| `h`       | help                   |

## How it works

`src/engine/WinterEngine.ts` is a standalone renderer, independent of React:

1. update the simulation (camera drift, wind, flicker, particles)
2. raycast each character cell against the ground plane or sky
3. project and rasterise procedural pines with a per-cell depth buffer
4. draw the campfire (flame tongues, logs, stones, embers)
5. project 3D snow particles, depth-tested against the scene
6. quantise brightness and warmth to a palette and blit glyphs from a pre-rendered atlas

React (`src/App.tsx`, `src/components/`) only hosts the canvas and the control panel.

Built with React, TypeScript, Vite and Canvas 2D.
