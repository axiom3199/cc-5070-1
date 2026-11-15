/**
 * Headless diagnostics suite for obstacle jitter tracking.
 *
 * The four root-cause classes are each driven through the real kernel with
 * collision fully enabled:
 *
 *   moving-blocker      the sliding door panel crosses the camera sweep while
 *                       the character stands still;
 *   state-update        a stationary character slowly orbits inside the narrow
 *                       corner props so the candidate fan alternates;
 *   query-noise         a stationary input inside a solid alcove whose back
 *                       wall surface jitters (the jitter is injected into the
 *                       collider, never into the query result);
 *   geometry-infeasible a character walks into a static dead-end, where the
 *                       push is a real geometric limit with a stable query.
 *
 * A clean-room run asserts the tracker never false-reports, and a ring-buffer
 * run asserts the logging cost stays bounded on long sessions.
 */
import { ThirdPersonCamera } from '../src/core/thirdPersonCamera.js';
import { buildColliders, levelSpec } from '../src/core/levelSpec.js';
import { AABB, vec } from '../src/core/collision.js';
import {
  ObstacleJitterTracker,
  ReplayTrajectory,
  JITTER_REASONS,
  verifyReplay,
} from '../src/core/diagnostics.js';
import {
  DOOR_SPEC,
  buildDoorCollider,
  updateDoorCollider,
  doorStateMap,
  setDoorCenter,
} from '../src/core/dynamicDoor.js';

const DEG = Math.PI / 180;
const DT = 1 / 60;
const samples = (p) => [
  vec(p.x, p.y + 1.58, p.z),
  vec(p.x, p.y + 1.25, p.z),
  vec(p.x, p.y + 0.9, p.z),
];

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail: condition ? '' : detail });
  if (!condition) console.log(`  FAIL ${name} ${detail}`);
}

// ---------------------------------------------------------------------------
// 1. Moving door panel: stationary pivot, the panel opens and closes across
//    the camera stand-off. Must classify as moving-blocker with the door id
//    captured as blocking evidence.
// ---------------------------------------------------------------------------
{
  const colliders = buildColliders();
  const door = buildDoorCollider();
  colliders.push(door);
  const kernel = new ThirdPersonCamera({ requestedDistance: 4.2, pitch: 14 * DEG });
  const tracker = new ObstacleJitterTracker();
  const trajectory = new ReplayTrajectory({ capacity: 600, dynamicBoxes: [{ id: DOOR_SPEC.id }] });
  const pos = vec(5.3, 0, -0.8);
  const pivot = vec(5.3, 1.45, -0.8);
  let t = 0;
  for (let i = 0; i < 360; i++) {
    const movedId = updateDoorCollider(door, t);
    const dynamicIds = new Set(movedId ? [movedId] : []);
    const r = kernel.update({ pivot, yaw: 0, pitch: 14 * DEG, dt: DT, colliders, targetSamples: samples(pos) });
    tracker.record(r, { pivot, yaw: 0, dt: DT, dynamicIds });
    trajectory.recordFrame(r, { pivot, yaw: 0, pitch: 14 * DEG, dt: DT, doorStates: doorStateMap(t) });
    t += DT;
  }
  const summary = tracker.summary();
  check('door: at least one jitter event', summary.events >= 1, JSON.stringify(summary.reasonCounts));
  check(
    'door: classified moving-blocker',
    tracker.events.some((e) => e.reason === JITTER_REASONS.MOVING),
    JSON.stringify(tracker.events.map((e) => e.reason)),
  );
  const doorEvent = tracker.events.find((e) => e.reason === JITTER_REASONS.MOVING);
  check(
    'door: evidence names the sliding panel',
    !!doorEvent && doorEvent.evidence.blockingBoxes.includes(DOOR_SPEC.id)
      && doorEvent.evidence.movingHitFrames >= 6,
    JSON.stringify(doorEvent?.evidence),
  );
  check('door: every recorded frame stayed hull-legal', tracker.frames.every((f) => f.backoff === 0));

  // Replay the recorded trajectory through a fresh kernel.
  const replayKernel = new ThirdPersonCamera({ requestedDistance: 4.2, pitch: 14 * DEG });
  const replayDoor = buildDoorCollider();
  const replayColliders = buildColliders();
  replayColliders.push(replayDoor);
  const report = verifyReplay(
    replayKernel,
    ReplayTrajectory.fromJSON(JSON.parse(JSON.stringify(trajectory.toJSON()))),
    replayColliders,
    (frame) => samples(vec(frame.pivot.x, 0, frame.pivot.z)),
    (state) => {
      const c = state.get(DOOR_SPEC.id);
      if (c) setDoorCenter(replayDoor, c);
    },
  );
  check('door: replay reproduces all 360 frames', report.frames === 360, String(report.frames));
  check('door: replay distance error <= 2 cm', report.maxDistanceError <= 0.02, String(report.maxDistanceError));
  check('door: replay position error <= 5 cm', report.maxPositionError <= 0.05, String(report.maxPositionError));
  check('door: replay has no frame mismatches', report.mismatches.length === 0, JSON.stringify(report.mismatches));
}

