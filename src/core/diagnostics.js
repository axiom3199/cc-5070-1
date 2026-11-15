/**
 * Obstacle jitter tracking and replay recording for the third-person camera.
 *
 * The tracker is observational only: it never changes a collision query, a
 * distance or a pose. Every frame it records the compact evidence chain behind
 * the applied camera distance — requested / legal / raw contact / applied
 * distance, blocking box, selected candidate key and distance phase — and
 * detects push/pull episodes from that evidence.
 *
 * Root-cause classes (each backed by explicit evidence, never guessed):
 *
 *  - geometry-infeasible  the geometry genuinely cannot host the requested
 *                         stand-off while the query input is stable: the
 *                         blocking box is static, the raw contact moves with
 *                         the blocker and the applied distance follows the
 *                         legal limit. This is a real constraint, not noise.
 *  - moving-blocker       the blocker itself moves (the sliding door panel):
 *                         the contact distance changes while the pivot is
 *                         stationary and the blocking box id is dynamic.
 *  - query-noise          the raw contact / legal distance jitters while both
 *                         the pivot and every collider are stationary, so no
 *                         geometric cause exists for the query to change.
 *  - state-update         the kernel's own selection/smoothing state oscillates
 *                         around real geometry: the applied distance reverses,
 *                         the phase flips, or the selected candidate key
 *                         alternates while the pivot stays put (a slow orbit
 *                         that changes which fan basin wins counts here, since
 *                         the query itself stays exact frame to frame).
 *
 * Memory is bounded: frame traces and jitter events are ring buffers, so a
 * long session cannot grow the log without limit.
 */
import { clamp, vec } from './collision.js';

const DEG = Math.PI / 180;

export const JITTER_REASONS = Object.freeze({
  GEOMETRY: 'geometry-infeasible',
  MOVING: 'moving-blocker',
  NOISE: 'query-noise',
  STATE: 'state-update',
});

export const REASON_LABELS = Object.freeze({
  'geometry-infeasible': 'Real infeasible geometry',
  'moving-blocker': 'Moving blocker (door panel)',
  'query-noise': 'Collision query noise',
  'state-update': 'Camera state update oscillation',
});

const round3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

export class ObstacleJitterTracker {
  /**
   * @param {object} opts
   * @param {number} opts.traceCapacity ring-buffer size for frame traces
   * @param {number} opts.eventCapacity ring-buffer size for jitter events
   * @param {number} opts.windowSeconds push/pull detection window
   * @param {number} opts.minAmplitude minimum applied-distance excursion (m)
   * @param {number} opts.stationaryTolerance pivot movement below which the
   *   query input counts as stationary (m/frame)
   * @param {number} opts.legalNoiseTolerance legal-distance change below which
   *   the query evidence counts as stable (m/frame)
   */
  constructor({
    traceCapacity = 900,
    eventCapacity = 24,
    windowSeconds = 0.6,
    minAmplitude = 0.08,
    stationaryTolerance = 0.02,
    legalNoiseTolerance = 0.012,
  } = {}) {
    this.config = {
      traceCapacity: Math.max(60, traceCapacity | 0),
      eventCapacity: Math.max(4, eventCapacity | 0),
      windowSeconds,
      minAmplitude,
      stationaryTolerance,
      legalNoiseTolerance,
    };
    this.reset();
  }

  reset() {
    this.frames = [];
    this.events = [];
    this.time = 0;
    this.frameIndex = 0;
    this.keyFlips = 0;
    this.distanceReversals = 0;
    this.phaseFlips = 0;
    this.blockedFrameCount = 0;
    this._lastKey = null;
    this._lastPhase = null;
    this._lastApplied = null;
    this._lastAppliedDelta = 0;
    this._episode = null;
    this.current = null;
  }

  /**
   * Ingest one kernel result. `pivot` and the dynamic-collider id set let the
   * tracker tell moving blockers and stationary geometry apart.
   *
   * @param {object} result ThirdPersonCamera.update() result
   * @param {object} ctx
   * @param {Vec3} ctx.pivot this frame's look-at pivot
   * @param {number} ctx.yaw orbit yaw fed to the kernel this frame
   * @param {number} ctx.dt step seconds
   * @param {Set<string>} [ctx.dynamicIds] collider ids that move this frame
   */
  record(result, { pivot, yaw, dt, dynamicIds = null } = {}) {
    const cfg = this.config;
    const step = clamp(Number(dt) || 0, 0, 0.1);
    this.time += step;
    this.frameIndex++;

