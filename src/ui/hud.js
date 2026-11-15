/**
 * DOM HUD. Kept renderer-agnostic so tests can assert on its data attributes.
 * All values come from the camera kernel's result object.
 */
export class Hud {
  constructor(root = document) {
    this.root = root;
    this.el = {
      distanceRequested: root.querySelector('[data-hud="requested"]'),
      distanceLegal: root.querySelector('[data-hud="legal"]'),
      distanceApplied: root.querySelector('[data-hud="applied"]'),
      distanceError: root.querySelector('[data-hud="error"]'),
      directionLabel: root.querySelector('[data-hud="direction"]'),
      yawOffset: root.querySelector('[data-hud="yaw-offset"]'),
      pitchOffset: root.querySelector('[data-hud="pitch-offset"]'),
      visibility: root.querySelector('[data-hud="visibility"]'),
      nearIntrusions: root.querySelector('[data-hud="near"]'),
      status: root.querySelector('[data-hud="status"]'),
      phase: root.querySelector('[data-hud="phase"]'),
      hit: root.querySelector('[data-hud="hit"]'),
      tests: root.querySelector('[data-hud="tests"]'),
      candidates: root.querySelector('[data-hud="candidates"]'),
      hullFree: root.querySelector('[data-hud="hull-free"]'),
      clampBackoff: root.querySelector('[data-hud="clamp-backoff"]'),
      emergency: root.querySelector('[data-hud="emergency"]'),
      requestedSlider: root.querySelector('input[data-control="distance"]'),
      requestedReadout: root.querySelector('[data-hud="slider-distance"]'),
      posActual: root.querySelector('[data-hud="pos-actual"]'),
      posDesired: root.querySelector('[data-hud="pos-desired"]'),
      posLegal: root.querySelector('[data-hud="pos-legal"]'),
      fps: root.querySelector('[data-hud="fps"]'),
      violationCount: root.querySelector('[data-hud="violations"]'),
      scene: root.querySelector('[data-hud="scene"]'),
      mode: root.querySelector('[data-hud="mode"]'),
      centerRay: root.querySelector('[data-hud="center-ray"]'),
      near: root.querySelector('section[data-panel="near"]'),
      diagReason: root.querySelector('[data-hud="diag-reason"]'),
      diagBlocker: root.querySelector('[data-hud="diag-blocker"]'),
      diagAmplitude: root.querySelector('[data-hud="diag-amplitude"]'),
      diagKeyFlips: root.querySelector('[data-hud="diag-keyflips"]'),
      diagReversals: root.querySelector('[data-hud="diag-reversals"]'),
      diagEvents: root.querySelector('[data-hud="diag-events"]'),
      diagTrace: root.querySelector('[data-hud="diag-trace"]'),
      diagRaw: root.querySelector('[data-hud="diag-raw"]'),
      diagPhase: root.querySelector('[data-hud="diag-phase"]'),
      diagBanner: root.querySelector('[data-hud="diag-banner"]'),
      diagBannerText: root.querySelector('[data-hud="diag-banner-text"]'),
    };
    this.stats = {
      frames: 0,
      violations: 0,
      clampBackoffs: 0,
      emergencyBackoffs: 0,
      maxNearIntrusions: 0,
      minVisibility: 1,
    };
    this._lastFpsTime = 0;
    this._framesSinceFps = 0;
    this._fps = 0;
  }

  resetStats() {
    this.stats = {
      frames: 0, violations: 0, clampBackoffs: 0, emergencyBackoffs: 0,
      maxNearIntrusions: 0, minVisibility: 1,
    };
    this._framesSinceFps = 0;
  }

  setSceneInfo(name, mode) {
    if (this.el.scene) this.el.scene.textContent = name;
    if (this.el.mode) this.el.mode.textContent = mode;
  }

  /**
   * Render the obstacle-jitter evidence chain. Every value comes from the
   * tracker's recorded frame/event data — the HUD never infers a reason, so
   * it cannot display a cause the tracker did not observe.
   */
  updateDiagnostics(diag, summary) {
    const { el } = this;
    if (el.diagReason) {
      el.diagReason.textContent = diag.jitterActive ? diag.activeLabel : 'none';
      el.diagReason.className = diag.jitterActive
        ? `hud-status status-diag reason-${diag.activeReason}`
        : 'hud-status';
    }
    if (el.diagBlocker) el.diagBlocker.textContent = diag.hitId ?? '—';
    if (el.diagAmplitude) el.diagAmplitude.textContent = `${(diag.requested - diag.applied).toFixed(2)} m`;
    if (el.diagKeyFlips) el.diagKeyFlips.textContent = String(diag.keyFlips);
    if (el.diagReversals) el.diagReversals.textContent = String(diag.distanceReversals);
    if (el.diagEvents) el.diagEvents.textContent = String(summary.events);
    if (el.diagTrace) {
      el.diagTrace.textContent = `${summary.traceDepth}/${summary.traceCapacity} frames · ${summary.eventDepth}/${summary.eventCapacity} events`;
    }
    if (el.diagRaw) el.diagRaw.textContent = `${diag.raw.toFixed(2)} m`;
    if (el.diagPhase) el.diagPhase.textContent = diag.phase;
    if (el.diagBanner && el.diagBannerText) {
      if (diag.jitterActive) {
        el.diagBanner.hidden = false;
        el.diagBanner.dataset.reason = diag.activeReason;
        el.diagBannerText.textContent =
          `${diag.activeLabel} · blocker ${diag.hitId ?? '—'} · shortfall ${diag.distanceGap.toFixed(2)} m · ${diag.phase}`;
      } else {
        el.diagBanner.hidden = true;
      }
    }
  }

