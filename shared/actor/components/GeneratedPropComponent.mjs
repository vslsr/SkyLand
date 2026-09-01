import { ActorComponent } from '../ActorComponent.mjs';

export const GENERATED_PROP_COMPONENT = 'generatedProp';

/**
 * 世界生成物件的玩法状态。
 *
 * 位置、朝向、缩放和种类仍然由世界种子派生，一个字节都不同步；这里只保存
 * 「偏离默认生成结果」所需的那几项。
 *
 * 两种采集形态由原型的 `regrow` 区分：
 *
 * - **没有 `regrow`**：掉血直到被采完，采完就永久消失（树、石头）。
 * - **有 `regrow`**：没有血量，采一次进入冷却，冷却结束自己恢复（果子）。
 *   冷却用的是**绝对服务端时间** `readyAt`，和 `LifetimeComponent` 一样：
 *   chunk 卸载期间时间照样流逝，装回来时一次算清，不需要逐 tick 计时。
 *   `readyAt` 直接复制给客户端，两端各自判断有没有恢复，所以「长回来」
 *   这一刻不需要再发一条快照。
 */
export class GeneratedPropComponent extends ActorComponent {
  constructor(definition, runtime = {}) {
    super(GENERATED_PROP_COMPONENT);
    this.kind = Math.max(0, Math.trunc(Number(runtime.kind) || 0));
    this.chunkX = Math.trunc(Number(runtime.chunkX) || 0);
    this.chunkZ = Math.trunc(Number(runtime.chunkZ) || 0);
    this.propIndex = Math.max(0, Math.trunc(Number(runtime.propIndex) || 0));
    this.scale = Math.max(0.01, Number(runtime.scale) || 1);
    this.regrowSeconds = Math.max(0, Number(definition.regrow?.seconds) || 0);
    this.maximumHealth = Math.max(1, Math.trunc(Number(definition.maximumHealth) || 1));
    this.harvestDamage = Math.max(1, Math.trunc(Number(definition.harvestDamage) || 1));
    this.dropArchetypeId = definition.drop?.archetypeId;
    this.dropSpawnPattern = definition.drop?.spawnPattern ?? 'center';
    this.baseDropQuantity = Math.max(1, Math.trunc(Number(definition.drop?.quantity) || 1));
    this.health = Math.max(0, Math.min(
      this.maximumHealth,
      Math.trunc(Number(runtime.health ?? this.maximumHealth)),
    ));
    this.removed = runtime.removed === true || this.health === 0;
    if (this.removed) this.health = 0;
    /** 可再生物件下一次可采的绝对服务端秒数；0 表示现在就可采。 */
    this.readyAt = Math.max(0, Number(runtime.readyAt) || 0);
    this.revision = Math.max(0, Math.trunc(Number(runtime.revision) || 0));
  }

  get regrowable() {
    return this.regrowSeconds > 0;
  }

  /** 大棵的掉得多；数量跟着生成时的缩放走，两端算出的结果一致。 */
  get dropQuantity() {
    return Math.max(1, Math.round(this.baseDropQuantity * this.scale));
  }

  /** @param {number} elapsedSeconds 绝对服务端秒数 */
  isReady(elapsedSeconds) {
    if (this.removed) return false;
    return !this.regrowable || elapsedSeconds >= this.readyAt;
  }

  /** 可再生物件是否处于「已经采过、还没长回来」的状态。 */
  isCoolingDown(elapsedSeconds) {
    return this.regrowable && elapsedSeconds < this.readyAt;
  }

  /** 回到默认生成结果：不需要为它保留任何偏离态。 */
  isPristine(elapsedSeconds) {
    if (this.removed) return false;
    if (this.regrowable) return elapsedSeconds >= this.readyAt;
    return this.health >= this.maximumHealth;
  }

  /**
   * 采集一次。可再生物件进入冷却，其余的掉血。
   * @param {number} elapsedSeconds 绝对服务端秒数
   * @returns {boolean} 这一次采集有没有真的生效
   */
  harvest(elapsedSeconds) {
    if (!this.regrowable) return this.applyDamage();
    if (!this.isReady(elapsedSeconds)) return false;
    this.readyAt = elapsedSeconds + this.regrowSeconds;
    this.revision += 1;
    return true;
  }

  applyDamage(amount = this.harvestDamage) {
    if (this.removed || this.regrowable) return false;
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
    if (snapshot.health !== undefined) {
      this.health = Math.max(0, Math.min(
        this.maximumHealth,
        Math.trunc(Number(snapshot.health) || 0),
      ));
    }
    this.removed = snapshot.removed === true || (!this.regrowable && this.health === 0);
    if (this.removed) this.health = 0;
    this.readyAt = Math.max(0, Number(snapshot.readyAt) || 0);
    this.revision = Math.max(0, Math.trunc(Number(snapshot.revision) || 0));
    return true;
  }
}