// ---------------------------------------------------------------------------
// 2. Narrow corner: stationary pivot, slow orbit. The fan alternates candidate
//    keys against static props; must classify state-update, never query-noise
//    (the input yaw is moving, so the query has a geometric cause).
// ---------------------------------------------------------------------------
{
  const colliders = buildColliders();
  const kernel = new ThirdPersonCamera({ requestedDistance: 4.2, pitch: 16 * DEG });
  const tracker = new ObstacleJitterTracker();
  const pos = vec(4.5, 0, -5.6);
  const pivot = vec(4.5, 1.45, -5.6);
  for (let i = 0; i < 240; i++) {
    const yaw = Math.PI + Math.sin((i / 240) * Math.PI * 2) * 0.9;
    const r = kernel.update({ pivot, yaw, pitch: 16 * DEG, dt: DT, colliders, targetSamples: samples(pos) });
    tracker.record(r, { pivot, yaw, dt: DT, dynamicIds: new Set() });
  }
  const summary = tracker.summary();
  check('corner: candidate key flips observed', summary.keyFlips >= 4, String(summary.keyFlips));
  check(
    'corner: classified state-update',
    tracker.events.some((e) => e.reason === JITTER_REASONS.STATE),
    JSON.stringify(tracker.events.map((e) => e.reason)),
  );
  check(
    'corner: never labelled query-noise',
    !tracker.events.some((e) => e.reason === JITTER_REASONS.NOISE),
    JSON.stringify(tracker.events.map((e) => e.reason)),
  );
  const ev = tracker.events.find((e) => e.reason === JITTER_REASONS.STATE);
  check(
    'corner: evidence records a sub-metre push/pull amplitude',
    !!ev && ev.evidence.amplitude >= 0.08 && ev.evidence.pivotTravel === 0,
    JSON.stringify(ev?.evidence),
  );
}

// ---------------------------------------------------------------------------
// 3. Query noise: fully stationary input inside an alcove whose back wall
//    surface oscillates. Must classify query-noise with zero pivot/yaw travel.
// ---------------------------------------------------------------------------
{
  const sideL = AABB.fromCentered(-3.2, 1.5, -2.4, 0.2, 3.4, 6, 'side-L');
  const sideR = AABB.fromCentered(3.2, 1.5, -2.4, 0.2, 3.4, 6, 'side-R');
  const back = AABB.fromCentered(0, 1.5, -2.4, 6.6, 3.4, 0.2, 'jitter-wall');
  for (const b of [sideL, sideR, back]) b.kind = 'wall';
  const colliders = [sideL, sideR, back];
  const kernel = new ThirdPersonCamera({ requestedDistance: 4.2, pitch: 0, fovDeg: 62 });
  const tracker = new ObstacleJitterTracker();
  const pivot = vec(0, 1.45, 0);
  const frames = 240;
  for (let i = 0; i < frames; i++) {
    const side = Math.floor(i / 8) % 2;
    const cz = -2.4 + (side === 0 ? 0.12 : -0.12);
    back.min.z = cz - 0.1;
    back.max.z = cz + 0.1;
    const r = kernel.update({ pivot, yaw: 0, pitch: 0, dt: DT, colliders, targetSamples: samples(vec(0, 0, 0)) });
    tracker.record(r, { pivot, yaw: 0, dt: DT, dynamicIds: new Set() });
  }
  const ev = tracker.events.find((e) => e.reason === JITTER_REASONS.NOISE);
  check('noise: classified query-noise', !!ev, JSON.stringify(tracker.events.map((e) => e.reason)));
  check(
    'noise: evidence shows stationary input + jumping query',
    !!ev && ev.evidence.pivotTravel === 0 && ev.evidence.yawTravelDeg === 0
      && ev.evidence.rawContactTravel >= 1.0,
    JSON.stringify(ev?.evidence),
  );
  check(
    'noise: not mistaken for a moving blocker',
    !!ev && ev.evidence.movingHitFrames === 0,
    JSON.stringify(ev?.evidence),
  );
}

