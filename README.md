# NIGHT — ASCII Winter

A real-time 3D snowy forest at night, rendered entirely in ASCII on an HTML canvas.
Procedural pines, a perspective camera, 3D snowfall and a flickering campfire.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173.

## Controls

| Key       | Action                 |
|-----------|------------------------|
| `space`   | pause / resume         |
| `f`       | fullscreen             |
| `m`       | mouse camera on / off  |
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
