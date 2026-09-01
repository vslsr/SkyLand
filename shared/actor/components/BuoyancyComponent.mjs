import { ActorComponent } from '../ActorComponent.mjs';
import { evaluateVesselBuoyancy } from '../../vesselBuoyancy.mjs';

export const BUOYANCY_COMPONENT = 'buoyancy';

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/** 服务端重算与客户端初始状态共用，保证同一原型得到相同吃水。 */
export function recalculateBuoyancyComponent(component, incrementRevision = true) {
  const result = evaluateVesselBuoyancy([...component.parts, ...component.loads], {
    minimumBeam: component.minimumBeam,
    minimumLength: component.minimumLength,
    maximumTrimRadians: component.maximumTrimRadians,
  });
  const draftRatio = clamp(result.draftRatio, 0, 1);
  component.state = result.state;
  component.draft = component.minimumDraft
    + (component.maximumDraft - component.minimumDraft) * draftRatio;
  component.staticRoll = result.trimRoll;
  component.staticPitch = result.trimPitch;
  component.speedFactor = result.speedFactor;
  if (incrementRevision) component.revision += 1;
  component.dirty = false;
}

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
    this.bobAmplitude = Math.max(0, Number(definition.bobAmplitude) || 0);
    this.bobFrequency = Math.max(0, Number(definition.bobFrequency) || 0);
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
    // 动态玩家不会走普通 Actor 快照；构造时先算一次，两端可立即使用同一吃水。
    recalculateBuoyancyComponent(this, false);
    this.dirty = true;
  }

  markDirty() {
    this.dirty = true;
  }
}
