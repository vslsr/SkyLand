import { ActorComponent } from '../ActorComponent.mjs';

export const PICKUP_DROP_COMPONENT = 'pickupDrop';

function finiteOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Actor 的拾取/松口能力；挂点与当前持有物都属于持有者，而不是被拾取物。 */
export class PickupDropComponent extends ActorComponent {
  constructor(definition = {}) {
    super(PICKUP_DROP_COMPONENT);
    this.mouthLocalX = finiteOr(definition.mouthLocalX);
    this.mouthLocalY = finiteOr(definition.mouthLocalY);
    this.mouthLocalZ = finiteOr(definition.mouthLocalZ);
    this.mouthLocalYaw = finiteOr(definition.mouthLocalYaw);
    this.heldActorId = definition.heldActorId ?? null;
    this.revision = 0;
  }

  pickup(actorId) {
    if (!actorId || this.heldActorId) return false;
    this.heldActorId = actorId;
    this.revision += 1;
    return true;
  }

  drop() {
    if (!this.heldActorId) return false;
    this.heldActorId = null;
    this.revision += 1;
    return true;
  }
}
