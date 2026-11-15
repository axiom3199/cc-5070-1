import { CameraVolume, clamp, segmentAABB, segmentVisible, vec } from './collision.js';

const DEG = Math.PI / 180;
// Fan tiers: the narrow ring is tried first; wider rings are only evaluated
// when a nearer ring cannot restore the requested distance or visibility.
// The wide rings allow a lateral "over the shoulder into the corridor" view
// when the character is hugging a wall with its back to it.
const YAW_TIERS = [
  [0, 9, -9, 19, -19],
  [32, -32],
  [48, -48],
  [65, -65, 80, -80],
];
const PITCH_ORDER = [0, 6, -6];

/**
 * Third-person camera kernel (renderer-agnostic).
 *
 * Guarantees, per update:
 *  - The camera is a solid convex volume (near rectangle + rear shell); all
 *    collision queries sweep that volume, never a centre ray.
 *  - The applied pose is verified free at the end of every frame.
 *  - The applied distance is hard-clamped to the current frame's legal limit,
 *    so a smoothed-but-illegal intermediate is never rendered.
 *
 * Behaviour:
 *  - The ideal direction is straight behind the character.
 *  - When that direction loses distance or the character is hidden, a small
 *    angular fan is searched; the best candidate balances kept distance,
 *    target visibility and angular deviation, with hysteresis.
 *  - Direction offsets are eased, then the *eased* pose is re-swept. If easing
 *    would pass through a corner, the offset snaps into the safe basin.
 *  - Shortening is fast, recovery is slow and delayed; both are bounded by
 *    the exact legal limit.
 */
export class ThirdPersonCamera {
  constructor(config = {}) {
    this.config = {
      fovDeg: 55,
      aspect: 16 / 9,
      near: 0.1,
      nearMargin: 0.12,
      rearRadius: 0.16,
      minDistance: 0.8,
      maxDistance: 6.5,
      requestedDistance: 3.4,
      pitch: 15 * DEG,
      pitchMin: -22 * DEG,
      pitchMax: 58 * DEG,
      contactEpsilon: 0.03,
      shrinkTau: 0.07,
      growTau: 0.45,
      recoveryDwell: 0.18,
      directionTau: 0.12,
      hysteresis: 0.08,
      ...config,
    };

    this.volume = new CameraVolume({
      fovDeg: this.config.fovDeg,
      aspect: this.config.aspect,
      near: this.config.near,
      nearMargin: this.config.nearMargin,
      rearRadius: this.config.rearRadius,
    });

    this.setRequestedDistance(this.config.requestedDistance);
    this.reset();
  }

  reset() {
    this.time = 0;
    this.smoothedDistance = this.config.requestedDistance;
    this.smoothedYawOffset = 0;
    this.smoothedPitchOffset = 0;
    this.previousKey = null;
    this.freeSince = null;
    this.phase = 'steady';
    this.status = 'clear';
    this.degraded = false;
    this.candidates = [];
    this.query = null;
    this.lastResult = null;
    this.holdPosition = null;
    this.holdTarget = null;
  }

  setLens({ fovDeg, aspect, near }) {
    if (fovDeg !== undefined) this.config.fovDeg = fovDeg;
    if (near !== undefined) this.config.near = near;
    if (aspect !== undefined) this.config.aspect = aspect;
    this.volume.setLens(this.config.fovDeg, this.config.aspect, this.config.near);
  }

  setRequestedDistance(distance) {
    const n = Number(distance);
    this.config.requestedDistance = clamp(
      Number.isFinite(n) ? n : this.config.minDistance,
      this.config.minDistance,
      this.config.maxDistance,
    );
    return this.config.requestedDistance;
  }

