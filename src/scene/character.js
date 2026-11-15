import { clamp, vec } from '../core/collision.js';

const DEG = Math.PI / 180;

/**
 * Simple capsule-ish character mover on the XZ plane. The character is the
 * controlled actor, not the camera: movement is camera-relative so WASD always
 * feels natural, and the actor's facing yaw drives the camera's ideal pose.
 */
export class Character {
  constructor(position, yaw) {
    this.position = position.clone();
    this.yaw = yaw;
    this.radius = 0.3;
    this.height = 1.7;
    this.speed = 3.1;
    this.sprintSpeed = 5.4;
    this.turnRate = 12;
    this.velocity = vec(0, 0, 0);
    this.moving = false;
  }

  reset(position, yaw) {
    this.position = position.clone();
    this.yaw = yaw ?? this.yaw;
    this.velocity = vec(0, 0, 0);
    this.moving = false;
  }

  /** Pivot (look-at) point: upper chest / neck. */
  get pivot() {
    return this.position.clone().add(vec(0, 1.45, 0));
  }

  headPoint() { return this.position.clone().add(vec(0, 1.58, 0)); }
  chestPoint() { return this.position.clone().add(vec(0, 1.25, 0)); }
  hipPoint() { return this.position.clone().add(vec(0, 0.9, 0)); }

  /** Resolves the character's circular footprint against world AABBs. */
  resolve(colliders) {
    for (const box of colliders) {
      if (box.kind === 'floor' || box.kind === 'ceiling') continue;
      const minX = box.min.x - this.radius;
      const maxX = box.max.x + this.radius;
      const minZ = box.min.z - this.radius;
      const maxZ = box.max.z + this.radius;
      if (this.position.y + 0.1 > box.max.y || this.position.y + this.height < box.min.y) continue;
      if (this.position.x < minX || this.position.x > maxX || this.position.z < minZ || this.position.z > maxZ) continue;
      // Push out along the smallest penetration axis.
      const pushW = this.position.x - minX;
      const pushE = maxX - this.position.x;
      const pushN = this.position.z - minZ;
      const pushS = maxZ - this.position.z;
      const m = Math.min(pushW, pushE, pushN, pushS);
      if (m === pushW) this.position.x = minX;
      else if (m === pushE) this.position.x = maxX;
      else if (m === pushN) this.position.z = minZ;
      else this.position.z = maxZ;
    }
  }
}

/**
 * Converts WASD input + orbit yaw into movement and actor facing.
 * Returns the actor's yaw, which the camera uses.
 */
export function stepCharacter(character, input, cameraYaw, dt, colliders) {
  // Camera looks along (sin yaw, 0, cos yaw); screen-right is cross(forward, up).
  const forward = vec(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
  const right = vec(-Math.cos(cameraYaw), 0, Math.sin(cameraYaw));
  let moveX = 0;
  let moveZ = 0;
  if (input.forward) { moveX += forward.x; moveZ += forward.z; }
  if (input.back) { moveX -= forward.x; moveZ -= forward.z; }
  if (input.right) { moveX += right.x; moveZ += right.z; }
  if (input.left) { moveX -= right.x; moveZ -= right.z; }
  const len = Math.hypot(moveX, moveZ);
  character.moving = len > 1e-4;
  if (!character.moving) {
    character.velocity = vec(0, 0, 0);
    return character.yaw;
  }
  moveX /= len;
  moveZ /= len;
  // +Z is "toward the camera", so the actor's forward yaw faces -Z when the
  // camera is behind: yaw = atan2(moveX, moveZ). (Character forward is +Z local.)
  const targetYaw = Math.atan2(moveX, moveZ);
  let delta = targetYaw - character.yaw;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const turn = clamp(delta, -character.turnRate * dt, character.turnRate * dt);
  character.yaw += turn;

  const speed = input.sprint ? character.sprintSpeed : character.speed;
  character.velocity = vec(moveX * speed, 0, moveZ * speed);
  character.position.x += character.velocity.x * dt;
  character.position.z += character.velocity.z * dt;
  character.resolve(colliders);

  const b = { minX: -6.6, maxX: 6.6, minZ: -7.6, maxZ: 4.6 };
  character.position.x = clamp(character.position.x, b.minX, b.maxX);
  character.position.z = clamp(character.position.z, b.minZ, b.maxZ);
  return character.yaw;
}
