# CLAUDE.md

3D Mission Planner: an ATAK-style mission planning trainer for DisplayXR (glasses-free 3D on Leia
displays). Plain ES modules, no build, no package.json. three 0.161 and `@displayxr/inline3d`
1.45.1 load from jsDelivr through the import map in `index.html`.

Live: https://joehillthunder.github.io/displayxr-mission-planner/ (GitHub Pages, legacy build from
the `main` branch root, `.nojekyll`). Pushing to `main` deploys. There is no Actions workflow: the
`gh` token has no `workflow` scope, so don't add `.github/workflows/`.

## Ground rules

- **Everything is fictional**: AO GRANITE, the village, units, callsigns and the "38S MB" grid. Never
  add real places, real coordinates or real units. It is a training and demonstration tool.
- **Tagging targets structures and vehicles, not people.** Patrolling sentries are not taggable. Keep
  it that way.
- The terrain, village and occupants come from fixed seeds (`rng(...)` in `util.js`), and missions
  grade against that ground truth. Changing a seed, `HILLS`, `FLATS`, `ROADS`, the village layout or
  `occupiedIdx` / `cacheIdx` in `world.js` changes the answers. Run the self-test afterwards.

## Layout

| File | What it owns |
|---|---|
| `js/main.js` | Wiring: terrain material (overlay / grid / contour shader patch), sky, lights, day/night `env`, brightness, picking, input, HUD, mission runner (`run`, `ctx`), AAR |
| `js/terrain.js` | Heightfield (513² grid, `heightAt`, `slopeAt`), named `PLACES`, `ROADS`, `FIELDS`, river, trees, painted imagery and heat map, `los`, `raycast`, viewshed and slope painting |
| `js/world.js` | Buildings with interiors, compounds, people (`makePerson`), vehicles, trees and rocks (instanced), patrols, `walls` (2D boxes for collision and sight-line blocking) |
| `js/sensors.js` | EO / IR / XRAY material swap. Each mesh has `userData.sensor = { heat, xray }`; `SENSOR_UNIFORMS` are shared by all sensor shaders |
| `js/camera.js` | MAP / ISR / GROUND controllers; `go(mode)` flies between poses |
| `js/tools.js` | Markers (2525-style sprites), routes and `analyzeRoute`, range & bearing, viewshed, tags, `threatSees` |
| `js/missions.js` | `MISSIONS` (brief, `setup`, `objectives`, `evaluate`), `intel()` graphics, `THREAT` model, `sentryRate`, `missionPoints` (ORP / LCP / BREACH) |
| `js/clutter.js` | Grass and pebbles near the walker (hashed grid, so placement is stable) |
| `js/stage.js` | DisplayXR camera rig, woven vs mono loop |
| `js/selftest.js` | Scripted planner that plays every mission (`?selftest`) |

To add a mission, add an entry to `MISSIONS`. `objectives[].check(ctx)` runs every 0.25 s.
Objectives are live (they can untick) except in missions `orient` and `rehearsal`, which latch.
`evaluate()` returns `{label, pts, max}` rows that should total 100.

## Running and testing

There is no Node or Python on the demo PC. Serve the folder with a PowerShell `HttpListener` static
server (port 8765 is taken by another app; 8790 works), then use headless Chrome:

```
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --use-angle=d3d11 \
  --enable-logging=stderr --v=0 --user-data-dir=<scratch dir> --window-size=1600,900 \
  --virtual-time-budget=20000 --screenshot=<out.png> "http://localhost:8790/?mono&free"
```

Read console lines from stderr (`[mission]`, `[selftest]`, `Uncaught`).

- **After any change to terrain, world layout, threats or grading, run `?mono&selftest`** (virtual
  time budget about 150000) and read the `[selftest]` lines. Last known good: M1, M2, M3 and M5
  score 100, the Dijkstra route has about 4 % exposure, and the M6 cautious walk reaches leg 3
  undetected.
- Useful URL options: `?mission=<id>`, `?free`, `?mono`, `?view=ISR|GROUND&x=..&z=..`,
  `?sensor=IR|XRAY`, `?night`, `?bright=0.5-3`, `?depth=0-2`. `window.planner` exposes the
  internals.
- **Checking real 3D on the panel:** run
  `C:\Program Files\DisplayXR\Browser\chrome.exe --user-data-dir=<scratch> --enable-logging --v=0 <url>`
  and read `<scratch>/chrome_debug.log`. Expect `firstWoven woven=true confirmed=true` and
  `wovenState=woven`. Screenshots of the woven panel come out blank, so use the log.

## Gotchas

- **Stereo depth:** this is a camera rig. Convergence is set to the focus distance, and `ipdFactorFor`
  = dist / 9, clamped 1–160, so the map reads as a sand table from altitude. `fixDepthRange` swaps
  the app camera's near/far into the runtime's per-eye projection, because the AO spans 0.15 m to
  9 km. Keep `renderer.setPixelRatio(1)`.
- **Fat lines** (`Line2`) need `LineMaterial.resolution` set to the per-eye size every frame; the
  frame loop does this from `LINE_MATS`.
- **Sprites** use `sizeAttenuation: false` and are rescaled by `tan(fov/2) / tan(25°)` in
  `tools.update` so they stay the same size when the ISR lens zooms. They have `fog: false`.
- **Threat model:** EN OP sees bearings 170°–240° out to 1.2 km; the checkpoint sees 400 m. These
  were tuned so M3 and M4 are winnable. The ORP sits east of the village because the old one was
  inside the OP's view. If you change these, re-run the self-test.
- **Sensor materials** are `ShaderMaterial`s. They must apply `instanceMatrix` themselves for
  instanced meshes, and they skip tone mapping and fog. Brightness reaches them through
  `SENSOR_UNIFORMS.uGain`.
- `ctx.complete()` ends only the mission run (epoch) that called it, so a retry isn't ended by a
  stale timer.
- The current frame rate on the 8K panel is about 30 fps at a 2560 px per-eye cap. There is no
  frame cap in the code.

## Conventions

- Match the surrounding style: a short header comment per module, plain ES classes, metres for
  world units, `x` east, `-z` north.
- Commit to `main` (it deploys). End commit messages with the `Co-Authored-By` trailer.
- The homepage room for this demo lives in the `joehillthunder.github.io` repo
  (`home/demos.js` entry `mission-planner`, set piece in `home/office.js` `BUILD`). That clone
  often has other sessions' uncommitted work, so make changes in a worktree off `origin/main`.
