import { ActorComponent } from '../ActorComponent.mjs';

export const HEALTH_COMPONENT = 'health';

/**
 * 一个实体的生命值与死亡状态。
 *
 * **权威数值不在这里**：服务端那一份住在同一个 Actor 的 GAS `Health` 属性里
 * （见 `shared/abilities/healthEffects.mjs`），这个 Component 是它的复制面——
 * 客户端没有 GAS 实体，收到的就是这几个字段。服务端每次改血都把 GAS 的
 * CurrentValue 同步过来（`server/actors/HealthMutations.mjs`），两边因此读的
 * 是同一个形状。
 *
 * `deathRevision` 与 `eventRevision` 都是**自增计数**而不是布尔：
 * 一次性动画和飘字靠「和上一帧不一样」触发，布尔在两帧之间翻回去就会被漏掉。
 */
export class HealthComponent extends ActorComponent {
  constructor(definition = {}) {
    super(HEALTH_COMPONENT);
    const maximum = Number(definition.maximum);
    if (!Number.isFinite(maximum) || maximum <= 0) {
      throw new RangeError('HealthComponent.maximum 必须是正有限数字');
    }
    this.maximum = maximum;
    const current = Number(definition.current);
    this.current = Number.isFinite(current) ? Math.max(0, Math.min(maximum, current)) : maximum;
    /** 尸体停留多少秒后销毁。0 表示留在世界里（玩家就是 0：他还连着）。 */
    this.corpseSeconds = Math.max(0, Number(definition.corpseSeconds) || 0);
    this.dead = definition.dead === true;
    /** 死亡计数。渲染侧看到它变了就踢一次死亡动画。 */
    this.deathRevision = Math.max(0, Number(definition.deathRevision) || 0);
    /** 最近一次血量变化：正是治疗，负是伤害。飘字读它。 */
    this.lastDelta = 0;
    /** 变化计数。0 表示这条命还没被动过，客户端据此不弹开局的那一下。 */
    this.eventRevision = 0;
    this.revision = 0;
    /** 死亡的绝对服务端秒数；尸体到点销毁由 `HealthSystem` 按它判断。 */
    this.diedAt = undefined;
  }

  get ratio() {
    return this.maximum > 0 ? this.current / this.maximum : 0;
  }

  /** 复制面的一份快照；服务端与客户端读同一组字段。 */
  snapshot() {
    return {
      current: Math.round(this.current * 100) / 100,
      maximum: this.maximum,
      dead: this.dead,
      deathRevision: this.deathRevision,
      lastDelta: Math.round(this.lastDelta * 100) / 100,
      eventRevision: this.eventRevision,
      revision: this.revision,
    };
  }

  applySnapshot(snapshot) {
    if (!snapshot) return false;
    const changed = snapshot.eventRevision !== this.eventRevision
      || snapshot.deathRevision !== this.deathRevision;
    this.current = snapshot.current;
    this.maximum = snapshot.maximum;
    this.dead = snapshot.dead;
    this.deathRevision = snapshot.deathRevision;
    this.lastDelta = snapshot.lastDelta;
    this.eventRevision = snapshot.eventRevision;
    this.revision = snapshot.revision;
    return changed;
  }
}
