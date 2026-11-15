/**
 * Sliding door panel: the level's one dynamic collider.
 *
 * The panel is a real AABB in the same collider list the camera sweeps against
 * — it is never a render-only decoration and collision is never disabled for
 * it. Its centre is a pure function of time (triangle wave between two slide
 * endpoints), so headless diagnostics and the browser demo compute identical
 * poses from identical time values.
 */
import { AABB, vec } from './collision.js';

export const DOOR_SPEC = Object.freeze({
  id: 'sliding-door',
  // Panel slides along Z, across the camera's behind-the-character stand-off
  // line: its broad 1.5 m face crosses the sweep when the character waits at
  // (5.3, ~-0.8). Half-open at t = 0, full travel every half cycle.
  base: { x: 5.3, y: 1.3, z: -2.6 },
  size: { x: 1.5, y: 2.6, z: 0.18 },
  axis: 'z',
  travel: 2.4,
  period: 6.0,
});

/** Door centre at time `seconds`; deterministic, no hidden state. */
export function doorCenterAt(timeSeconds, spec = DOOR_SPEC) {
  const { base, travel, period } = spec;
  const phase = (timeSeconds % period) / period; // 0..1
  // Triangle wave 0 -> 1 -> 0 over one period.
  const wave = phase < 0.5 ? phase * 2 : 2 - phase * 2;
  const offset = (wave - 0.5) * travel;
  return {
    x: base.x + (spec.axis === 'x' ? offset : 0),
    y: base.y,
    z: base.z + (spec.axis === 'z' ? offset : 0),
  };
}

/** Build the door collider at its t = 0 centre. */
export function buildDoorCollider(spec = DOOR_SPEC) {
  const c = doorCenterAt(0, spec);
  const box = AABB.fromCentered(c.x, c.y, c.z, spec.size.x, spec.size.y, spec.size.z, spec.id);
  box.kind = 'door';
  box.dynamic = true;
  return box;
}

/**
 * Move an existing door collider in place to the pose for `timeSeconds`.
 * Returns the id when the centre actually changed, otherwise null.
 */
export function updateDoorCollider(box, timeSeconds, spec = DOOR_SPEC) {
  const c = doorCenterAt(timeSeconds, spec);
  const hx = spec.size.x / 2;
  const hy = spec.size.y / 2;
  const hz = spec.size.z / 2;
  const moved = box.min.x !== c.x - hx || box.min.z !== c.z - hz;
  box.min.set(c.x - hx, c.y - hy, c.z - hz);
  box.max.set(c.x + hx, c.y + hy, c.z + hz);
  return moved ? spec.id : null;
}

/** Apply a recorded centre (replay) directly to a door collider. */
export function setDoorCenter(box, center, spec = DOOR_SPEC) {
  const hx = spec.size.x / 2;
  const hy = spec.size.y / 2;
  const hz = spec.size.z / 2;
  box.min.set(center.x - hx, center.y - hy, center.z - hz);
  box.max.set(center.x + hx, center.y + hy, center.z + hz);
}

export function doorStateMap(timeSeconds, spec = DOOR_SPEC) {
  const c = doorCenterAt(timeSeconds, spec);
  return new Map([[spec.id, { ...c }]]);
}

export { vec };