// ---------------------------------------------------------------------------
// 4. Real geometric infeasibility: walk a static character into a dead-end
//    alcove. The distance loss tracks the legal limit smoothly; the tracker
//    must not call it query noise or state oscillation.
// ---------------------------------------------------------------------------
{
  const colliders = buildColliders();
  const kernel = new ThirdPersonCamera({ requestedDistance: 4.4, pitch: 15 * DEG });
  const tracker = new ObstacleJitterTracker();
  // Walk into the jitter-corner pocket and hold facing south: the static
  // corner wall then leaves only ~0.6 m of stand-off in every fan direction.
  const route = [];
  for (let i = 0; i <= 90; i++) {
    const t = i / 90;
    route.push({ x: 3.6 + 1.1 * t, z: -4.8 - 1.9 * t });
  }
  let holdBlocked = 0;
  let holdTotal = 0;
  for (let i = 0; i < route.length + 90; i++) {
    const wp = route[Math.min(i, route.length - 1)];
    const pos = vec(wp.x, 0, wp.z);
    const pivot = vec(wp.x, 1.45, wp.z);
    const r = kernel.update({ pivot, yaw: Math.PI, pitch: 15 * DEG, dt: DT, colliders, targetSamples: samples(pos) });
    tracker.record(r, { pivot, yaw: Math.PI, dt: DT, dynamicIds: new Set() });
    if (i >= route.length) {
      holdTotal++;
      if (r.hitId) holdBlocked++;
    }
  }
  const nonGeometry = tracker.events.filter((e) =>
    e.reason === JITTER_REASONS.NOISE || e.reason === JITTER_REASONS.MOVING);
  check('geometry: no false query-noise / moving-blocker labels', nonGeometry.length === 0,
    JSON.stringify(tracker.events.map((e) => e.reason)));
  check('geometry: static corner blocks most hold frames', holdBlocked >= holdTotal * 0.8,
    `${holdBlocked}/${holdTotal}`);
  const last = tracker.current;
  check('geometry: final frame reports real obstruction', last.obstructed && last.applied < 2.0,
    JSON.stringify({ obstructed: last.obstructed, applied: last.applied, hit: last.hitId }));
}

// ---------------------------------------------------------------------------
// 5. Clean room: smooth motion with no obstacle pressure must never report.
// ---------------------------------------------------------------------------
{
  const colliders = buildColliders();
  const kernel = new ThirdPersonCamera({ requestedDistance: 3.0, pitch: 15 * DEG });
  const tracker = new ObstacleJitterTracker();
  // Central start-room loop, well clear of every wall and prop.
  for (let i = 0; i < 300; i++) {
    const a = (i / 300) * Math.PI * 2;
    const pos = vec(-4 + Math.cos(a) * 1.1, 0, -0.5 + Math.sin(a) * 1.1);
    const pivot = vec(pos.x, 1.45, pos.z);
    const yaw = a + Math.PI / 2;
    const r = kernel.update({ pivot, yaw, pitch: 15 * DEG, dt: DT, colliders, targetSamples: samples(pos) });
    tracker.record(r, { pivot, yaw, dt: DT, dynamicIds: new Set() });
  }
  check('clean: zero jitter events', tracker.events.length === 0, String(tracker.events.length));
  check('clean: zero blocked frames', tracker.blockedFrameCount === 0, String(tracker.blockedFrameCount));
}

// ---------------------------------------------------------------------------
// 6. Bounded logging cost: trace and event ring buffers cannot grow past
//    capacity, even across a very long run.
// ---------------------------------------------------------------------------
{
  const colliders = buildColliders();
  const door = buildDoorCollider();
  colliders.push(door);
  const kernel = new ThirdPersonCamera({ requestedDistance: 4.2, pitch: 14 * DEG });
  const tracker = new ObstacleJitterTracker({ traceCapacity: 120, eventCapacity: 6 });
  const pos = vec(5.3, 0, -0.8);
  const pivot = vec(5.3, 1.45, -0.8);
  let t = 0;
  for (let i = 0; i < 2400; i++) {
    const movedId = updateDoorCollider(door, t);
    const r = kernel.update({
      pivot, yaw: 0, pitch: 14 * DEG, dt: DT, colliders, targetSamples: samples(pos),
    });
    tracker.record(r, { pivot, yaw: 0, dt: DT, dynamicIds: new Set(movedId ? [movedId] : []) });
    t += DT;
  }
  check('log: trace ring stays at capacity', tracker.frames.length === 120, String(tracker.frames.length));
  check('log: event ring stays at capacity', tracker.events.length <= 6, String(tracker.events.length));
  const summary = tracker.summary();
  check('log: summary reports the bounded depths',
    summary.traceDepth === 120 && summary.eventCapacity === 6,
    JSON.stringify(summary));
}

// ---------------------------------------------------------------------------
// 7. Replay JSON round-trip preserves every field.
// ---------------------------------------------------------------------------
{
  const trajectory = new ReplayTrajectory({ capacity: 60 });
  const colliders = buildColliders();
  const kernel = new ThirdPersonCamera({ requestedDistance: 3.4 });
  const pivot = vec(-3, 1.45, 1);
  const r = kernel.update({ pivot, yaw: 1, pitch: 15 * DEG, dt: DT, colliders, targetSamples: samples(vec(-3, 0, 1)) });
  trajectory.recordFrame(r, { pivot, yaw: 1, pitch: 15 * DEG, dt: DT });
  const restored = ReplayTrajectory.fromJSON(JSON.parse(JSON.stringify(trajectory.toJSON())));
  const first = [...restored][0];
  check('replay: round-trip frame count', restored.length === 1, String(restored.length));
  check('replay: round-trip applied distance', Math.abs(first.applied - r.distance) < 1e-6,
    `${first.applied} vs ${r.distance}`);
  check('replay: round-trip metadata dt', restored.meta.dt === Math.round(DT * 1000) / 1000,
    String(restored.meta.dt));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.pass).length;
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`\n${passed}/${results.length} diagnostics checks pass`);
process.exit(passed === results.length ? 0 : 1);
