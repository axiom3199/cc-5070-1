import * as THREE from 'three';
import { ThirdPersonCamera } from './core/thirdPersonCamera.js';
import { CameraVolume, clamp, vec } from './core/collision.js';
import { levelSpec } from './core/levelSpec.js';
import { ObstacleJitterTracker, ReplayTrajectory } from './core/diagnostics.js';
import { DOOR_SPEC, doorStateMap } from './core/dynamicDoor.js';
import { buildInterior, updateDoors } from './scene/level.js';
import { createMaterials, createOverlayMaterials } from './scene/materials.js';
import { Avatar } from './scene/avatar.js';
import { CameraOverlay } from './scene/overlay.js';
import { StageView } from './scene/stage.js';
import { Character, stepCharacter } from './scene/character.js';
import { Hud } from './ui/hud.js';

const DEG = Math.PI / 180;
const FIXED_STEP = 1 / 120;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1014);
scene.fog = new THREE.Fog(0x0d1014, 16, 34);

const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('view'), antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

const BASE_FOV = 62;
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 60);
const materials = createMaterials();
const overlayMats = createOverlayMaterials();
const { colliders, roofs, doors } = buildInterior(scene, materials);
const avatar = new Avatar(scene, materials);
const overlay = new CameraOverlay(scene, overlayMats);
const stage = new StageView({ span: 5.4, margin: 18 });
const stageFrame = document.querySelector('[data-hud="stage-frame"]');

// Observational diagnostics only: the tracker never feeds back into the
// kernel, and the replay buffer is ring-bounded so long sessions stay cheap.
const jitterTracker = new ObstacleJitterTracker();
const replay = new ReplayTrajectory({ capacity: 1800, dynamicBoxes: [{ id: DOOR_SPEC.id }] });
let doorClock = 0;
let doorMotionEnabled = true;
let lastDynamicIds = new Set();

function sizeStage() {
  const rect = stageFrame.getBoundingClientRect();
  stage.setSize(rect.width, rect.height);
  stage.margin = Math.max(8, window.innerHeight - rect.bottom);
}
sizeStage();
stage.attach(scene, roofs);
// The hull wireframe encloses the main camera, so it is hidden for the first-
// person pass and shown only for the overhead pane.
stage.beforeRender = () => overlay.setHullWireframe(true);
stage.afterRender = () => overlay.setHullWireframe(false);
const character = new Character(levelSpec.spawn.position, levelSpec.spawn.yaw);

const hud = new Hud(document);

const kernel = new ThirdPersonCamera({
  fovDeg: BASE_FOV,
  aspect: camera.aspect,
  near: camera.near,
  requestedDistance: 3.4,
});

// ---------------------------------------------------------------------------
// Lighting: warm practicals + a soft directional key for readable geometry.
// ---------------------------------------------------------------------------
const hemi = new THREE.HemisphereLight(0xaec6e8, 0x2b2f36, 0.85);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffe6c0, 2.1);
key.position.set(-5, 9, 6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -12;
key.shadow.camera.right = 12;
key.shadow.camera.top = 12;
key.shadow.camera.bottom = -12;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 30;
key.shadow.bias = -0.0006;
scene.add(key);

const practicals = [
  { pos: [-4, 3.0, 1.6], color: 0xffd9a1, intensity: 7, dist: 7 },
  { pos: [-4, 3.0, -2.8], color: 0xffd9a1, intensity: 6, dist: 7 },
  { pos: [4, 3.0, 1.2], color: 0xffd9a1, intensity: 7, dist: 7 },
  { pos: [0, 2.9, 2.4], color: 0xd9e8ff, intensity: 4, dist: 6 },
  { pos: [0, 2.35, -4.2], color: 0xd9e8ff, intensity: 3, dist: 5 },
];
for (const p of practicals) {
  const light = new THREE.PointLight(p.color, p.intensity, p.dist, 2);
  light.position.set(...p.pos);
  scene.add(light);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set();
const input = { forward: false, back: false, left: false, right: false, sprint: false };
let orbitYaw = character.yaw; // camera orbit yaw; forward = (sin yaw, 0, cos yaw)
let orbitPitch = 15 * DEG;
let cameraYaw = orbitYaw;
let jumpOffset = 0;
let jumpVelocity = 0;
let dragging = false;
let lastPointer = { x: 0, y: 0 };
let autoOrbit = false;
const toastEl = document.querySelector('[data-hud="toast"]');
let toastTimer = 0;

function showToast(message, ms = 2200) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

function updateInputFromKeys() {
  input.forward = keys.has('KeyW') || keys.has('ArrowUp');
  input.back = keys.has('KeyS') || keys.has('ArrowDown');
  input.left = keys.has('KeyA') || keys.has('ArrowLeft');
  input.right = keys.has('KeyD') || keys.has('ArrowRight');
  input.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  updateInputFromKeys();
  if (e.code === 'KeyV') toggleOverlay();
  if (e.code === 'KeyR') resetAll();
  if (e.code === 'KeyH') document.querySelector('[data-panel="help"]').classList.toggle('hidden');
  if (e.code === 'Space') {
    if (jumpOffset <= 0.001) { jumpVelocity = 3.4; }
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  updateInputFromKeys();
});

const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastPointer = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastPointer.x;
  const dy = e.clientY - lastPointer.y;
  lastPointer = { x: e.clientX, y: e.clientY };
  orbitYaw -= dx * 0.0042;
  orbitPitch = clamp(orbitPitch - dy * 0.0035, -22 * DEG, 58 * DEG);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const next = clamp(kernel.config.requestedDistance + e.deltaY * 0.0028, kernel.config.minDistance, kernel.config.maxDistance);
  setRequestedDistance(next);
}, { passive: false });

