import { ActorComponent } from '../ActorComponent.mjs';

export const CARGO_COMPONENT = 'cargo';

/** 可被装上载具的独立 Actor；carrierActorId 由房间 DS 权威维护。 */
export class CargoComponent extends ActorComponent {
  constructor(definition) {
    super(CARGO_COMPONENT);
    this.mass = definition.mass;
    this.mountLocalX = definition.mountLocalX;
    this.mountLocalY = definition.mountLocalY;
    this.mountLocalZ = definition.mountLocalZ;
    this.carrierActorId = null;
    this.revision = 0;
  }
}