    const prev = this.frames[this.frames.length - 1] ?? null;
    const key = `${result.yawOffsetDeg},${result.pitchOffsetDeg}`;
    const pivotMoved = prev && pivot
      ? Math.hypot(pivot.x - prev.px, pivot.y - prev.py, pivot.z - prev.pz)
      : 0;
    let yawDelta = 0;
    if (prev && Number.isFinite(yaw)) {
      yawDelta = yaw - prev.yawIn;
      while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
      while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    }
    const legalDelta = prev ? result.legalDistance - prev.legal : 0;
    const rawDelta = prev ? result.sweep.rawContactDistance - prev.raw : 0;
    const appliedDelta = prev ? result.distance - prev.applied : 0;

    if (prev && key !== prev.key) this.keyFlips++;
    if (prev && result.phase !== prev.phase) this.phaseFlips++;
    if (prev && appliedDelta * this._lastAppliedDelta < 0
      && Math.abs(appliedDelta) > 0.002 && Math.abs(this._lastAppliedDelta) > 0.002) {
      this.distanceReversals++;
    }
    if (result.hitId) this.blockedFrameCount++;

    const trace = {
      t: round3(this.time),
      px: round3(pivot?.x), py: round3(pivot?.y), pz: round3(pivot?.z),
      yawIn: round3(Number.isFinite(yaw) ? yaw : (prev?.yawIn ?? 0)),
      req: round3(result.requestedDistance),
      legal: round3(result.legalDistance),
      raw: round3(result.sweep.rawContactDistance),
      applied: round3(result.distance),
      hit: result.hitId ?? null,
      key,
      phase: result.phase,
      yaw: round3(result.appliedYawOffsetDeg),
      vis: round3(result.visibility),
      clamp: result.clampedBySafety ? 1 : 0,
      backoff: result.emergencyBackoffs,
      pivotMoved: round3(pivotMoved),
      yawDelta: round3(yawDelta),
      legalDelta: round3(legalDelta),
      rawDelta: round3(rawDelta),
      dyn: dynamicIds && result.hitId ? (dynamicIds.has(result.hitId) ? 1 : 0) : 0,
    };
    this._pushRing(this.frames, trace, cfg.traceCapacity);

    this._lastKey = key;
    this._lastPhase = result.phase;
    this._lastApplied = result.distance;
    this._lastAppliedDelta = appliedDelta;

    this._updateEpisode(trace, prev);
    this.current = this._snapshotState(trace);
    return this.current;
  }

  _pushRing(buffer, item, capacity) {
    buffer.push(item);
    if (buffer.length > capacity) buffer.shift();
  }