const slider = document.querySelector('input[data-control="distance"]');
slider.addEventListener('input', () => setRequestedDistance(Number(slider.value)));

function setRequestedDistance(value) {
  const applied = kernel.setRequestedDistance(value);
  slider.value = String(applied);
  hud.setSliderReadout(applied);
}

function toggleOverlay() {
  const next = !overlay.enabled;
  overlay.setEnabled(next);
  stage.setEnabled(next);
  document.querySelector('[data-action="toggle-overlay"]').classList.toggle('active', next);
  document.querySelector('[data-hud="stage-frame"]').classList.toggle('hidden', !next);
  showToast(next ? 'Volume overlay: on' : 'Volume overlay: off');
}

function resetAll() {
  character.reset(levelSpec.spawn.position, levelSpec.spawn.yaw);
  orbitYaw = character.yaw;
  orbitPitch = 15 * DEG;
  cameraYaw = orbitYaw;
  jumpOffset = 0;
  jumpVelocity = 0;
  doorClock = 0;
  doorMotionEnabled = false;
  autoOrbit = false;
  kernel.reset();
  jitterTracker.reset();
  replay.reset();
  updateDoors(doors, doorClock);
  hud.resetStats();
  showToast('Character and stats reset');
}

document.querySelector('[data-action="reset"]').addEventListener('click', resetAll);
document.querySelector('[data-action="toggle-overlay"]').addEventListener('click', toggleOverlay);
document.querySelector('[data-action="toggle-help"]').addEventListener('click', () => {
  document.querySelector('[data-panel="help"]').classList.toggle('hidden');
});

// ---------------------------------------------------------------------------
// Scene presets: place the character so the named case is immediate.
// ---------------------------------------------------------------------------
const presets = {
  start: { pos: [-3.4, 0, 2.0], yaw: 0.62 * Math.PI, viewYaw: 0.62 * Math.PI, pitch: 15 * DEG, distance: 3.4, label: 'Start room' },
  corridor: { pos: [0, 0, 2.6], yaw: Math.PI, viewYaw: Math.PI, pitch: 15 * DEG, distance: 4.4, label: 'Narrow corridor' },
  low: { pos: [0, 0, -4.3], yaw: Math.PI, viewYaw: Math.PI, pitch: 24 * DEG, distance: 3.4, label: 'Low ceiling' },
  // Standing with the back to the divider, so the only legal wide view is
  // laterally down the corridor.
  corner: { pos: [-0.5, 0, 0.0], yaw: Math.PI / 2, viewYaw: Math.PI / 2, pitch: 18 * DEG, distance: 4.8, label: 'Wall-hug turn' },
  // Standing just past the column with the camera's ideal stand-off on the
  // other side of it, so "straight behind" is genuinely blocked and the fan
  // has to swing around the column.
  column: { pos: [3.7, 0, -3.45], yaw: Math.PI, viewYaw: Math.PI, pitch: 16 * DEG, distance: 4.2, label: 'Column occlusion' },
  // Stationary character inside the L-shaped corner props: a slow orbit makes
  // the candidate fan alternate against static geometry (state-update case).
  jitter: { pos: [4.5, 0, -5.6], yaw: Math.PI, viewYaw: Math.PI, pitch: 16 * DEG, distance: 4.2, label: 'Jitter corner', autoOrbit: true },
  // Stationary character on the sliding door's stand-off line. The panel
  // crosses the camera sweep on its own clock (moving-blocker case).
  door: { pos: [5.3, 0, -0.8], yaw: 0, viewYaw: 0, pitch: 14 * DEG, distance: 4.2, label: 'Moving door panel', doorMotion: true },
};

