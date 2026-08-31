import { ActorComponent } from '../ActorComponent.mjs';

export const TRANSFORM_COMPONENT = 'transform';

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeAngle(value) {
  let angle = finiteOr(value);
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

export class TransformComponent extends ActorComponent {
  constructor(definition = {}) {
    super(TRANSFORM_COMPONENT);
    const source = definition.localTransform ?? definition;
    const position = Array.isArray(source.position) ? source.position : [];
    this.localX = finiteOr(position[0]);
    this.localY = finiteOr(position[1]);
    this.localZ = finiteOr(position[2]);
    this.localYaw = normalizeAngle(source.yaw);
    this.x = this.localX;
    this.y = this.localY;
    this.z = this.localZ;
    this.yaw = this.localYaw;
  }

  setLocalTransform(position, yaw = this.localYaw) {
    this.localX = finiteOr(position?.[0], this.localX);
    this.localY = finiteOr(position?.[1], this.localY);
    this.localZ = finiteOr(position?.[2], this.localZ);
    this.localYaw = normalizeAngle(yaw);
    this.updateWorldFromParent(this.actor?.parent?.getComponent(TRANSFORM_COMPONENT));
  }

  setWorldTransform(position, yaw = this.yaw) {
    this.x = finiteOr(position?.[0], this.x);
    this.y = finiteOr(position?.[1], this.y);
    this.z = finiteOr(position?.[2], this.z);
    this.yaw = normalizeAngle(yaw);
    this.updateLocalFromParent(this.actor?.parent?.getComponent(TRANSFORM_COMPONENT));
  }

  updateWorldFromParent(parentTransform) {
    if (!parentTransform) {
      this.x = this.localX;
      this.y = this.localY;
      this.z = this.localZ;
      this.yaw = this.localYaw;
      return;
    }
    const sinYaw = Math.sin(parentTransform.yaw);
    const cosYaw = Math.cos(parentTransform.yaw);
    this.x = parentTransform.x + cosYaw * this.localX + sinYaw * this.localZ;
    this.y = parentTransform.y + this.localY;
    this.z = parentTransform.z - sinYaw * this.localX + cosYaw * this.localZ;
    this.yaw = normalizeAngle(parentTransform.yaw + this.localYaw);
  }

  updateLocalFromParent(parentTransform) {
    if (!parentTransform) {
      this.localX = this.x;
      this.localY = this.y;
      this.localZ = this.z;
      this.localYaw = this.yaw;
      return;
    }
    const deltaX = this.x - parentTransform.x;
    const deltaZ = this.z - parentTransform.z;
    const sinYaw = Math.sin(parentTransform.yaw);
    const cosYaw = Math.cos(parentTransform.yaw);
    this.localX = cosYaw * deltaX - sinYaw * deltaZ;
    this.localY = this.y - parentTransform.y;
    this.localZ = sinYaw * deltaX + cosYaw * deltaZ;
    this.localYaw = normalizeAngle(this.yaw - parentTransform.yaw);
  }

  applySnapshot(snapshot, localSnapshot) {
    this.x = finiteOr(snapshot?.x, this.x);
    this.y = finiteOr(snapshot?.y, this.y);
    this.z = finiteOr(snapshot?.z, this.z);
    this.yaw = normalizeAngle(finiteOr(snapshot?.yaw, this.yaw));
    if (localSnapshot) {
      this.localX = finiteOr(localSnapshot.x, this.localX);
      this.localY = finiteOr(localSnapshot.y, this.localY);
      this.localZ = finiteOr(localSnapshot.z, this.localZ);
      this.localYaw = normalizeAngle(finiteOr(localSnapshot.yaw, this.localYaw));
    } else {
      this.updateLocalFromParent(this.actor?.parent?.getComponent(TRANSFORM_COMPONENT));
    }
  }
}