  setSliderReadout(value) {
    if (this.el.requestedReadout) this.el.requestedReadout.textContent = `${value.toFixed(2)} m`;
  }

  update(result, wallMs) {
    const { el } = this;
    const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
    const illegal = !result.legality.hullFree || result.emergencyBackoffs > 0;
    this.stats.frames++;
    if (illegal) this.stats.violations++;
    this.stats.clampBackoffs += result.clampedBySafety ? 1 : 0;
    this.stats.emergencyBackoffs += result.emergencyBackoffs;
    this.stats.maxNearIntrusions = Math.max(this.stats.maxNearIntrusions, result.nearIntrusions);
    this.stats.minVisibility = Math.min(this.stats.minVisibility, result.visibility);

    el.distanceRequested.textContent = `${fmt(result.requestedDistance)} m`;
    el.distanceLegal.textContent = `${fmt(result.legalDistance)} m`;
    el.distanceApplied.textContent = `${fmt(result.distance)} m`;
    const gap = result.requestedDistance - result.distance;
    el.distanceError.textContent = gap > 0.01 ? `−${fmt(gap)} m` : 'none';
    el.distanceError.classList.toggle('bad', gap > 0.01 && result.obstructed);

    el.directionLabel.textContent = result.yawOffsetDeg !== 0
      ? `offset ${result.yawOffsetDeg > 0 ? '+' : ''}${result.yawOffsetDeg}° yaw`
      : 'behind character';
    el.yawOffset.textContent = `${result.appliedYawOffsetDeg >= 0 ? '+' : ''}${result.appliedYawOffsetDeg.toFixed(1)}°`;
    el.pitchOffset.textContent = `${result.appliedPitchOffsetDeg >= 0 ? '+' : ''}${result.appliedPitchOffsetDeg.toFixed(1)}°`;
    el.visibility.textContent = `${(result.visibility * 100).toFixed(0)}%`;
    el.visibility.classList.toggle('bad', result.visibility < 0.5);
    el.nearIntrusions.textContent = String(result.nearIntrusions);
    el.nearIntrusions.classList.toggle('bad', result.nearIntrusions > 0);
    el.status.textContent = result.status;
    el.status.className = `hud-status status-${result.status}`;
    el.phase.textContent = result.phase;
    el.hit.textContent = result.hitId ?? '—';
    el.tests.textContent = String(result.sweep.boxesTested);
    el.candidates.textContent = String(result.sweep.evaluatedCandidates);
    el.hullFree.textContent = result.legality.hullFree ? 'yes' : 'NO';
    el.hullFree.classList.toggle('bad', !result.legality.hullFree);
    el.clampBackoff.textContent = result.clampedBySafety ? 'yes' : 'no';
    el.emergency.textContent = result.emergencyBackoffs > 0 ? `yes (${result.emergencyBackoffs})` : 'no';
    el.emergency.classList.toggle('bad', result.emergencyBackoffs > 0);

    el.posActual.textContent = `(${fmt(result.position.x)}, ${fmt(result.position.y)}, ${fmt(result.position.z)})`;
    el.posDesired.textContent = `(${fmt(result.desiredPosition.x)}, ${fmt(result.desiredPosition.y)}, ${fmt(result.desiredPosition.z)})`;
    el.posLegal.textContent = `(${fmt(result.target.x)}, ${fmt(result.target.y)}, ${fmt(result.target.z)})`;
    el.centerRay.textContent = `centre ray would stop at ${fmt(result.centreRay.distance)} m${result.centreRay.hit ? ` (${result.centreRay.hit})` : ''}`;

    el.violationCount.textContent = String(this.stats.violations);

    this._framesSinceFps++;
    const now = performance.now();
    if (now - this._lastFpsTime > 400) {
      this._fps = Math.round((this._framesSinceFps * 1000) / (now - this._lastFpsTime));
      this._framesSinceFps = 0;
      this._lastFpsTime = now;
    }
    el.fps.textContent = `${this._fps} fps · ${fmt(wallMs, 1)} ms query`;
  }
}
