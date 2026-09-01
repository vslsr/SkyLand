import { ActorComponent } from '../ActorComponent.mjs';

export const GENERATED_PROP_COMPONENT = 'generatedProp';

/**
 * 世界生成物件的玩法状态。
 *
 * 位置、朝向、缩放和种类仍然由世界种子派生，一个字节都不同步；这里只保存
 * 「偏离默认生成结果」所需的那几项：还剩多少血、有没有被采完。
 */
export class GeneratedPropComponent extends ActorComponent {
  constructor(definition, runtime = {}) {
    super(GENERATED_PROP_COMPONENT);
    this.kind = Math.max(0, Math.trunc(Number(runtime.kind) || 0));
    this.chunkX = Math.trunc(Number(runtime.chunkX) || 0);
    this.chunkZ = Math.trunc(Number(runtime.chunkZ) || 0);
    this.propIndex = Math.max(0, Math.trunc(Number(runtime.propIndex) || 0));
    this.scale = Math.max(0.01, Number(runtime.scale) || 1);
    this.maximumHealth = Math.max(1, Math.trunc(Number(definition.maximumHealth) || 1));
    this.harvestDamage = Math.max(1, Math.trunc(Number(definition.harvestDamage) || 1));
    this.dropArchetypeId = definition.drop?.archetypeId;
    this.baseDropQuantity = Math.max(1, Math.trunc(Number(definition.drop?.quantity) || 1));
    this.health = Math.max(0, Math.min(
      this.maximumHealth,
      Math.trunc(Number(runtime.health ?? this.maximumHealth)),
    ));
    this.removed = runtime.removed === true || this.health === 0;
    if (this.removed) this.health = 0;
    this.revision = Math.max(0, Math.trunc(Number(runtime.revision) || 0));
  }

  /** 大树掉的木材比小树多；数量跟着生成时的缩放走，两端算出的结果一致。 */
  get dropQuantity() {
    return Math.max(1, Math.round(this.baseDropQuantity * this.scale));
  }

  applyDamage(amount = this.harvestDamage) {
    if (this.removed) return false;
    const damage = Math.max(0, Math.trunc(Number(amount) || 0));
    if (damage === 0) return false;
    const nextHealth = Math.max(0, this.health - damage);
    if (nextHealth === this.health) return false;
    this.health = nextHealth;
    this.removed = nextHealth === 0;
    this.revision += 1;
    return true;
  }

  applySnapshot(snapshot) {
    if (!snapshot || snapshot.revision < this.revision) return false;
    if (Number.isFinite(snapshot.maximumHealth)) {
      this.maximumHealth = Math.max(1, Math.trunc(Number(snapshot.maximumHealth)));
    }
    this.health = Math.max(0, Math.min(
      this.maximumHealth,
      Math.trunc(Number(snapshot.health) || 0),
    ));
    this.removed = snapshot.removed === true || this.health === 0;
    if (this.removed) this.health = 0;
    this.revision = Math.max(0, Math.trunc(Number(snapshot.revision) || 0));
    return true;
  }
}