  _updateEpisode(trace, prev) {
    const cfg = this.config;
    const obstructed = trace.hit !== null || trace.applied < trace.req - 0.02;
    const reversing = prev
      && trace.applied !== prev.applied
      && (trace.phase === 'shortening') !== (prev.phase === 'shortening')
      && Math.abs(trace.applied - prev.applied) > 0.002;
    const keyFlipped = prev && trace.key !== prev.key;

    if (!this._episode) {
      if (obstructed) {
        this._episode = {
          startTime: trace.t,
          startFrame: this.frameIndex,
          minApplied: trace.applied,
          maxApplied: trace.applied,
          reversals: reversing ? 1 : 0,
          keyFlips: keyFlipped ? 1 : 0,
          movingHits: trace.dyn ? 1 : 0,
          staticHits: trace.hit && !trace.dyn ? 1 : 0,
          legalChanges: Math.abs(trace.legalDelta),
          rawChanges: Math.abs(trace.rawDelta),
          pivotMoves: trace.pivotMoved,
          yawTravel: Math.abs(trace.yawDelta),
          phases: new Set([trace.phase]),
          hits: new Set(trace.hit ? [trace.hit] : []),
          lastTouch: trace.t,
        };
      }
      return;
    }

    const ep = this._episode;
    if (!obstructed && trace.t - ep.lastTouch > cfg.windowSeconds) {
      this._closeEpisode(ep);
      this._episode = null;
      return;
    }
    if (trace.t - ep.startTime > cfg.windowSeconds * 4) {
      this._closeEpisode(ep);
      this._episode = null;
      return;
    }

    ep.lastTouch = trace.t;
    ep.minApplied = Math.min(ep.minApplied, trace.applied);
    ep.maxApplied = Math.max(ep.maxApplied, trace.applied);
    if (reversing) ep.reversals++;
    if (keyFlipped) ep.keyFlips++;
    if (trace.dyn) ep.movingHits++;
    if (trace.hit && !trace.dyn) ep.staticHits++;
    ep.legalChanges += Math.abs(trace.legalDelta);
    ep.rawChanges += Math.abs(trace.rawDelta);
    ep.pivotMoves += trace.pivotMoved;
    ep.yawTravel += Math.abs(trace.yawDelta);
    ep.phases.add(trace.phase);
    if (trace.hit) ep.hits.add(trace.hit);

    const amplitude = ep.maxApplied - ep.minApplied;
    const span = trace.t - ep.startTime;
    if (!ep.confirmed && span >= cfg.windowSeconds * 0.33 && this._qualifies(ep, amplitude)) {
      ep.confirmed = true;
      ep.reason = this._classify(ep);
      ep.evidence = this._evidence(ep);
      this._pushRing(this.events, this._eventView(ep), cfg.eventCapacity);
    }
    if (ep.confirmed) {
      // Keep the stored event live with the freshest evidence.
      ep.reason = this._classify(ep);
      ep.evidence = this._evidence(ep);
      const idx = this.events.findIndex((e) => e.startFrame === ep.startFrame);
      if (idx >= 0) this.events[idx] = this._eventView(ep);
    }
  }

  /**
   * A push/pull episode needs either a distance excursion with direction
   * changes, alternating candidate keys, or (for the door) the blocker moving
   * through the camera line. The moving-blocker path is explicit so a smooth
   * single open/close sweep still registers as an obstacle event.
   */
  _qualifies(ep, amplitude) {
    if (ep.movingHits >= 6 && amplitude >= this.config.minAmplitude * 0.5) return true;
    return amplitude >= this.config.minAmplitude && (ep.reversals >= 2 || ep.keyFlips >= 2);
  }

  /**
   * Classification priority is deliberate so the tracker cannot false-report:
   * a moving panel outranks static geometry; noise requires a fully stationary
   * input; state-update is the residual when the kernel's own selection /
   * smoothing oscillates despite an explainable query.
   */
  _classify(ep) {
    const cfg = this.config;
    if (ep.movingHits > 0 && ep.movingHits >= ep.staticHits) return JITTER_REASONS.MOVING;
    const pivotStationary = ep.pivotMoves <= cfg.stationaryTolerance;
    const yawStationary = ep.yawTravel <= 2 * DEG;
    const queryStable = ep.legalChanges <= cfg.legalNoiseTolerance
      && ep.rawChanges <= cfg.legalNoiseTolerance * 2;
    // Only a fully stationary input (no pivot AND no orbit change) with a
    // jumping query can be called query noise; orbit-driven contact changes
    // have a real geometric cause and must not be mislabelled.
    if (pivotStationary && yawStationary && !queryStable) return JITTER_REASONS.NOISE;
    if (queryStable && (ep.keyFlips >= 2 || ep.reversals >= 2)) return JITTER_REASONS.STATE;
    // Orbit-driven candidate alternation at a stationary pivot is a kernel
    // state-update behaviour around real geometry.
    if (pivotStationary && (ep.keyFlips >= 2 || ep.reversals >= 2)) return JITTER_REASONS.STATE;
    return JITTER_REASONS.GEOMETRY;
  }

