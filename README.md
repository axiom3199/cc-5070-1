# Room Camera — volumetric third-person controller

An indoor third-person camera that is treated as a **solid convex volume**, not a
point. Every frame it sweeps that volume (near-clip rectangle + rear shell)
along the stand-off direction against the level's AABBs and only renders a pose
that the sweep proved free.

## Run the demo

```bash
npm install
npm run dev        # → http://localhost:5173
```

Open the printed URL. The scene starts in the start room with the overlay on.

Production build:

```bash
npm run build      # static bundle in dist/
npm run preview    # serve the built bundle
```

## What you see

- **Main view** — the real third-person render driven by the kernel. Movement is
  camera-relative; the over-the-shoulder look-at shift is re-validated against
  the camera volume before it is used, so it cannot push the hull into a wall.
- **Overhead pane (bottom centre)** — a second orthographic camera looking down
  at the actuated pose with ceilings hidden. It draws, from the same collision
  boxes the query uses:
  - the actuated camera hull: green wireframe when free, red when blocked;
  - the blue near-clip rectangle;
  - the desired pose (orange octahedron) and the desired→actual line;
  - full-volume sweep probes along the sweep axis (green free / red blocked);
  - yellow sight lines and sample spheres for camera→character visibility.

  This pane is the direct "query result vs. actual camera volume" comparison.
- **Left HUD** — requested / legal / applied distance with a bar whose fill is
  the applied distance and whose orange mark is the current legal limit; yaw and
  pitch offsets; near-plane intrusions; hull legality; safety-clamp and
  emergency-backoff flags; boxes tested and candidate directions; camera status,
  distance phase, blocking box and cumulative illegal-frame count. The
  **Obstacle jitter diagnostics** card below it shows the active root cause,
  blocking evidence and the bounded trace/event ring depths; the top-centre
  banner mirrors the active cause in the third-person view itself.
- **Right HUD** — scene presets, camera vs. desired vs. pivot positions, controls.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | move, relative to camera yaw |
| `Shift` | sprint |
| `Space` | hop (cosmetic vertical offset on the avatar) |
| drag | orbit yaw / pitch |
| wheel | change requested camera distance |
| `V` | toggle overlay and overhead pane |
| `R` | reset character and stats |
| `H` | toggle help |

## Graphical entry point

The diagnostics are a **graphical** feature, not a CLI report. Run the demo and
open the printed URL — everything below is read directly off the running page:

- **Obstacle jitter diagnostics card** (left panel) — active root cause,
  blocking-box evidence, raw contact distance, distance phase, shortfall,
  candidate-key flips, distance reversals, confirmed events and the bounded
  trace/event ring depths.
- **In-viewport banner** (top centre) — appears only while a jitter event is
  confirmed, colour-coded by root cause, naming the blocker and the live
  shortfall. It disappears when the evidence window goes quiet; it never fires
  on a clear frame.
- **Test-scene buttons** (right panel) — `Jitter corner` and
  `Moving door panel` join the existing scenes and drive the two dynamic
  fixtures interactively.

