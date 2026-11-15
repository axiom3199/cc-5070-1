import * as THREE from 'three';
import { levelSpec } from '../core/levelSpec.js';
import { AABB, vec } from '../core/collision.js';

export { levelSpec };

/**
 * Instantiates the level geometry in a three.js scene. The AABBs are derived
 * from the same spec used by the headless validator.
 */
export function buildInterior(scene, materials) {
  const group = new THREE.Group();
  group.name = 'level';
  scene.add(group);
  const colliders = [];

  for (const b of levelSpec.boxes) {
    const [cx, cy, cz] = b.center;
    const [sx, sy, sz] = b.size;
    if (!b.material || !materials[b.material]) continue;
    const geom = new THREE.BoxGeometry(sx, sy, sz);
    const mesh = new THREE.Mesh(geom, materials[b.material]);
    mesh.position.set(cx, cy, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.kind = b.kind;
    group.add(mesh);

    if (b.trim) {
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), materials.edge);
      edge.position.set(cx, cy, cz);
      group.add(edge);
    }

    if (b.collide) {
      const aabb = AABB.fromCentered(cx, cy, cz, sx, sy, sz, b.id);
      aabb.kind = b.kind;
      colliders.push(aabb);
      mesh.userData.colliderId = b.id;
    }
  }

  for (const p of levelSpec.panels) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...p.size), materials.lamp);
    mesh.position.set(...p.center);
    group.add(mesh);
  }

  // Roofs are hidden by the overhead inspection view so the plan reads from
  // above; the main camera keeps them visible.
  const roofs = group.children.filter((m) => m.userData?.kind === 'ceiling');

  return { colliders, group, roofs };
}

/** A path-following character proxy for deterministic camera scenarios. */
export function makeWaypoints(waypoints) {
  return waypoints.map(([x, z, yaw]) => ({ position: vec(x, 0, z), yaw }));
}
