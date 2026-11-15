/**
 * Analytic collision primitives for the third-person camera.
 *
 * Camera volume
 * -------------
 * The camera is a solid convex polytope, never a point. It consists of:
 *   - the near-clip rectangle at z = -(near + nearMargin), and
 *   - a rear shell enclosing the lens body,
 * expressed in camera local space (origin at the lens, looking down -Z).
 * Anything entering this volume would clip the near plane, so collision
 * queries test the whole polytope.
 *
 * Swept query
 * -----------
 * The camera's *orientation* is fixed by the view direction; only its position
 * changes along a ray from the pivot. Two convex sets translate relative to
 * each other, so the set of travel distances that produce an intersection is a
 * single interval (Minkowski/convexity). For each nearby box we compute that
 * interval exactly using SAT over a fixed axis set: 3 box axes + hull face
 * normals + (hull edge × box axis). Because the hull orientation is constant,
 * all of these axes are constant for the whole sweep.
 *
 * This is an exact conservative volume sweep: thin walls cannot be tunnelled,
 * and it costs far less than dense volume sampling.
 */

const EPS = 1e-7;

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  mul(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { return new Vec3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize() { const l = this.length(); return l > EPS ? this.mul(1 / l) : this; }
  distanceToSquared(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  toArray() { return [this.x, this.y, this.z]; }
}

export function vec(x, y, z) { return new Vec3(x, y, z); }
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export class AABB {
  constructor(min, max, id = '') {
    this.min = min.clone();
    this.max = max.clone();
    this.id = id;
  }
  static fromCentered(cx, cy, cz, sx, sy, sz, id = '') {
    return new AABB(vec(cx - sx / 2, cy - sy / 2, cz - sz / 2), vec(cx + sx / 2, cy + sy / 2, cz + sz / 2), id);
  }
  get center() { return this.min.clone().add(this.max).mul(0.5); }
  get half() { return this.max.clone().sub(this.min).mul(0.5); }
  contains(p, eps = 0) {
    return (
      p.x >= this.min.x - eps && p.x <= this.max.x + eps &&
      p.y >= this.min.y - eps && p.y <= this.max.y + eps &&
      p.z >= this.min.z - eps && p.z <= this.max.z + eps
    );
  }
}

export class CameraVolume {
  constructor({ fovDeg = 55, aspect = 16 / 9, near = 0.1, nearMargin = 0.12, rearRadius = 0.16 } = {}) {
    this.fovDeg = fovDeg;
    this.aspect = aspect;
    this.near = near;
    this.nearMargin = nearMargin;
    this.rearRadius = rearRadius;
    this.hull = this._buildHull();
  }

  _buildHull() {
    const depth = this.near + this.nearMargin;
    const hh = Math.tan((this.fovDeg * Math.PI) / 360) * this.near;
    const hw = hh * this.aspect;
    const r = this.rearRadius;
    this.depth = depth;
    this.halfWidth = hw;
    this.halfHeight = hh;
    const hull = [
      vec(-hw, -hh, -depth), vec(hw, -hh, -depth),
      vec(hw, hh, -depth), vec(-hw, hh, -depth),
      vec(-r, -r, 0), vec(r, -r, 0),
      vec(r, r, 0), vec(-r, r, 0),
    ];
    return hull;
  }

  setLens(fovDeg, aspect, near) {
    if (fovDeg === this.fovDeg && aspect === this.aspect && near === this.near) return false;
    this.fovDeg = fovDeg;
    this.aspect = aspect;
    this.near = near;
    this.rearRadius = Math.max(0.1, near * 1.6);
    this.hull = this._buildHull();
    return true;
  }

  static frame(position, target) {
    let back = position.clone().sub(target);
    if (back.lengthSq() < 1e-10) back = vec(0, 0, 1);
    back.normalize();
    let right = vec(0, 1, 0).cross(back);
    if (right.lengthSq() < 1e-8) right = vec(1, 0, 0);
    right.normalize();
    const up = back.cross(right);
    return { back, right, up };
  }

  /** World-space hull vertices for a camera at `position` looking at `target`. */
  worldHull(position, target) {
    const { back, right, up } = CameraVolume.frame(position, target);
    // Local +Z is backwards (toward the lens body), -Z is the view direction.
    return this.hull.map((p) => position.clone()
      .add(right.clone().mul(p.x))
      .add(up.clone().mul(p.y))
      .add(back.clone().mul(p.z)));
  }

  /**
   * Constant SAT axis set for a swept query at a fixed orientation.
   * @param {Vec3[]} points world hull vertices
   * @returns {{axes:Vec3[], hullMin:number[], hullMax:number[]}}
   */
  static buildSweepFrame(points) {
    const axes = [vec(1, 0, 0), vec(0, 1, 0), vec(0, 0, 1)];
    for (const [a, b, c] of CONVEX_HULL_FACES) {
      const n = points[b].clone().sub(points[a]).cross(points[c].clone().sub(points[a]));
      if (n.lengthSq() > 1e-12) axes.push(n.normalize());
    }
    for (const [a, b] of CONVEX_HULL_EDGES) {
      const e = points[b].clone().sub(points[a]);
      if (e.lengthSq() < 1e-12) continue;
      for (const boxAxis of [vec(1, 0, 0), vec(0, 1, 0), vec(0, 0, 1)]) {
        const n = e.cross(boxAxis);
        if (n.lengthSq() > 1e-12) axes.push(n.normalize());
      }
    }
    // Deduplicate near-parallel axes to keep the sweep cheap and stable.
    const unique = [];
    for (const n of axes) {
      if (!unique.some((u) => Math.abs(u.dot(n)) > 1 - 1e-6)) unique.push(n);
    }
    const hullMin = new Array(unique.length).fill(Infinity);
    const hullMax = new Array(unique.length).fill(-Infinity);
    for (let i = 0; i < unique.length; i++) {
      for (const p of points) {
        const d = p.dot(unique[i]);
        if (d < hullMin[i]) hullMin[i] = d;
        if (d > hullMax[i]) hullMax[i] = d;
      }
    }
    return { axes: unique, hullMin, hullMax };
  }

  /**
   * Exact travel interval [tEnter, tExit] over which the translating hull
   * overlaps `box`, or null. `dir` is a unit direction of motion.
   */
  static sweepInterval(frame, box, dir, maxT) {
    const { axes, hullMin, hullMax } = frame;
    const bc = box.center;
    const bh = box.half;
    let enter = 0;
    let exit = maxT;
    for (let i = 0; i < axes.length; i++) {
      const n = axes[i];
      const s = dir.dot(n);
      const bcProj = bc.dot(n);
      const bHalf = bh.x * Math.abs(n.x) + bh.y * Math.abs(n.y) + bh.z * Math.abs(n.z);
      const bMin = bcProj - bHalf;
      const bMax = bcProj + bHalf;
      const hMin = hullMin[i];
      const hMax = hullMax[i];
      if (Math.abs(s) < 1e-9) {
        if (hMax < bMin - 1e-9 || hMin > bMax + 1e-9) return null;
        continue;
      }
      // hMax + t*s >= bMin  and  hMin + t*s <= bMax
      const t1 = (bMin - hMax) / s;
      const t2 = (bMax - hMin) / s;
      const lo = Math.min(t1, t2);
      const hi = Math.max(t1, t2);
      if (lo > enter) enter = lo;
      if (hi < exit) exit = hi;
      if (enter > exit + 1e-9) return null;
    }
    if (exit < 0 || enter > maxT) return null;
    return { enter: Math.max(0, enter), exit: Math.min(maxT, exit) };
  }

  /** Boolean SAT test for one static pose. */
  static hullIntersectsAABB(points, box) {
    const frame = CameraVolume.buildSweepFrame(points);
    const { axes, hullMin, hullMax } = frame;
    const bc = box.center;
    const bh = box.half;
    for (let i = 0; i < axes.length; i++) {
      const n = axes[i];
      const c = bc.dot(n);
      const h = bh.x * Math.abs(n.x) + bh.y * Math.abs(n.y) + bh.z * Math.abs(n.z);
      if (hullMin[i] > c + h + EPS || hullMax[i] < c - h - EPS) return false;
    }
    return true;
  }

  intersects(colliders, position, target) {
    const points = this.worldHull(position, target);
    for (const box of colliders) {
      if (CameraVolume.hullIntersectsAABB(points, box)) return box;
    }
    return null;
  }

  /**
   * Exact first contact distance from `origin` along `dir` (unit) for the camera
   * volume looking back at the origin. The camera's backward axis is `dir`, so
   * the hull orientation is fixed over the whole sweep and the per-box overlap
   * interval is exact. Returns the free distance before contact, along with the
   * blocking box and the raw interval.
   *
   * @returns {{distance:number, hit:object|null, enter:number|null, exit:number|null, boxesTested:number}}
   */
  firstContact(colliders, origin, dir, maxDist) {
    // Build an orientation-only frame: back axis = dir. Passing a synthetic
    // target behind the origin avoids the degenerate position==target case.
    const syntheticTarget = origin.clone().sub(dir);
    const points = this.worldHull(origin, syntheticTarget);
    const frame = CameraVolume.buildSweepFrame(points);
    let bestEnter = maxDist;
    let bestHit = null;
    let bestExit = null;
    let boxesTested = 0;
    const endPoints = points.map((p) => p.clone().add(dir.clone().mul(maxDist)));
    // Broad phase: swept AABB of all hull vertices.
    const lo = vec(Infinity, Infinity, Infinity);
    const hi = vec(-Infinity, -Infinity, -Infinity);
    for (const p of points.concat(endPoints)) {
      lo.x = Math.min(lo.x, p.x); lo.y = Math.min(lo.y, p.y); lo.z = Math.min(lo.z, p.z);
      hi.x = Math.max(hi.x, p.x); hi.y = Math.max(hi.y, p.y); hi.z = Math.max(hi.z, p.z);
    }
    for (const box of colliders) {
      if (box.max.x < lo.x || box.min.x > hi.x) continue;
      if (box.max.y < lo.y || box.min.y > hi.y) continue;
      if (box.max.z < lo.z || box.min.z > hi.z) continue;
      boxesTested++;
      const interval = CameraVolume.sweepInterval(frame, box, dir, maxDist);
      if (!interval) continue;
      if (interval.enter < bestEnter) {
        bestEnter = interval.enter;
        bestHit = box;
        bestExit = interval.exit;
      }
    }
    if (!bestHit) {
      return { distance: maxDist, hit: null, enter: null, exit: null, boxesTested };
    }
    return { distance: bestEnter, hit: bestHit, enter: bestEnter, exit: bestExit, boxesTested };
  }
}

export const CONVEX_HULL_FACES = [
  [0, 1, 2], [0, 2, 3],
  [4, 6, 5], [4, 7, 6],
  [0, 4, 5], [0, 5, 1],
  [1, 5, 6], [1, 6, 2],
  [2, 6, 7], [2, 7, 3],
  [3, 7, 4], [3, 4, 0],
];
export const CONVEX_HULL_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/** Segment vs AABB slab test. Returns entry fraction or null. */
export function segmentAABB(origin, dir, box, maxT = 1) {
  const inv = vec(1 / (dir.x || 1e-12), 1 / (dir.y || 1e-12), 1 / (dir.z || 1e-12));
  let tmin = 0;
  let tmax = maxT;
  for (const axis of ['x', 'y', 'z']) {
    let t1 = (box.min[axis] - origin[axis]) * inv[axis];
    let t2 = (box.max[axis] - origin[axis]) * inv[axis];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Line-of-sight test between two points against AABB colliders. */
export function segmentVisible(a, b, colliders) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  if (len < 1e-8) return true;
  for (const box of colliders) {
    if (segmentAABB(a, dir, box, 1) !== null) return false;
  }
  return true;
}