  /**
   * Offset from the pivot toward the camera. `yaw` is the character facing
   * (forward = sin/+cos), so the camera sits behind, raised by `pitch`.
   */
  outwardDirection(yaw, pitch) {
    const cp = Math.cos(pitch);
    return vec(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  }

  /** Exact legal stand-off along `dir`, limited by `requested`. */
  legalDistance(pivot, dir, requested, colliders) {
    const contact = this.volume.firstContact(colliders, pivot, dir, requested);
    const safe = contact.hit
      ? Math.max(0, contact.distance - this.config.contactEpsilon)
      : requested;
    return {
      distance: safe,
      raw: contact.distance,
      hit: contact.hit?.id ?? null,
      startBlocked: contact.hit !== null && contact.distance <= 1e-6,
      boxesTested: contact.boxesTested,
    };
  }

  targetVisibility(position, samples, colliders) {
    if (!samples || samples.length === 0) return 1;
    let visible = 0;
    for (const sample of samples) if (segmentVisible(position, sample, colliders)) visible++;
    return visible / samples.length;
  }

  candidate({ pivot, yaw, pitch, requested, colliders, samples, yawOffset, pitchOffset }) {
    const dir = this.outwardDirection(
      yaw + yawOffset * DEG,
      clamp(pitch + pitchOffset * DEG, this.config.pitchMin, this.config.pitchMax),
    );
    const q = this.legalDistance(pivot, dir, requested, colliders);
    const position = pivot.clone().add(dir.clone().mul(q.distance));
    const visibility = this.targetVisibility(position, samples, colliders);
    const ratio = requested > 1e-6 ? q.distance / requested : 0;
    // Scoring tradeoffs, in priority order:
    //  1. keep the requested distance (this must dominate: a wide-but-legal
    //     view should beat a "behind the character" view that hugs the wall),
    //  2. never dive below a comfortable stand-off unless unavoidable,
    //  3. keep the target visible,
    //  4. prefer small angular deviations (sub-linear cost, so a modest swing
    //     is cheap but does not overpower the distance term).
    const distanceReward = Math.pow(ratio, 1.2) * 1.7;
    const visibilityReward = visibility * 1.0;
    const comfort = 1.8;
    const comfortPenalty = q.distance < comfort ? (comfort - q.distance) * 0.9 : 0;
    const yawPenalty = Math.pow(Math.abs(yawOffset) / 90, 2) * 0.55;
    const pitchPenalty = Math.pow(Math.abs(pitchOffset) / 6, 2) * 0.12;
    const score = distanceReward + visibilityReward - comfortPenalty - yawPenalty - pitchPenalty;
    return {
      yawOffset, pitchOffset, dir, legal: q.distance, position, visibility, score,
      hit: q.hit, startBlocked: q.startBlocked, boxesTested: q.boxesTested,
    };
  }

  /**
   * @param {object} input
   * @param {Vec3} input.pivot look-at point on the character
   * @param {number} input.yaw camera orbit yaw; forward = (sin yaw, 0, cos yaw)
   * @param {number} input.pitch elevation, radians
   * @param {number} input.dt seconds
   * @param {Array} input.colliders AABBs
   * @param {Vec3[]} input.targetSamples visibility samples on the character
   */
  update({ pivot, yaw, pitch, dt, colliders, targetSamples = [] }) {
    const cfg = this.config;
    const step = clamp(dt, 0, 0.1);
    this.time += step;
    const requested = clamp(cfg.requestedDistance, cfg.minDistance, cfg.maxDistance);
    const aimPitch = clamp(Number.isFinite(pitch) ? pitch : cfg.pitch, cfg.pitchMin, cfg.pitchMax);
    const samples = targetSamples;
    let evaluated = 0;
    let boxesTested = 0;

    // ---- 1. Ideal direction, straight behind the character. -------------
    const idealDir = this.outwardDirection(yaw, aimPitch);
    const idealQ = this.legalDistance(pivot, idealDir, requested, colliders);
    boxesTested += idealQ.boxesTested;
    const idealPosition = pivot.clone().add(idealDir.clone().mul(idealQ.distance));
    const idealVisibility = this.targetVisibility(idealPosition, samples, colliders);
    const idealClear = !idealQ.hit && idealQ.distance >= requested - 1e-6 && idealVisibility >= 0.75;
    evaluated = 1;

    let best;
    let searched = false;
    if (idealClear) {
      best = {
        yawOffset: 0, pitchOffset: 0, dir: idealDir, legal: idealQ.distance,
        position: idealPosition, visibility: idealVisibility,
        score: 0, hit: null, startBlocked: false,
      };
    } else {
      // ---- 2. Tiered angular fan when the ideal pose is limited or hidden. --
      // Narrow rings first; widen only if distance or visibility is still bad.
      searched = true;
      const cands = [];
      let bestNarrow = null;
      for (let tier = 0; tier < YAW_TIERS.length; tier++) {
        for (const yawOffset of YAW_TIERS[tier]) {
          for (const pitchOffset of PITCH_ORDER) {
            const c = this.candidate({
              pivot, yaw, pitch: aimPitch, requested, colliders, samples, yawOffset, pitchOffset,
            });
            evaluated++;
            boxesTested += c.boxesTested;
            cands.push(c);
            if (!best || c.score > best.score + 1e-9) best = c;
            if (tier === 0 && (!bestNarrow || c.score > bestNarrow.score + 1e-9)) bestNarrow = c;
          }
        }
        const narrowGood = bestNarrow && bestNarrow.legal >= requested - 0.12 && bestNarrow.visibility >= 0.9;
        if (narrowGood) break;
      }
      if (this.previousKey) {
        const prev = cands.find((c) => `${c.yawOffset},${c.pitchOffset}` === this.previousKey);
        // Hysteresis keeps a previously selected direction only when it is
        // still competitive on distance, not merely on score.
        if (prev && prev.legal > 0.15 && prev.legal >= best.legal - 0.35 && prev.score >= best.score - cfg.hysteresis) {
          best = prev;
        }
      }
      this.candidates = cands;
    }
    this.previousKey = `${best.yawOffset},${best.pitchOffset}`;

    // ---- 3. Ease the direction offset, then re-validate the eased pose. ---
    const dirAlpha = 1 - Math.exp(-step / cfg.directionTau);
    this.smoothedYawOffset += (best.yawOffset - this.smoothedYawOffset) * dirAlpha;
    this.smoothedPitchOffset += (best.pitchOffset - this.smoothedPitchOffset) * dirAlpha;
    let appliedYawOffset = this.smoothedYawOffset;
    let appliedPitchOffset = this.smoothedPitchOffset;
    const easedDir = () => this.outwardDirection(
      yaw + appliedYawOffset * DEG,
      clamp(aimPitch + appliedPitchOffset * DEG, cfg.pitchMin, cfg.pitchMax),
    );
    let appliedDir = easedDir();
    let appliedQ = this.legalDistance(pivot, appliedDir, requested, colliders);
    boxesTested += appliedQ.boxesTested;

    // Easing must not drag the volume through a corner: if the eased direction
    // loses too much of the selected basin's distance, snap the offset.
    const selected = best;
    const easedWorse = selected.legal > 0.2 && appliedQ.distance < Math.max(selected.legal * 0.55, 0.25);
    if (easedWorse) {
      this.smoothedYawOffset = selected.yawOffset;
      this.smoothedPitchOffset = selected.pitchOffset;
      appliedYawOffset = selected.yawOffset;
      appliedPitchOffset = selected.pitchOffset;
      appliedDir = easedDir();
      appliedQ = this.legalDistance(pivot, appliedDir, requested, colliders);
      boxesTested += appliedQ.boxesTested;
    }

    // ---- 4. Distance smoothing, bounded by the exact legal limit. --------
    const legal = appliedQ.distance;
    const target = Math.min(requested, legal);
    let clampedBySafety = false;

    if (target < this.smoothedDistance) {
      const a = 1 - Math.exp(-step / cfg.shrinkTau);
      this.smoothedDistance += (target - this.smoothedDistance) * a;
      this.phase = 'shortening';
      // Only an actively shrinking limit restarts the recovery dwell; a
      // persistently reduced (but stable) legal distance still recovers to it.
      this.freeSince = null;
    } else if (target > this.smoothedDistance) {
      if (this.freeSince === null) this.freeSince = this.time;
      if (this.time - this.freeSince >= cfg.recoveryDwell) {
        const a = 1 - Math.exp(-step / cfg.growTau);
        this.smoothedDistance += (target - this.smoothedDistance) * a;
        this.phase = 'recovering';
      } else {
        this.phase = 'waiting';
      }
    } else {
      this.smoothedDistance = target;
      this.phase = 'steady';
    }

    let applied = this.smoothedDistance;
    if (applied > legal) {
      applied = legal;
      clampedBySafety = true;
    }
    applied = clamp(applied, 0, legal);
    this.smoothedDistance = applied;

    // ---- 5. Verify the exact final pose. ---------------------------------
    let position = pivot.clone().add(appliedDir.clone().mul(applied));
    let finalHit = this.volume.intersects(colliders, position, pivot);
    let emergencyBackoffs = 0;
    while (finalHit && applied > 1e-4) {
      applied = Math.max(0, applied - cfg.contactEpsilon);
      position = pivot.clone().add(appliedDir.clone().mul(applied));
      finalHit = this.volume.intersects(colliders, position, pivot);
      emergencyBackoffs++;
    }
    // ---- 6. Diagnostics ---------------------------------------------------
    const visibility = this.targetVisibility(position, samples, colliders);
    const nearIntrusions = this.probeNearPlane(colliders, position, pivot);
    const centreRay = this.centreRayProbe(pivot, appliedDir, requested, colliders);
    const hullFree = !finalHit;

    if (!hullFree) {
      // Absolute last resort: hold the previous verified pose for this frame.
      if (this.holdPosition) {
        position = this.holdPosition.clone();
        applied = position.clone().sub(pivot).length();
      }
    } else {
      this.holdPosition = position.clone();
      this.holdTarget = pivot.clone();
    }

    const obstructed = legal < requested - 0.02 || best.yawOffset !== 0 || best.pitchOffset !== 0;
    const noSafePose = applied < cfg.minDistance * 0.55;
    this.degraded = noSafePose || !hullFree;
    this.status = !hullFree ? 'illegal' : noSafePose ? 'degraded' : obstructed ? 'obstructed' : 'clear';

    const desiredPosition = pivot.clone().add(idealDir.clone().mul(requested));
    const result = {
      position,
      target: pivot.clone(),
      distance: applied,
      legalDistance: legal,
      requestedDistance: requested,
      desiredPosition,
      desiredDirection: idealDir,
      appliedDirection: appliedDir,
      status: this.status,
      degraded: this.degraded,
      obstructed,
      nearIntrusions,
      visibility,
      idealVisibility,
      hull: this.volume.worldHull(position, pivot),
      nearCorners: this.nearPlaneCorners(position, pivot),
      yawOffsetDeg: best.yawOffset,
      pitchOffsetDeg: best.pitchOffset,
      appliedYawOffsetDeg: appliedYawOffset,
      appliedPitchOffsetDeg: appliedPitchOffset,
      hitId: appliedQ.hit ?? best.hit ?? null,
      phase: this.phase,
      clampedBySafety,
      emergencyBackoffs,
      legality: {
        hullFree,
        distanceWithinLimit: applied <= legal + 1e-6,
        nearPlaneIntrusions: nearIntrusions,
      },
      sweep: {
        boxesTested,
        evaluatedCandidates: evaluated,
        searched,
        rawContactDistance: appliedQ.raw,
        limit: legal,
      },
      centreRay,
      targetSamples: samples,
      volumeSpec: {
        fovDeg: this.volume.fovDeg,
        near: this.volume.near,
        nearMargin: this.volume.nearMargin,
        rearRadius: this.volume.rearRadius,
        depth: this.volume.depth,
        halfWidth: this.volume.halfWidth,
        halfHeight: this.volume.halfHeight,
      },
      combinedHitId: appliedQ.hit ?? best.hit ?? null,
    };

    this.query = result;
    this.lastResult = result;
    return result;
  }

  nearPlaneCorners(position, target) {
    const { back, right, up } = CameraVolume.frame(position, target);
    const depth = this.volume.depth;
    const hw = this.volume.halfWidth;
    const hh = this.volume.halfHeight;
    // Near plane sits at camera-local z = -depth; back is camera +Z.
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
      .map(([x, y]) => position.clone().add(right.clone().mul(x)).add(up.clone().mul(y)).add(back.clone().mul(-depth)));
  }

  /** Diagnostic only: a point ray, shown in the HUD to contrast the real sweep. */
  centreRayProbe(pivot, dir, maxDist, colliders) {
    for (const box of colliders) {
      const t = segmentAABB(pivot, dir.clone().mul(maxDist), box, 1);
      if (t !== null) return { distance: t * maxDist, hit: box.id };
    }
    return { distance: maxDist, hit: null };
  }

  probeNearPlane(colliders, position, target) {
    const corners = this.nearPlaneCorners(position, target);
    const samples = [];
    for (let i = 0; i < 4; i++) {
      samples.push(corners[i]);
      samples.push(corners[i].clone().add(corners[(i + 1) % 4]).mul(0.5));
    }
    samples.push(corners.reduce((acc, p) => acc.add(p), vec(0, 0, 0)).mul(0.25));
    let intrusions = 0;
    for (const p of samples) {
      for (const box of colliders) {
        if (box.contains(p, 1e-4)) { intrusions++; break; }
      }
    }
    return intrusions;
  }
}
