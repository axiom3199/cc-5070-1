import { ThirdPersonCamera } from '../src/core/thirdPersonCamera.js';
import { buildColliders, levelSpec } from '../src/core/levelSpec.js';
import { vec } from '../src/core/collision.js';

const DEG = Math.PI / 180;
const colliders = buildColliders();

function makeSamples(position) {
  return [
    vec(position.x, position.y + 1.58, position.z),
    vec(position.x, position.y + 1.25, position.z),
    vec(position.x, position.y + 0.9, position.z),
  ];
}

function samplePivot(position) {
  return vec(position.x, position.y + 1.45, position.z);
}

/**
 * Drives the kernel along a trajectory of {position, yaw} with a fixed
 * requested distance, and asserts invariants every frame.
 */
export function runTrajectory(name, trajectory, options = {}) {
  const {
    requested = 3.4, pitch = 15 * DEG, dt = 1 / 60, framesPerLeg = null,
    maxNearIntrusions = 0, visibilityFloor = 0.0, expectObstruction = null,
  } = options;

  const kernel = new ThirdPersonCamera({ requestedDistance: requested, pitch });
  kernel.reset();

  const frames = [];
  const violations = [];
  let framesRun = 0;

  const legs = framesPerLeg ?? 30;
  for (let legIndex = 0; legIndex < trajectory.length - 1; legIndex++) {
    const a = trajectory[legIndex];
    const b = trajectory[legIndex + 1];
    const legFrames = typeof legs === 'number' ? legs : legs[legIndex] ?? 30;
    for (let f = 0; f < legFrames; f++) {
      const t = legFrames === 1 ? 1 : f / (legFrames - 1);
      const position = vec(
        a.position.x + (b.position.x - a.position.x) * t,
        0,
        a.position.z + (b.position.z - a.position.z) * t,
      );
      // Shortest-arc yaw interpolation.
      let yawDelta = b.yaw - a.yaw;
      while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
      while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
      const yaw = a.yaw + yawDelta * t;

      const pivot = samplePivot(position);
      const result = kernel.update({
        pivot,
        yaw,
        pitch,
        dt,
        colliders,
        targetSamples: makeSamples(position),
      });
      framesRun++;

      const checks = {
        hullFree: result.legality.hullFree,
        distanceWithinLimit: result.distance <= result.legalDistance + 1e-4,
        nearIntrusions: result.nearIntrusions <= maxNearIntrusions,
        visibility: result.visibility >= visibilityFloor,
        positionFinite: Number.isFinite(result.position.x + result.position.y + result.position.z),
      };
      if (!checks.hullFree || !checks.distanceWithinLimit || !checks.nearIntrusions || !checks.visibility || !checks.positionFinite) {
        violations.push({
          frame: framesRun,
          leg: legIndex,
          t,
          position: position.toArray(),
          yaw,
          result: {
            status: result.status,
            distance: result.distance,
            legal: result.legalDistance,
            visibility: result.visibility,
            near: result.nearIntrusions,
            hullFree: result.legality.hullFree,
            hit: result.hitId,
          },
        });
      }
      if (f === 0 || f === legFrames - 1) {
        frames.push({
          leg: legIndex,
          t,
          yaw,
          position: position.toArray(),
          applied: result.distance,
          legal: result.legalDistance,
          status: result.status,
          visibility: result.visibility,
          near: result.nearIntrusions,
          searched: result.sweep.searched,
          yawOffsetDeg: result.yawOffsetDeg,
        });
      }
    }
  }

  const obstructedFrames = framesRun && frames.some((f) => f.status !== 'clear');
  if (expectObstruction !== null && obstructedFrames !== expectObstruction) {
    violations.push({ frame: 'expectation', expected: expectObstruction, actual: obstructedFrames });
  }

  return {
    name,
    framesRun,
    violations,
    sampleFrames: frames,
    finalDistance: kernel.smoothedDistance,
    pass: violations.length === 0,
  };
}

