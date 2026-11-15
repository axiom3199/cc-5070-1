/**
 * Interior level specification shared by the renderer, the interactive app and
 * the headless validation runner. Every \`collide\` entry becomes an AABB that
 * both the renderer and the camera query use, so HUD numbers and pixels can
 * never disagree.
 *
 * Coordinates: X right, Y up, Z forward. Ground at y = 0.
 *
 *   x [-7,-1] : start room, ceiling 3.4
 *   x [-1, 1] : 1.74 m clear corridor, high then low (2.55 m) ceiling
 *   x [1, 7]  : east room, column + crates + tight corner
 */
import { AABB, vec } from './collision.js';

const BOXES = [
  // id, center, size, material, collide, kind, trim
  ['floor', [0, -0.25, -1.5], [15, 0.5, 14], 'floor', true, 'floor', false],

  ['wall-west', [-7.15, 1.7, -1.5], [0.3, 3.4, 14], 'wall', true, 'wall', false],
  ['wall-east', [7.15, 1.7, -1.5], [0.3, 3.4, 14], 'wall', true, 'wall', false],
  ['wall-north', [0, 1.7, -8.15], [14.6, 3.4, 0.3], 'wall', true, 'wall', false],
  ['wall-south', [0, 1.7, 5.15], [14.6, 3.4, 0.3], 'wall', true, 'wall', false],

  // Start-room / corridor divider, doorway opening z [-1.1, 0.9].
  ['divider-a', [-1.0, 1.6, -3.55], [0.26, 3.2, 3.9], 'wall', true, 'wall', false],
  ['divider-b', [-1.0, 1.6, 3.05], [0.26, 3.2, 3.9], 'wall', true, 'wall', true],
  ['door-header', [-1.0, 2.72, -0.1], [0.26, 0.96, 2.0], 'wall', false, 'wall', true],

  // Corridor / east-room divider. Openings: low door z [-5.2,-3.6], main z [-1.1,0.9].
  ['east-divider-a', [1.0, 1.6, -6.6], [0.26, 3.2, 2.8], 'wall', true, 'wall', false],
  ['east-divider-b', [1.0, 1.6, -2.35], [0.26, 3.2, 2.5], 'wall', true, 'wall', true],
  ['east-divider-c', [1.0, 1.6, 2.95], [0.26, 3.2, 4.1], 'wall', true, 'wall', true],
  ['east-header-low', [1.0, 2.7, -4.4], [0.26, 1.0, 1.6], 'wall', false, 'wall', true],

  // Ceilings.
  ['corridor-ceiling-high', [0, 3.3, 1.6], [2.26, 0.2, 6.8], 'ceiling', true, 'ceiling', false],
  ['corridor-ceiling-low', [0, 2.64, -4.6], [2.26, 0.18, 6.6], 'ceiling', true, 'ceiling', true],
  ['start-ceiling', [-4, 3.4, -1.5], [6.0, 0.2, 14], 'ceiling', true, 'ceiling', true],
  ['east-ceiling', [4, 3.4, -1.5], [6.0, 0.2, 14], 'ceiling', true, 'ceiling', true],

  // Step fascia between high and low corridor ceiling.
  ['corridor-step', [0, 2.86, -1.55], [2.26, 0.44, 0.16], 'wall', true, 'wall', true],

  // Props used for corner / wall-hug tests.
  ['column-a', [3.7, 1.25, -2.0], [1.0, 2.5, 1.0], 'prop', true, 'prop', true],
  ['crate-a', [3.0, 0.45, 1.2], [1.0, 0.9, 1.0], 'prop', true, 'prop', true],
  ['crate-b', [4.4, 0.35, 2.0], [0.8, 0.7, 0.8], 'prop', true, 'prop', true],
  ['pillar-slit', [1.0, 1.6, 0.25], [0.28, 3.2, 0.5], 'prop', true, 'prop', true],
  ['desk', [-4.3, 0.38, 0.2], [1.8, 0.76, 0.9], 'prop', true, 'prop', true],
  ['bench', [-2.1, 0.24, -3.2], [1.2, 0.48, 0.5], 'prop', true, 'prop', true],

  // Skirting.
  ['skirting-north', [0, 0.05, -7.98], [13.6, 0.1, 0.06], 'trim', false, 'trim', false],
  ['skirting-south', [0, 0.05, 4.98], [13.6, 0.1, 0.06], 'trim', false, 'trim', false],
];

const PANELS = [
  [[-4, 3.26, 1.6], [1.7, 0.05, 0.22]],
  [[-4, 3.26, -2.8], [1.7, 0.05, 0.22]],
  [[4, 3.26, 1.2], [1.7, 0.05, 0.22]],
  [[0, 3.16, 2.4], [0.9, 0.05, 0.18]],
  [[0, 2.53, -4.2], [0.9, 0.05, 0.18]],
];

export const levelSpec = {
  spawn: { position: vec(-3.4, 0, 2.0), yaw: Math.PI * 0.62 },
  bounds: { minX: -6.7, maxX: 6.7, minZ: -7.7, maxZ: 4.7 },
  playerBounds: { minX: -6.6, maxX: 6.6, minZ: -7.6, maxZ: 4.6 },
  boxes: BOXES.map(([id, center, size, material, collide, kind, trim]) => ({
    id, center, size, material, collide, kind, trim,
  })),
  panels: PANELS.map(([center, size]) => ({ center, size })),
};

export function buildColliders(spec = levelSpec) {
  const colliders = [];
  for (const b of spec.boxes) {
    if (!b.collide) continue;
    const aabb = AABB.fromCentered(b.center[0], b.center[1], b.center[2], b.size[0], b.size[1], b.size[2], b.id);
    aabb.kind = b.kind;
    colliders.push(aabb);
  }
  return colliders;
}