  _evidence(ep) {
    return {
      amplitude: round3(ep.maxApplied - ep.minApplied),
      reversals: ep.reversals,
      keyFlips: ep.keyFlips,
      movingHitFrames: ep.movingHits,
      staticHitFrames: ep.staticHits,
      legalDistanceTravel: round3(ep.legalChanges),
      rawContactTravel: round3(ep.rawChanges),
      pivotTravel: round3(ep.pivotMoves),
      yawTravelDeg: round3(ep.yawTravel / DEG),
      phases: [...ep.phases],
      blockingBoxes: [...ep.hits],
    };
  }

  _eventView(ep) {
    return {
      reason: ep.reason ?? JITTER_REASONS.GEOMETRY,
      label: REASON_LABELS[ep.reason ?? JITTER_REASONS.GEOMETRY],
      startFrame: ep.startFrame,
      startTime: round3(ep.startTime),
      endTime: round3(ep.lastTouch),
      confirmed: !!ep.confirmed,
      evidence: ep.evidence ?? this._evidence(ep),
    };
  }

  _closeEpisode(ep) {
    if (ep.confirmed) {
      const idx = this.events.findIndex((e) => e.startFrame === ep.startFrame);
      const view = this._eventView(ep);
      if (idx >= 0) this.events[idx] = view;
    }
  }

  _snapshotState(trace) {
    const obstructed = trace.hit !== null || trace.applied < trace.req - 0.02;
    let reason = null;
    if (this.events.length > 0) {
      const latest = this.events[this.events.length - 1];
      if (this.time - latest.endTime <= this.config.windowSeconds * 2) reason = latest.reason;
    }
    return {
      frame: this.frameIndex,
      time: trace.t,
      obstructed,
      hitId: trace.hit,
      phase: trace.phase,
      requested: trace.req,
      legal: trace.legal,
      raw: trace.raw,
      applied: trace.applied,
      distanceGap: round3(trace.req - trace.applied),
      candidateKey: trace.key,
      keyFlips: this.keyFlips,
      distanceReversals: this.distanceReversals,
      phaseFlips: this.phaseFlips,
      activeReason: reason,
      activeLabel: reason ? REASON_LABELS[reason] : null,
      jitterActive: reason !== null,
      blockedFrames: this.blockedFrameCount,
      traceDepth: this.frames.length,
      traceCapacity: this.config.traceCapacity,
      eventDepth: this.events.length,
      eventCapacity: this.config.eventCapacity,
    };
  }

  /** Aggregate counters for the HUD; allocation-free once called per frame. */
  summary() {
    const counts = {};
    for (const e of this.events) counts[e.reason] = (counts[e.reason] ?? 0) + 1;
    return {
      frames: this.frameIndex,
      blockedFrames: this.blockedFrameCount,
      keyFlips: this.keyFlips,
      distanceReversals: this.distanceReversals,
      phaseFlips: this.phaseFlips,
      events: this.events.length,
      reasonCounts: counts,
      traceDepth: this.frames.length,
      traceCapacity: this.config.traceCapacity,
      eventDepth: this.events.length,
      eventCapacity: this.config.eventCapacity,
    };
  }
}

/**
 * Compact replay trajectory. Stores one numeric record per frame (plain arrays,
 * no per-frame objects beyond the record) plus collider context, so a replay
 * can re-drive the kernel and compare the reproduced pose against the recorded
 * one. Ring-bounded like the tracker.
 */
export class ReplayTrajectory {
  constructor({ capacity = 2400, dynamicBoxes = [] } = {}) {
    this.capacity = Math.max(30, capacity | 0);
    this.dynamicBoxes = dynamicBoxes.map((b) => ({ id: b.id }));
    this.reset();
  }

  reset() {
    this.records = [];
    this.meta = {
      dt: null,
      fovDeg: null,
      requested0: null,
      pitch0: null,
    };
  }

