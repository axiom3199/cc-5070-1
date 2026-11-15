import * as THREE from 'three';

/**
 * Character avatar: a readable capsule-ish figure with a clear forward marker.
 * The avatar's transform is driven by the Character controller; the camera is
 * never parented to it, so a failure of the camera kernel cannot be hidden by
 * the avatar's bones.
 */
export class Avatar {
  constructor(scene, materials) {
    this.group = new THREE.Group();
    this.group.name = 'avatar';
    scene.add(this.group);

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.82, 6, 14), materials.cloth);
    body.position.y = 0.82;
    body.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 16), materials.skin);
    head.position.y = 1.5;
    head.castShadow = true;
    this.group.add(head);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.16, 10), materials.accent);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 1.5, 0.2);
    this.group.add(nose);

    // Feet help read movement direction from above.
    for (const side of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.3), materials.accent);
      foot.position.set(0.13 * side, 0.045, 0.06);
      foot.castShadow = true;
      this.group.add(foot);
    }

    // A subtle facing arrow on the floor, independent of the skeleton.
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.11, 0.3, 3),
      new THREE.MeshBasicMaterial({ color: 0xffce6a, transparent: true, opacity: 0.75 }),
    );
    arrow.rotation.x = Math.PI / 2;
    arrow.position.set(0, 0.02, 0.62);
    this.group.add(arrow);

    this.facing = new THREE.Object3D();
    this.group.add(this.facing);
  }

  setPose(position, yaw) {
    this.group.position.set(position.x, position.y, position.z);
    // Character forward is local +Z; yaw 0 faces +Z. Camera yaw uses the
    // convention forward = (sin yaw, 0, cos yaw), which matches directly.
    this.group.rotation.y = yaw;
  }
}
