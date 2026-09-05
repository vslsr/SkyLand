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
    /**
     * 最近一次伤害是**顺着哪个方向打进来的**：弹药的飞行方向，单位向量，世界轴向。
     *
     * 为什么是方向而不是命中点：蒙皮那一下凹陷是按「顶点方向与来袭轴的夹角」长出来的
     * 连续函数（和咬住的尖同一套），没有命中顶点这种离散的东西，所以过网络的也只需要
     * 一个轴。命中点还得跟着被击者这一帧插值到哪儿走，方向不用。
     *
     * 全零表示这一次事件没有方向：治疗、掉血的环境伤害、调试指令都是。
     */
    this.lastHitX = 0;
    this.lastHitY = 0;
    this.lastHitZ = 0;
    /** 这一下有多重 [0, 1]，蒙皮的凹陷深度按它缩放。0 表示没有冲击。 */
    this.lastHitImpulse = 0;
    this.revision = 0;
    /** 死亡的绝对服务端秒数；尸体到点销毁由 `HealthSystem` 按它判断。 */
    this.diedAt = undefined;
  }

  /**
   * 记下这一次伤害的来袭方向。没有方向（治疗、火、跌落）就清零——**清零是必须的**：
   * 这几个字段和 `lastDelta` 一样描述「最近一次事件」，留着上一箭的轴，下一次治疗
   * 就会在客户端被当成又挨了一下。
   */
  recordHit(impact) {
    const x = Number(impact?.x);
    const y = Number(impact?.y ?? 0);
    const z = Number(impact?.z);
    const impulse = Number(impact?.impulse);
    const length = Math.hypot(x, y, z);
    if (!Number.isFinite(length) || length <= 1e-6 || !(impulse > 0)) {
      this.lastHitX = 0;
      this.lastHitY = 0;
      this.lastHitZ = 0;
      this.lastHitImpulse = 0;
      return;
    }
    this.lastHitX = x / length;
    this.lastHitY = y / length;
    this.lastHitZ = z / length;
    this.lastHitImpulse = Math.min(1, impulse);
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
      // 有冲击才上线：治疗与环境伤害占大多数，那几个字段常年是零，
      // 每一份快照都带上它们等于给每个带血的东西白付四个数。
      ...(this.lastHitImpulse > 0 ? {
        lastHitX: Math.round(this.lastHitX * 1000) / 1000,
        lastHitY: Math.round(this.lastHitY * 1000) / 1000,
        lastHitZ: Math.round(this.lastHitZ * 1000) / 1000,
        lastHitImpulse: Math.round(this.lastHitImpulse * 100) / 100,
      } : {}),
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
    // 缺省就是「这一次没有来袭方向」：字段只在有冲击时才过网。
    this.lastHitX = snapshot.lastHitX ?? 0;
    this.lastHitY = snapshot.lastHitY ?? 0;
    this.lastHitZ = snapshot.lastHitZ ?? 0;
    this.lastHitImpulse = snapshot.lastHitImpulse ?? 0;
    return changed;
  }
}
