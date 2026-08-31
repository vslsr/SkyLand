import { ActorComponent } from '../ActorComponent.mjs';

export const TRANSFORM_COMPONENT = 'transform';

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export class TransformComponent extends ActorComponent {
  constructor(definition = {}) {
    super(TRANSFORM_COMPONENT);
    const position = Array.isArray(definition.position) ? definition.position : [];
    this.x = finiteOr(position[0]);
    this.y = finiteOr(position[1]);
    this.z = finiteOr(position[2]);
    this.yaw = finiteOr(definition.yaw);
  }

  applySnapshot(snapshot) {
    this.x = finiteOr(snapshot?.x, this.x);
    this.y = finiteOr(snapshot?.y, this.y);
    this.z = finiteOr(snapshot?.z, this.z);
    this.yaw = finiteOr(snapshot?.yaw, this.yaw);
  }
}
