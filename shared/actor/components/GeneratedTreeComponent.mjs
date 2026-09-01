import { ActorComponent } from '../ActorComponent.mjs';

export const GENERATED_TREE_COMPONENT = 'generatedTree';

/** 生成树只保存偏离默认值所需的玩法状态；位置与外观仍由世界种子派生。 */
export class GeneratedTreeComponent extends ActorComponent {
  constructor(definition, runtime = {}) {
    super(GENERATED_TREE_COMPONENT);
    this.chunkX = Math.trunc(Number(runtime.chunkX) || 0);
    this.chunkZ = Math.trunc(Number(runtime.chunkZ) || 0);
    this.propIndex = Math.max(0, Math.trunc(Number(runtime.propIndex) || 0));
    this.scale = Math.max(0.01, Number(runtime.scale) || 1);
    this.maximumHealth = Math.max(1, Math.trunc(Number(definition.maximumHealth) || 1));
    this.chopDamage = Math.max(1, Math.trunc(Number(definition.chopDamage) || 1));
    this.baseWoodQuantity = Math.max(1, Math.trunc(Number(definition.woodQuantity) || 1));
    this.health = Math.max(0, Math.min(
      this.maximumHealth,
      Math.trunc(Number(runtime.health ?? this.maximumHealth)),
    ));
    this.removed = runtime.removed === true || this.health === 0;
    if (this.removed) this.health = 0;
    this.revision = Math.max(0, Math.trunc(Number(runtime.revision) || 0));
  }

  get woodQuantity() {
    return Math.max(1, Math.round(this.baseWoodQuantity * this.scale));
  }

  applyDamage(amount = this.chopDamage) {
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
