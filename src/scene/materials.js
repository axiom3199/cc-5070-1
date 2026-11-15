import * as THREE from 'three';

export function createMaterials() {
  return {
    wall: new THREE.MeshStandardMaterial({ color: 0x8b8f98, roughness: 0.86, metalness: 0.02 }),
    floor: new THREE.MeshStandardMaterial({ color: 0x3c4048, roughness: 0.92, metalness: 0.0 }),
    ceiling: new THREE.MeshStandardMaterial({ color: 0x6d727c, roughness: 0.95, metalness: 0.0 }),
    prop: new THREE.MeshStandardMaterial({ color: 0x5c6672, roughness: 0.65, metalness: 0.05 }),
    trim: new THREE.MeshBasicMaterial({ color: 0x2a2e34 }),
    edge: new THREE.LineBasicMaterial({ color: 0x23272d, transparent: true, opacity: 0.55 }),
    lamp: new THREE.MeshStandardMaterial({
      color: 0xfff3d6, emissive: 0xffe6ae, emissiveIntensity: 1.7, roughness: 0.4,
    }),
    skin: new THREE.MeshStandardMaterial({ color: 0xd8a17a, roughness: 0.7 }),
    cloth: new THREE.MeshStandardMaterial({ color: 0x3d6f8e, roughness: 0.8 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xe0a34c, roughness: 0.5, emissive: 0x5a3a10, emissiveIntensity: 0.6 }),
  };
}

export function createOverlayMaterials() {
  return {
    desired: new THREE.LineBasicMaterial({ color: 0xffb545, transparent: true, opacity: 0.95 }),
    desiredFill: new THREE.MeshBasicMaterial({ color: 0xffb545, wireframe: true, transparent: true, opacity: 0.5 }),
    hull: new THREE.LineBasicMaterial({ color: 0x5ee0a8, transparent: true, opacity: 0.9 }),
    hullBad: new THREE.LineBasicMaterial({ color: 0xff5470, transparent: true, opacity: 0.95 }),
    near: new THREE.LineBasicMaterial({ color: 0x5bc8ff, transparent: true, opacity: 0.95 }),
    probeFree: new THREE.MeshBasicMaterial({ color: 0x6ef2a8 }),
    probeBlocked: new THREE.MeshBasicMaterial({ color: 0xff5470 }),
    sight: new THREE.LineBasicMaterial({ color: 0xf2e27a, transparent: true, opacity: 0.42 }),
    hit: new THREE.MeshBasicMaterial({ color: 0xff5470, wireframe: true }),
    volumeFill: new THREE.MeshBasicMaterial({
      color: 0x5ee0a8, transparent: true, opacity: 0.05, side: THREE.BackSide,
      depthWrite: false,
    }),
  };
}