  /**
   * @param {object} result kernel result
   * @param {object} ctx {pivot, yaw, pitch, dt, doorStates: Map<id, {x,y,z}>}
   */
  recordFrame(result, { pivot, yaw, pitch, dt, doorStates = null }) {
    if (this.meta.dt === null) {
      this.meta.dt = round3(dt);
      this.meta.fovDeg = result.volumeSpec.fovDeg;
      this.meta.requested0 = result.requestedDistance;
      this.meta.pitch0 = round3(pitch);
    }
    const rec = [
      round3(pivot.x), round3(pivot.y), round3(pivot.z),
      round3(yaw), round3(pitch),
      round3(result.requestedDistance),
      round3(result.legalDistance),
      round3(result.sweep.rawContactDistance),
      round3(result.distance),
      round3(result.position.x), round3(result.position.y), round3(result.position.z),
      result.hitId ?? 0,
      result.phase === 'shortening' ? 1 : result.phase === 'recovering' ? 2 : result.phase === 'waiting' ? 3 : 0,
      result.yawOffsetDeg,
    ];
    this.records.push(rec);
    if (this.records.length > this.capacity) this.records.shift();
    if (doorStates) {
      this.doorFrames ??= [];
      // Frame index is 1-based and relative to the live record window.
      const df = [this.records.length];
      for (const [id, s] of doorStates) df.push(id, round3(s.x), round3(s.y), round3(s.z));
      this.doorFrames.push(df);
      if (this.doorFrames.length > this.capacity) this.doorFrames.shift();
    }
  }

  get length() { return this.records.length; }

  toJSON() {
    return {
      version: 1,
      capacity: this.capacity,
      meta: this.meta,
      dynamicBoxes: this.dynamicBoxes,
      doorFrames: this.doorFrames ?? [],
      records: this.records,
    };
  }

  static fromJSON(data) {
    const traj = new ReplayTrajectory({ capacity: data.capacity, dynamicBoxes: data.dynamicBoxes ?? [] });
    traj.meta = data.meta;
    traj.records = data.records;
    traj.doorFrames = data.doorFrames ?? [];
    return traj;
  }

  * [Symbol.iterator]() {
    for (const r of this.records) {
      yield {
        pivot: { x: r[0], y: r[1], z: r[2] },
        yaw: r[3], pitch: r[4],
        requested: r[5], legal: r[6], raw: r[7], applied: r[8],
        position: { x: r[9], y: r[10], z: r[11] },
        hitId: r[12] || null,
        phase: r[13],
        yawOffsetDeg: r[14],
      };
    }
  }
}

/**
 * Re-drive a recorded trajectory through a fresh kernel and compare the
 * reproduced distances/poses against the recorded evidence. Used by the
 * headless diagnostics suite; collision stays fully enabled.
 *
 * @returns {{frames:number, maxDistanceError:number, maxPositionError:number, mismatches:Array}}
 */
export function verifyReplay(kernel, trajectory, colliders, targetSamplesFor, doorApplier = null) {
  kernel.reset();
  let maxDistanceError = 0;
  let maxPositionError = 0;
  const mismatches = [];
  let frames = 0;
  const doorByIndex = new Map();
  for (const df of trajectory.doorFrames ?? []) {
    const idx = df[0];
    const state = new Map();
    for (let i = 1; i < df.length; i += 4) state.set(df[i], { x: df[i + 1], y: df[i + 2], z: df[i + 3] });
    doorByIndex.set(idx, state);
  }

  for (const frame of trajectory) {
    const state = doorByIndex.get(frames + 1);
    if (state && doorApplier) doorApplier(state);
    kernel.setRequestedDistance(frame.requested);
    const pivot = vec(frame.pivot.x, frame.pivot.y, frame.pivot.z);
    const result = kernel.update({
      pivot,
      yaw: frame.yaw,
      pitch: frame.pitch,
      dt: trajectory.meta.dt ?? 1 / 60,
      colliders,
      targetSamples: targetSamplesFor(frame),
    });
    const dErr = Math.abs(result.distance - frame.applied);
    const pErr = Math.hypot(
      result.position.x - frame.position.x,
      result.position.y - frame.position.y,
      result.position.z - frame.position.z,
    );
    maxDistanceError = Math.max(maxDistanceError, dErr);
    maxPositionError = Math.max(maxPositionError, pErr);
    if (dErr > 0.02 || pErr > 0.05) {
      mismatches.push({ frame: frames, distanceError: round3(dErr), positionError: round3(pErr) });
    }
    frames++;
  }
  return { frames, maxDistanceError: round3(maxDistanceError), maxPositionError: round3(maxPositionError), mismatches: mismatches.slice(0, 8) };
}
