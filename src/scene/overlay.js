import * as THREE from 'three';
import { CONVEX_HULL_EDGES } from '../core/collision.js';

/**
 * Draws the real camera volume at the applied pose, the desired pose, the
 * near-clip rectangle, the volume-sweep probe samples and the sight line
 * samples. This is what makes "query result vs actual camera volume" directly
 * comparable in the UI.
 */
export class CameraOverlay {
  constructor(scene, mats) {
    this.scene = scene;
    this.mats = mats;
    this.enabled = true;
    this.group = new THREE.Group();
    this.group.name = 'camera-overlay';
    this.group.renderOrder = 10;
    scene.add(this.group);

    this.hullLine = new THREE.LineSegments(new THREE.BufferGeometry(), mats.hull);
    this.desiredLine = new THREE.LineSegments(new THREE.BufferGeometry(), mats.desired);
    this.nearLine = new THREE.LineLoop(new THREE.BufferGeometry(), mats.near);
    this.desiredPivotLine = new THREE.Line(new THREE.BufferGeometry(), mats.desired);
    this.sightLine = new THREE.Line(new THREE.BufferGeometry(), mats.sight);
    this.probeGroup = new THREE.Group();
    this.desiredMarker = new THREE.Mesh(new THREE.OctahedronGeometry(0.075), mats.desiredFill);
    // Camera glyph (visible from the overhead pane): a cone pointing along the
    // applied view direction, so the actuated pose reads at a glance.
    this.cameraMarker = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.22, 4), mats.near);

    for (const obj of [this.hullLine, this.desiredLine, this.nearLine, this.desiredPivotLine, this.sightLine, this.probeGroup, this.desiredMarker, this.cameraMarker]) {
      obj.frustumCulled = false;
      this.group.add(obj);
    }

    this.probeMeshes = [];
    const probeGeom = new THREE.BoxGeometry(0.07, 0.07, 0.07);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(probeGeom, mats.probeFree);
      m.visible = false;
      m.frustumCulled = false;
      this.probeGroup.add(m);
      this.probeMeshes.push(m);
    }

    this.visibilityPoints = [];
    const sightGeom = new THREE.SphereGeometry(0.024, 6, 4);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(sightGeom, mats.sight);
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.visibilityPoints.push(m);
    }
  }

  setEnabled(v) {
    this.enabled = v;
    this.group.visible = v;
  }

  /**
   * The hull wireframe encloses the main camera, so around the viewport it
   * reads as a huge box; the hull, near-plane rectangle, camera glyph and sweep
   * probes are therefore drawn only in the overhead pane.
   */
  setHullWireframe(v) {
    this.hullLine.visible = v;
    this.nearLine.visible = v;
    this.cameraMarker.visible = v;
    this.probeGroup.visible = v;
  }

  update(result) {
    if (!result || !this.enabled) return;
    const hull = result.hull;
    this._edges(this.hullLine, hull, CONVEX_HULL_EDGES);
    this.hullLine.material = result.legality.hullFree ? this.mats.hull : this.mats.hullBad;

    const near = result.nearCorners;
    const nearPositions = new Float32Array(12);
    near.forEach((p, i) => { nearPositions.set([p.x, p.y, p.z], i * 3); });
    const nearGeom = new THREE.BufferGeometry();
    nearGeom.setAttribute('position', new THREE.BufferAttribute(nearPositions, 3));
    this.nearLine.geometry.dispose();
    this.nearLine.geometry = nearGeom;

    const desired = result.desiredPosition;
    // A short line marking desired position to actual position, so the
    // difference is readable without relying on labels.
    const actual = result.position;
    const desiredLinePositions = new Float32Array([
      desired.x, desired.y, desired.z, actual.x, actual.y, actual.z,
    ]);
    this.desiredPivotLine.geometry.dispose();
    const dl = new THREE.BufferGeometry();
    dl.setAttribute('position', new THREE.BufferAttribute(desiredLinePositions, 3));
    this.desiredPivotLine.geometry = dl;
    this.desiredMarker.position.set(desired.x, desired.y, desired.z);
    this.desiredMarker.visible = desired.clone().sub(actual).length() > 0.05;

    // Glyph at the actuated camera, aimed along its view direction.
    if (this.cameraMarker) {
      const view = result.target.clone().sub(actual);
      if (view.lengthSq() > 1e-8) {
        this.cameraMarker.position.set(actual.x, actual.y, actual.z);
        this.cameraMarker.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          view.normalize(),
        );
      }
    }

    // Volume-sweep samples reconstructed along the ACTUAL sweep axis (pivot ->
    // camera), so the markers read as "how far the volume could travel". Each
    // sample is a full camera volume tested with the real hull query.
    const probeCount = 10;
    const actualVec = actual.clone().sub(result.target);
    const sweepLen = Math.max(0.2, Math.max(result.requestedDistance, actualVec.length()));
    const sweepDir = actualVec.lengthSq() > 1e-8
      ? actualVec.clone().normalize()
      : result.appliedDirection;
    for (let i = 0; i < this.probeMeshes.length; i++) {
      const mesh = this.probeMeshes[i];
      if (i >= probeCount) { mesh.visible = false; continue; }
      const t = i / (probeCount - 1);
      const d = 0.15 + (sweepLen - 0.15) * t;
      const samplePos = result.target.clone().add(sweepDir.clone().mul(d));
      const tooClose = samplePos.clone().sub(actual).lengthSq() < 0.8 * 0.8;
      const hit = result.volume ? result.volume.intersects(result.colliders, samplePos, result.target) : null;
      mesh.visible = !tooClose;
      mesh.position.set(samplePos.x, samplePos.y, samplePos.z);
      mesh.material = hit ? this.mats.probeBlocked : this.mats.probeFree;
    }
    this.group.userData.probeCount = probeCount;

    // Sight samples from camera to character.
    const samples = result.targetSamples ?? [];
    const sightPositions = [];
    let visibleCount = 0;
    for (let i = 0; i < this.visibilityPoints.length; i++) {
      const mesh = this.visibilityPoints[i];
      const sample = samples[i];
      if (!sample) { mesh.visible = false; continue; }
      mesh.visible = true;
      mesh.position.set(sample.x, sample.y, sample.z);
      const visible = result.visibility === 1 || this._segmentVisible(result.position, sample, result.visibilityColliders ?? []);
      // Visibility is authoritative in the kernel; overlay only mirrors colour.
      mesh.material = this.mats.sight;
      mesh.scale.setScalar(1);
      if (visible) visibleCount++;
      sightPositions.push(actual.x, actual.y, actual.z, sample.x, sample.y, sample.z);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sightPositions), 3));
    this.sightLine.geometry.dispose();
    this.sightLine.geometry = sg;
    this.sightLine.visible = sightPositions.length > 0;
  }

  _edges(target, points, edges) {
    const positions = [];
    for (const [a, b] of edges) {
      positions.push(points[a].x, points[a].y, points[a].z, points[b].x, points[b].y, points[b].z);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    target.geometry.dispose();
    target.geometry = geom;
  }


  _segmentVisible(a, b, colliders) {
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-8) return true;
    for (const box of colliders) {
      const inv = { x: 1 / (dir.x || 1e-12), y: 1 / (dir.y || 1e-12), z: 1 / (dir.z || 1e-12) };
      let tmin = 0, tmax = 1;
      for (const ax of ['x', 'y', 'z']) {
        let t1 = (box.min[ax] - a[ax]) * inv[ax];
        let t2 = (box.max[ax] - a[ax]) * inv[ax];
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) { tmin = 1; break; }
      }
      if (tmin <= 1) return false;
    }
    return true;
  }
}
