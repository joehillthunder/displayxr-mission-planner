# 3D Mission Planner (DisplayXR)

An ATAK-style mission planning trainer in 3D. Plan from a high-fidelity aerial map, fly an ISR
drone orbit, drop to the ground and walk it, and switch between daylight, thermal and see-through
sensors. Six graded missions turn the planning drills into a game for professionals.

**Live:** https://joehillthunder.github.io/displayxr-mission-planner/

On a Leia / DisplayXR display (open the page in the DisplayXR Browser) the map becomes a glasses-free
3D sand table: the point you are looking at sits on the glass, near terrain comes out of the screen
and the far ridges go back. In any other browser it runs in 2D.

> Everything here is fictional: AO GRANITE, its village, units and coordinates (zone "38S MB") are
> generated from fixed seeds. It is a training and demonstration tool, not a planning system.

## What's in it

| | |
|---|---|
| **Views** | MAP (orbit / pan / tilt), ISR (drone loiter with a zoom lens and telemetry), GROUND (first person, walls collide). Switching flies continuously between them: "go to ground" is a dive from the map to eye level. |
| **Sensors** | EO daylight camera, IR thermal (white-hot, black-hot, ironbow; people, engines and occupied houses glow, the ground cools at night), X-RAY see-through (walls become glass, people and dense metal show through). Day / night lighting. |
| **Map** | 1.6 km terrain from a 513 x 513 height grid, 2048 px painted aerial imagery (fields, roads, river, forest), 6,000 trees, a village with real interiors, grass and pebbles near the walker. MGRS grid and 10 m contour overlays. |
| **Tools** | 2525-style markers (hostile, friendly, unknown, neutral, OP, HLZ), routes draped on the terrain with an elevation profile and exposure to known enemy, range & bearing with a line-of-sight check, viewshed, slope map, spot tags. |

## Missions

| | Mission | What is graded |
|---|---|---|
| M1 | Terrain Walk | Range & bearing, find and mark the checkpoint, ISR over the objective, walk the bridge |
| M2 | Pattern of Life | Tag occupied buildings and hot vehicles at night with IR; locate the weapons cache with X-RAY; false tags cost points |
| M3 | Overwatch | Place an OP that sees 3 of 4 key points, 350–1,000 m stand-off, masked from known enemy |
| M4 | Infiltration Route | Route from the assembly area to the ORP: exposure under 15 %, dry crossings only, walkable legs |
| M5 | Landing Zone | HLZ under 7° across a 30 m circle, no trees or buildings within 35 m, 600–1,500 m out, masked |
| M6 | Ground Rehearsal | Night walk to the last covered position, the breach point and back without the sentries seeing you |

Each mission ends in an after-action review with a score out of 100 and a T / P / U rating
(Trained, Practiced, Untrained). Best scores are kept in the browser.

## Controls

- **Map:** drag to pan, right-drag (or Shift-drag) to rotate and tilt, wheel to zoom; WASD, Q/E, R/F.
- **ISR:** drag to slew the aim point, wheel to zoom the lens.
- **Ground:** WASD to walk, Shift to run, C to crouch, drag to look, M back to the map.
- **Sensors:** 1 EO, 2 IR, 3 X-RAY, P thermal palette, N day/night. H for help.

URL options: `?mission=orient|isr|overwatch|route|hlz|rehearsal`, `?free`, `?mono` (force 2D),
`?depth=0-2`, `?sensor=IR`, `?view=ISR|GROUND&x=..&z=..`, `?night`, `?selftest` (plays every
mission with a scripted planner and logs the grades to the console).

## Code

Plain ES modules, no build. three.js 0.161 and `@displayxr/inline3d` 1.45.1 from jsDelivr.

- `js/terrain.js` heightfield, imagery, heat map, line of sight, viewshed, slope
- `js/world.js` village, buildings with interiors, people, vehicles, trees, collision
- `js/sensors.js` EO / IR / X-RAY material swap and shaders
- `js/camera.js` MAP / ISR / GROUND controllers and flights between them
- `js/tools.js` markers, routes, range & bearing, overlays, tags
- `js/missions.js` mission briefs, objectives, grading
- `js/stage.js` the DisplayXR camera rig (convergence on the focus point, eye separation scaled with distance)
- `js/selftest.js` scripted planner used to check every mission can be won

Serve the folder with any static server and open `index.html`.