function applyPreset(name) {
  const p = presets[name];
  if (!p) return;
  character.reset(vec(...p.pos), p.yaw);
  orbitYaw = p.viewYaw ?? p.yaw;
  orbitPitch = p.pitch;
  cameraYaw = orbitYaw;
  jumpOffset = 0;
  jumpVelocity = 0;
  autoOrbit = !!p.autoOrbit;
  doorMotionEnabled = !!p.doorMotion;
  doorClock = 0;
  updateDoors(doors, doorClock);
  // Set the requested distance BEFORE resetting, otherwise the reset seeds the
  // smoothed distance from the previous scene's value and the new scene opens
  // mid-zoom.
  kernel.setRequestedDistance(p.distance);
  setRequestedDistance(p.distance);
  kernel.reset();
  jitterTracker.reset();
  replay.reset();
  hud.resetStats();
  document.querySelectorAll('[data-scene]').forEach((b) => b.classList.toggle('active', b.dataset.scene === name));
  hud.setSceneInfo(p.label, 'interactive');
  showToast(`Scene: ${p.label}`);
  // A couple of warm-up frames let the direction search settle; the distance
  // is then pinned to the settled value so the scene opens already framed.
  for (let i = 0; i < 2; i++) stepKernel(1 / 60);
  if (lastResult) kernel.smoothedDistance = lastResult.distance;
  stepKernel(1 / 60);
  if (lastResult) stage.snap(lastResult.target, lastResult.position);
  return lastResult;
}

document.querySelectorAll('[data-scene]').forEach((btn) => {
  btn.addEventListener('click', () => applyPreset(btn.dataset.scene));
});

// ---------------------------------------------------------------------------
// Camera stepping
// ---------------------------------------------------------------------------
let lastResult = null;

const SHOULDER = 0.5;

function syncCamera(result) {
  // Standard over-the-shoulder framing: shift the look-at point sideways so the
  // character sits off-centre instead of blocking the view. The shift is small
  // and the camera orientation is unchanged in pitch, so the volume query stays
  // authoritative; the shoulder offset is re-verified below before use.
  const forward = vec(Math.sin(orbitYaw), 0, Math.cos(orbitYaw));
  const right = vec(-Math.cos(orbitYaw), 0, Math.sin(orbitYaw));
  const shoulder = right.clone().mul(SHOULDER);
  const target = result.target.clone().add(shoulder);
  const shiftedHit = kernel.volume.intersects(colliders, result.position, target);
  const useShoulder = !shiftedHit;
  const lookTarget = useShoulder ? target : result.target;

  camera.position.set(result.position.x, result.position.y, result.position.z);
  camera.lookAt(lookTarget.x, lookTarget.y, lookTarget.z);
  camera.fov = kernel.config.fovDeg;
  camera.updateProjectionMatrix();
  overlay.update({
    ...result,
    target: lookTarget,
    volume: kernel.volume,
    colliders,
    visibilityColliders: colliders,
  });
}