The command line only runs headless assertions; it cannot surface a root
cause. See [Verification](#verification) for the scripts.

## Obstacle jitter tracking

`src/core/diagnostics.js` is observational only — it never feeds back into a
collision query, a distance or a pose, and collision is never disabled to
smooth the picture. Each fixed step records a compact evidence chain
(requested / legal / raw-contact / applied distance, blocking box, selected
candidate key, distance phase) and classifies a confirmed push/pull episode
into exactly one of four causes, each with explicit evidence:

| Cause | What the evidence shows |
| --- | --- |
| `geometry-infeasible` | Static geometry genuinely cannot host the stand-off; the applied distance follows the legal limit. |
| `moving-blocker` | The blocker itself moves (the sliding door panel) across a stationary pivot's sweep. |
| `query-noise` | The raw contact jumps while the pivot **and** orbit yaw are both stationary — no geometric cause. |
| `state-update` | The kernel's own candidate/smoothing state oscillates (key flips, phase flips, reversals) around real geometry. |

Classification priority is fixed (moving blocker → noise → state → geometry)
and every label is backed by the recorded numbers, so the tracker cannot
false-report a cause it did not observe. A clean central-room run asserts zero
events.

**Logging cost is bounded.** Frame traces and events are ring buffers
(default 900 frames / 24 events); a 2400-frame run is asserted to stay at
capacity. Replays use the same bounded `ReplayTrajectory` (numeric records,
no per-frame objects) and can be re-driven through a fresh kernel to verify
the reproduced pose against the recorded one.

## Moving door panel

`src/core/dynamicDoor.js` is the level's one dynamic collider. Its centre is a
pure deterministic function of time (a triangle wave), so the headless suite
and the browser compute identical poses. The panel is a real AABB in the same
collider list the camera sweeps — never a render-only decoration — and its
mesh moves with the collider.

## Scenes

`Start room`, `Narrow corridor`, `Low ceiling`, `Wall-hug turn`,
`Column occlusion`, `Jitter corner`, `Moving door panel`. Each places the
character so the named constraint is immediate; the requested distance is
seeded before reset so the scene opens already framed. `Jitter corner` runs a
slow automatic orbit against static props (state-update fixture);
`Moving door panel` holds the character still while the panel crosses the
sweep (moving-blocker fixture).

## How the kernel works

`src/core/thirdPersonCamera.js`, renderer-agnostic, driven with a fixed 1/120 s
step.

1. **Exact legal distance.** With a fixed camera orientation the volume's motion
   is a pure translation, so each convex-hull-vs-AABB pair yields an exact
   `[enter, exit]` interval by SAT (3 box axes + 12 hull-face normals + 12 hull
   edges × box axes). The first `enter` over all boxes is the contact distance;
   the applied limit is that minus a small contact epsilon. This cannot tunnel
   through narrow walls, unlike sampling.
2. **Direction search.** If straight-behind loses distance or hides the
   character, a tiered yaw fan (0→±80°, pitch 0/±6°) is scored on kept distance,
   target visibility, a comfort floor and angular deviation. Narrow rings are
   tried first and stop the search when they already restore the request; a
   previously selected direction is kept while it stays competitive
   (hysteresis).
3. **Eased, then re-verified.** The yaw/pitch offset is eased; the *eased*
   direction is swept again and snapped into the safe basin if easing would drag
   the volume through a corner.
4. **Distance smoothing.** Shortening is fast (τ ≈ 0.07 s), recovery slow
   (τ ≈ 0.45 s) after a short dwell, and the smoothed value is hard-clamped to
   the current frame's legal limit — an illegal intermediate is never rendered.
5. **Final verification.** The exact final pose is re-tested; if it is still
   blocked the kernel backs off in epsilon steps and, as a last resort, holds
   the previous verified pose. Near-plane corners, edge midpoints and centre are
   probed for intrusions and reported to the HUD.

The camera is never parented to the avatar, and nothing is made transparent —
occluders stay solid; the camera works around them.

## Verification

```bash
npm test               # headless kernel scenarios + diagnostics suite (no browser)
npm run test:kernel    # kernel legality scenarios only
npm run test:diagnostics
                       # 26 obstacle-jitter / replay / log-cost checks
npm run test:plan      # writes the top-down SVG level plan
npm run test:ui        # Playwright: drives the real page, writes artifacts/
```

`tests/scenarios.js` runs 1470 frames across a narrow corridor, low ceiling,
wall-hug turn, column orbit, a column-between case (ideal stand-off blocked by a
pillar) and a standing spin, asserting every frame: hull
free, distance within the legal limit, zero near-plane intrusions, visibility
floor and finite position. `tests/diagnostics.js` drives all four root-cause
classes through the real kernel with collision enabled — moving door,
stationary-pivot corner orbit, injected query noise inside a solid alcove and a
static dead-end — plus a clean-room no-false-report run, ring-buffer bounds,
replay round-trip and replay re-drive accuracy (distance ≤ 2 cm, pose ≤ 5 cm).
`tests/ui-smoke.mjs` exercises the same paths through the real UI, including
WASD driving, zoom sweeps, the two new fixtures' on-page root-cause banner and
replay depth, and fails on any page error or unmet diagnostic assertion.
`tests/render-plan.mjs` writes a top-down SVG plan of the level, the tested
routes and the sliding door's sweep extremes for geometry sanity checks.

The Playwright script uses `$CHROMIUM_PATH` if set, otherwise a pinned
headless-shell at
`~/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell`,
and expects a dev server on port 5173; both are configurable at the top of the
file.