export const scenarios = {
  narrowCorridor: () => runTrajectory(
    'narrow-corridor',
    [
      { position: vec(-3.0, 0, 0.0), yaw: Math.PI / 2 },
      { position: vec(0.0, 0, 0.0), yaw: Math.PI / 2 },
      { position: vec(0.0, 0, -2.6), yaw: Math.PI },
      { position: vec(0.0, 0, -5.0), yaw: Math.PI },
    ],
    { requested: 4.4, framesPerLeg: 90, visibilityFloor: 0.0 },
  ),

  lowCeiling: () => runTrajectory(
    'low-ceiling',
    [
      { position: vec(0, 0, 0.5), yaw: Math.PI },
      { position: vec(0, 0, -1.5), yaw: Math.PI },
      { position: vec(0, 0, -3.5), yaw: Math.PI },
      { position: vec(0, 0, -5.5), yaw: Math.PI },
    ],
    { requested: 4.2, pitch: 22 * DEG, framesPerLeg: 80, visibilityFloor: 1.0 },
  ),

  wallHugTurn: () => runTrajectory(
    'wall-hug-turn',
    [
      { position: vec(-0.55, 0, 1.2), yaw: Math.PI / 2 },
      { position: vec(-0.55, 0, -1.2), yaw: Math.PI / 2 },
      { position: vec(-0.55, 0, -3.4), yaw: 0 },
      { position: vec(-0.55, 0, -4.6), yaw: Math.PI / 2 },
      { position: vec(1.6, 0, -4.6), yaw: Math.PI },
    ],
    { requested: 4.8, pitch: 18 * DEG, framesPerLeg: 75, visibilityFloor: 0.0 },
  ),

  columnOcclusion: () => runTrajectory(
    'column-occlusion',
    [
      // Circle the column at a radius that keeps the character out of the
      // collider, so every frame has a satisfiable request.
      { position: vec(3.7, 0, -0.55), yaw: Math.PI },
      { position: vec(2.35, 0, -2.0), yaw: -Math.PI / 2 },
      { position: vec(3.7, 0, -3.45), yaw: 0 },
      { position: vec(5.05, 0, -2.0), yaw: Math.PI / 2 },
      { position: vec(3.7, 0, -0.55), yaw: Math.PI },
    ],
    { requested: 4.2, pitch: 16 * DEG, framesPerLeg: 60, visibilityFloor: 0.0 },
  ),

  columnBetween: () => {
    // The ideal stand-off passes straight through the column. The search must
    // swing the direction around it and still keep the character visible; the
    // centre-ray distance alone would look clear past the column's corners.
    const kernel = new ThirdPersonCamera({ requestedDistance: 4.2, pitch: 16 * DEG });
    kernel.reset();
    const position = vec(3.7, 0, -0.55);
    const pivot = samplePivot(position);
    const violations = [];
    let swingingFrames = 0;
    let best = null;
    for (let i = 0; i < 180; i++) {
      const r = kernel.update({
        pivot, yaw: 0, pitch: 16 * DEG, dt: 1 / 60, colliders,
        targetSamples: makeSamples(position),
      });
      if (!r.legality.hullFree || r.distance > r.legalDistance + 1e-4 || r.nearIntrusions > 0 || r.emergencyBackoffs > 0) {
        violations.push({ frame: i, status: r.status, distance: r.distance, legal: r.legalDistance, near: r.nearIntrusions });
      }
      if (r.yawOffsetDeg !== 0) swingingFrames++;
      best = r;
    }
    if (best.visibility < 1) violations.push({ frame: 'visibility', value: best.visibility });
    if (best.yawOffsetDeg === 0) violations.push({ frame: 'dir', value: 'did not avoid the column' });
    if (best.distance < 4.2 - 0.15) violations.push({ frame: 'distance', value: best.distance });
    return {
      name: 'column-between', framesRun: 180, violations,
      swingingFrames, finalDistance: best.distance, pass: violations.length === 0,
    };
  },

  standingSpin: () => {
    // A stationary character rotating in place next to a wall: the camera must
    // not sweep its volume through the divider.
    const kernel = new ThirdPersonCamera({ requestedDistance: 4.6, pitch: 16 * DEG });
    kernel.reset();
    const violations = [];
    let frames = 0;
    for (let i = 0; i < 240; i++) {
      const yaw = (i / 120) * Math.PI * 2;
      const pivot = samplePivot(vec(-0.5, 0, 0.2));
      const r = kernel.update({
        pivot, yaw, pitch: 16 * DEG, dt: 1 / 60, colliders,
        targetSamples: makeSamples(vec(-0.5, 0, 0.2)),
      });
      frames++;
      if (!r.legality.hullFree || r.distance > r.legalDistance + 1e-4 || r.nearIntrusions > 0 || r.emergencyBackoffs > 0) {
        violations.push({ frame: frames, status: r.status, distance: r.distance, legal: r.legalDistance, near: r.nearIntrusions, emergency: r.emergencyBackoffs });
      }
    }
    return { name: 'standing-spin', framesRun: frames, violations, pass: violations.length === 0 };
  },
};

export const allScenarioRuns = () => Object.entries(scenarios).map(([name, fn]) => fn());

export function summarize(runs) {
  return runs.map((r) => ({
    name: r.name,
    frames: r.framesRun,
    violations: r.violations.length,
    pass: r.pass,
    firstViolations: r.violations.slice(0, 3),
  }));
}

// CLI entry: `node tests/scenarios.js`
if (process.argv[1] && process.argv[1].endsWith('scenarios.js')) {
  const runs = allScenarioRuns();
  const summary = summarize(runs);
  for (const row of summary) {
    const mark = row.pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${row.name.padEnd(18)} ${String(row.frames).padStart(5)} frames  ${row.violations} violations`);
    if (!row.pass) console.log(JSON.stringify(row.firstViolations, null, 2));
  }
  const failed = summary.filter((r) => !r.pass).length;
  console.log(`\n${summary.length - failed}/${summary.length} scenarios pass · ${summary.reduce((n, r) => n + r.frames, 0)} frames checked`);
  process.exit(failed === 0 ? 0 : 1);
}