function stepKernel(dt) {
  // Camera-relative movement uses the current orbit yaw, but the kernel's
  // outward direction is "behind the character", matching the actor facing.
  updateInputFromKeys();
  const actorYaw = stepCharacter(character, input, cameraYaw, dt, colliders);

  // The camera orbit yaw follows the mouse; when the player does not orbit,
  // it eases toward the actor's facing so "behind the character" is stable.
  // The jitter-corner preset drives a slow automatic orbit to make the
  // candidate fan alternate against static geometry.
  if (autoOrbit && !dragging) orbitYaw += dt * 0.9;
  if (!dragging && !autoOrbit) {
    let delta = actorYaw - orbitYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    orbitYaw += delta * (1 - Math.exp(-dt / 0.35));
  }
  cameraYaw = orbitYaw;

  // Advance the sliding door on its deterministic clock. Collision stays
  // fully enabled: the panel's AABB moves with the mesh in the same list.
  if (doorMotionEnabled) {
    doorClock += dt;
    lastDynamicIds = updateDoors(doors, doorClock);
  } else {
    lastDynamicIds = new Set();
  }

  // Jump is a cosmetic vertical offset on the avatar only; the camera pivot
  // follows it partially so the framing stays stable indoors.
  if (jumpVelocity !== 0 || jumpOffset > 0) {
    jumpOffset = Math.max(0, jumpOffset + jumpVelocity * dt);
    jumpVelocity -= 9.8 * dt;
    if (jumpOffset <= 0) { jumpOffset = 0; jumpVelocity = 0; }
  }

  const pos = character.position.clone().add(vec(0, jumpOffset, 0));
  avatar.setPose(pos, actorYaw);

  const pivot = character.pivot.clone().add(vec(0, jumpOffset * 0.55, 0));
  const targetSamples = [
    character.headPoint().add(vec(0, jumpOffset * 0.7, 0)),
    character.chestPoint().add(vec(0, jumpOffset * 0.7, 0)),
    character.hipPoint().add(vec(0, jumpOffset * 0.7, 0)),
  ];

  const before = performance.now();
  const result = kernel.update({
    pivot,
    yaw: orbitYaw,
    pitch: orbitPitch,
    dt,
    colliders,
    targetSamples,
  });
  const queryMs = performance.now() - before;

  // Observational evidence chain: candidate key, legal/raw/applied distance,
  // blocking box and phase are recorded every fixed step. Nothing here feeds
  // back into the kernel — collision and smoothing run untouched.
  const diag = jitterTracker.record(result, { pivot, yaw: orbitYaw, dt, dynamicIds: lastDynamicIds });
  replay.recordFrame(result, {
    pivot,
    yaw: orbitYaw,
    pitch: orbitPitch,
    dt,
    doorStates: doorMotionEnabled ? doorStateMap(doorClock) : null,
  });

  syncCamera(result);
  hud.update(result, queryMs);
  hud.updateDiagnostics(diag, jitterTracker.summary());

  if (hud.el['bar-fill']) {
    hud.el['bar-fill'].style.width = `${(result.distance / kernel.config.maxDistance) * 100}%`;
  }
  if (hud.el['bar-legal']) {
    hud.el['bar-legal'].style.left = `${(result.legalDistance / kernel.config.maxDistance) * 100}%`;
  }
  if (hud.el['bar-fill']) hud.el['bar-fill'].classList.toggle('obstructed', result.obstructed);
  if (hud.el.mode) hud.el.mode.textContent = kernel.config.requestedDistance ? 'interactive' : '—';

  lastResult = result;
  return result;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
let previous = performance.now();
let accumulator = 0;
let frame = 0;
function tick(now) {
  const dtReal = Math.min(0.05, (now - previous) / 1000);
  previous = now;
  accumulator += dtReal;
  while (accumulator >= FIXED_STEP) {
    stepKernel(FIXED_STEP);
    accumulator -= FIXED_STEP;
  }
  overlay.setHullWireframe(false);
  renderer.render(scene, camera);
  if (lastResult) {
    stage.follow(lastResult.target, lastResult.position, dtReal);
    stage.render(renderer);
  }
  frame++;
  requestAnimationFrame(tick);
}

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  sizeStage();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  kernel.setLens({ aspect: camera.aspect });
});

// ---------------------------------------------------------------------------
// Public test / inspection hook
// ---------------------------------------------------------------------------
window.__roomCamera = {
  kernel,
  character,
  camera,
  colliders,
  stage,
  overlay,
  presets,
  applyPreset,
  setRequestedDistance,
  jitterTracker,
  get replayJSON() { return JSON.stringify(replay.toJSON()); },
  get lastDiagnostics() { return jitterTracker.current; },
  get doorClock() { return doorClock; },
  get doors() { return doors; },
  get lastResult() { return lastResult; },
  step(dt = 1 / 60, n = 1) {
    for (let i = 0; i < n; i++) stepKernel(dt);
    return lastResult;
  },
  snapshot() {
    if (!lastResult) return null;
    return {
      position: lastResult.position.toArray(),
      target: lastResult.target.toArray(),
      distance: lastResult.distance,
      legalDistance: lastResult.legalDistance,
      requested: lastResult.requestedDistance,
      status: lastResult.status,
      visibility: lastResult.visibility,
      nearIntrusions: lastResult.nearIntrusions,
      hullFree: lastResult.legality.hullFree,
      yawOffsetDeg: lastResult.yawOffsetDeg,
      phase: lastResult.phase,
      centreRay: lastResult.centreRay,
      frames: hud.stats.frames,
      violations: hud.stats.violations,
      maxNearIntrusions: hud.stats.maxNearIntrusions,
      minVisibility: hud.stats.minVisibility,
      diagnostics: jitterTracker.current,
      diagnosticsSummary: jitterTracker.summary(),
    };
  },
};

// Opening view: default start-room preset, then run.
applyPreset('start');
requestAnimationFrame(tick);
