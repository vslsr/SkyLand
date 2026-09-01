export const MOVE_SPEED_ATTRIBUTE = 'Movement.Speed';
export const WATER_MOVEMENT_EFFECT_ID = 'Effect.Movement.WaterSlow';
export const IN_WATER_STATE_TAG = 'State.Movement.InWater';

export const WATER_MOVEMENT_EFFECT = Object.freeze({
  id: WATER_MOVEMENT_EFFECT_ID,
  lifetime: Object.freeze({ kind: 'infinite' }),
  grantedTags: Object.freeze([IN_WATER_STATE_TAG]),
  modifiers: Object.freeze([Object.freeze({
    attributeId: MOVE_SPEED_ATTRIBUTE,
    operation: 'multiply',
    magnitude: 0.5,
  })]),
  // 即使多个环境探针在同一帧确认水域，也只保留一个 50% Modifier。
  stacking: Object.freeze({
    key: WATER_MOVEMENT_EFFECT_ID,
    maxStacks: 1,
    scope: 'target',
  }),
});

export function createPlayerMovementAttributes(baseWalkSpeed) {
  const speed = Number(baseWalkSpeed);
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new RangeError('玩家 GAS 基础移动速度必须是正有限数字');
  }
  return [{
    id: MOVE_SPEED_ATTRIBUTE,
    initialValue: speed,
    minimum: 0,
    maximum: 30,
  }];
}

/** 维护一个无限时长涉水 GameplayEffect；进水添加、离水移除。 */
export class WaterMovementEffectController {
  constructor(abilitySystem) {
    if (!abilitySystem?.attributes?.has(MOVE_SPEED_ATTRIBUTE)) {
      throw new Error(`GAS 缺少玩家移动属性：${MOVE_SPEED_ATTRIBUTE}`);
    }
    this.abilitySystem = abilitySystem;
    this.effectHandle = undefined;
  }

  get moveSpeed() {
    return this.abilitySystem.attributes.getCurrentValue(MOVE_SPEED_ATTRIBUTE);
  }

  get inWater() {
    return this.abilitySystem.hasTag(IN_WATER_STATE_TAG);
  }

  sync(inWater) {
    if (inWater) {
      if (this.effectHandle) return false;
      const result = this.abilitySystem.applyEffect(WATER_MOVEMENT_EFFECT, {
        source: this.abilitySystem,
      });
      if (!result.ok || !result.handle) {
        throw new Error('涉水移动 GameplayEffect 应用失败');
      }
      this.effectHandle = result.handle;
      return true;
    }
    if (!this.effectHandle) return false;
    this.abilitySystem.removeEffect(this.effectHandle);
    this.effectHandle = undefined;
    return true;
  }

  dispose() {
    this.sync(false);
  }
}
