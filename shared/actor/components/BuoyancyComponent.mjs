import { ActorComponent } from '../ActorComponent.mjs';

export const BUOYANCY_COMPONENT = 'buoyancy';

export class BuoyancyComponent extends ActorComponent {
  constructor(definition) {
    super(BUOYANCY_COMPONENT);
    this.parts = definition.parts.map((part) => ({ ...part }));
    this.loads = [];
    this.minimumBeam = definition.minimumBeam;
    this.minimumLength = definition.minimumLength;
    this.maximumTrimRadians = definition.maximumTrimRadians;
    this.minimumDraft = definition.minimumDraft;
    this.maximumDraft = definition.maximumDraft;
    this.state = 'afloat';
    this.draft = definition.minimumDraft;
    this.staticRoll = 0;
    this.staticPitch = 0;
    this.speedFactor = 1;
    this.revision = 0;
    this.eventRevision = 0;
    this.lastEvent = undefined;
    this.cargoMass = 0;
    this.damagedPartCount = 0;
    this.dirty = true;
  }

  markDirty() {
    this.dirty = true;
  }
}
