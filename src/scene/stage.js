import * as THREE from 'three';

/**
 * Overhead inspection view ("stage") rendered as a picture-in-picture. It uses
 * a second orthographic camera looking straight down at the character so the
 * camera hull, the sweep probes, the wall boxes and the character are visible
 * together.
 *
 * This is the "query vs. actual camera volume" comparison surface: what the HUD
 * reports numerically is literally drawn here, from the same collision boxes.
 */
export class StageView {
  constructor({ width = 300, height = 240, span = 5.2, margin = 18 } = {}) {
    this.cssWidth = width;
    this.cssHeight = height;
    this.span = span;
    this.margin = margin;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
    this.camera.up.set(0, 0, -1);
    this.enabled = true;
    this.scene = null;
    this.roofs = [];
    this.focus = { x: 0, y: 0, z: 0 };
    this._hiddenRoofs = [];
  }

  attach(scene, roofs) {
    this.scene = scene;
    this.roofs = roofs ?? [];
    this._hiddenRoofs = [];
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v) this._restoreRoofs();
  }

  setSize(width, height) {
    this.cssWidth = width;
    this.cssHeight = height;
  }

  setSpan(span) {
    this.span = span;
  }

  /**
   * Frame both the look-at pivot and the actuated camera position so the hull
   * and the character are always inside the overhead view. Eased so the pane
   * does not breathe frame to frame.
   */
  follow(target, cameraPosition, dt = 1 / 60) {
    const desiredFocus = {
      x: (target.x + cameraPosition.x) / 2,
      z: (target.z + cameraPosition.z) / 2,
    };
    const dx = cameraPosition.x - target.x;
    const dz = cameraPosition.z - target.z;
    const reach = Math.hypot(dx, dz);
    const aspect = this.cssWidth / this.cssHeight;
    // Fit the pivot-to-camera span plus a little context; honour the pane's
    // aspect so horizontal reach is not clipped.
    const desiredSpan = Math.max(4.2, (reach + 2.2) / Math.min(1, aspect) * 0.92);

    const k = 1 - Math.exp(-dt / 0.28);
    this.focus.x += (desiredFocus.x - this.focus.x) * k;
    this.focus.z += (desiredFocus.z - this.focus.z) * k;
    this.span += (desiredSpan - this.span) * k;
  }

  /** Hard-cut the pane when the character is teleported between presets. */
  snap(target, cameraPosition, span) {
    this.focus.x = (target.x + cameraPosition.x) / 2;
    this.focus.z = (target.z + cameraPosition.z) / 2;
    if (span !== undefined) this.span = span;
  }

  _hideRoofs() {
    this._hiddenRoofs = [];
    for (const roof of this.roofs) {
      if (roof.visible) {
        roof.visible = false;
        this._hiddenRoofs.push(roof);
      }
    }
  }

  _restoreRoofs() {
    for (const roof of this._hiddenRoofs) roof.visible = true;
    this._hiddenRoofs = [];
  }

  /**
   * Draw the overhead view into the bottom-centre of the canvas as a scissored
   * viewport. three.js scales viewport/scissor arguments by the pixel ratio
   * itself, so everything here is in CSS pixels and the full-canvas restore
   * passes the CSS size, not device pixels.
   */
  render(renderer) {
    if (!this.enabled || !this.scene) return;

    const w = Math.round(this.cssWidth);
    const h = Math.round(this.cssHeight);
    const canvasW = renderer.domElement.clientWidth || renderer.domElement.width;
    const canvasH = renderer.domElement.clientHeight || renderer.domElement.height;
    if (canvasW < w + 40 || canvasH < h + 40) return;

    const x = Math.round((canvasW - w) / 2);
    const y = Math.round(this.margin);

    const aspect = this.cssWidth / this.cssHeight;
    const halfH = this.span / 2;
    const halfW = halfH * aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.position.set(this.focus.x, 20, this.focus.z);
    this.camera.lookAt(this.focus.x, 0, this.focus.z);
    this.camera.updateProjectionMatrix();

    const hadAutoClear = renderer.autoClear;
    const hadFog = this.scene.fog;
    const hadExposure = renderer.toneMappingExposure;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    // Looking down from 20 m puts the floor past the main scene's fog range,
    // which would wash the pane out; the scene fog is suspended for this pass.
    this.scene.fog = null;
    renderer.toneMappingExposure = Math.max(hadExposure, 2.2);
    this._hideRoofs();
    this.beforeRender?.();
    renderer.render(this.scene, this.camera);
    this.afterRender?.();
    this._restoreRoofs();
    this.scene.fog = hadFog;
    renderer.toneMappingExposure = hadExposure;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, canvasW, canvasH);
    renderer.autoClear = hadAutoClear;
  }
}
