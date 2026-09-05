import type { ProxyId } from './RenderScene';
import type { RenderTransformBuffer } from './RenderTransformBuffer';
import {
  PARAM_SLIME_IMPACT_DIRECTION_X,
  PARAM_SLIME_IMPACT_DIRECTION_Y,
  PARAM_SLIME_IMPACT_DIRECTION_Z,
  PARAM_SLIME_IMPACT_IMPULSE,
  PARAM_SLIME_IMPACT_REVISION,
} from './RenderVisualParams';

/**
 * 被弓箭、别的武器弹药打中的那一下，玩法侧写、渲染侧读。
 *
 * **过边界的是一次事件，不是一个形状**：哪一次（计数）、从哪个方向来（弹药的飞行
 * 方向）、多重（[0, 1] 的冲量）。蒙皮凹多深、涟漪怎么散、什么时候弹回来，全在渲染
 * 侧积分——和死亡摊开（`RenderDeathCollapse.ts`）、松手回弹是同一个取向。
 *
 * 为什么是**方向**而不是命中点：凹陷是「顶点方向与来袭轴的夹角」的连续函数（和咬住
 * 的那个尖同一套），压根没有命中顶点这种离散的东西。命中点还得跟着被击者这一帧插值
 * 到哪儿走，方向不用；三个 f32 也比一个要重新锚定的点便宜。
 *
 * 这个文件不 import three——它是玩法侧也能用的写入口。
 */
export interface SlimeImpactParams {
  /**
   * 血量事件计数，**0 表示这条命还没被动过**。
   *
   * 复用血量的事件计数而不是另开一个：一次结算就是一次事件，飘字和这一下凹陷读的
   * 是同一件事，两个计数早晚会在同一帧对不上。渲染侧只比较「和上一帧一样吗」，
   * 不做算术，所以 f32 够用。
   */
  revision: number;
  /** 弹药的飞行方向，世界轴向的单位向量，也就是蒙皮被压进去的方向。 */
  directionX: number;
  directionY: number;
  directionZ: number;
  /** 这一下有多重 [0, 1]。0 或者零方向都表示「这一次事件没有冲击」。 */
  impulse: number;
}

/** 复用槽位的初值，也是「没挨过打」的槽位每帧写进去的那组值。 */
export const SLIME_IMPACT_AT_REST: SlimeImpactParams = {
  revision: 0,
  directionX: 0,
  directionY: 0,
  directionZ: 0,
  impulse: 0,
};

export function createSlimeImpactParams(): SlimeImpactParams {
  return { ...SLIME_IMPACT_AT_REST };
}

export function writeSlimeImpactParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  impact: SlimeImpactParams,
): void {
  transforms.writeParam(id, PARAM_SLIME_IMPACT_REVISION, impact.revision);
  transforms.writeParam(id, PARAM_SLIME_IMPACT_DIRECTION_X, impact.directionX);
  transforms.writeParam(id, PARAM_SLIME_IMPACT_DIRECTION_Y, impact.directionY);
  transforms.writeParam(id, PARAM_SLIME_IMPACT_DIRECTION_Z, impact.directionZ);
  transforms.writeParam(id, PARAM_SLIME_IMPACT_IMPULSE, impact.impulse);
}

export function readSlimeImpactParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  out: SlimeImpactParams,
): SlimeImpactParams {
  out.revision = transforms.readParam(id, PARAM_SLIME_IMPACT_REVISION);
  out.directionX = transforms.readParam(id, PARAM_SLIME_IMPACT_DIRECTION_X);
  out.directionY = transforms.readParam(id, PARAM_SLIME_IMPACT_DIRECTION_Y);
  out.directionZ = transforms.readParam(id, PARAM_SLIME_IMPACT_DIRECTION_Z);
  out.impulse = transforms.readParam(id, PARAM_SLIME_IMPACT_IMPULSE);
  return out;
}

/**
 * 生命值复制面里和这一下有关的那几个字段。玩家走快照、Actor 走 Component，
 * 两边是同一个形状（`HealthComponent` 与 `SnapshotHealth`），所以规则只有一份。
 */
export interface SlimeImpactHealth {
  readonly eventRevision: number;
  readonly lastHitX?: number;
  readonly lastHitY?: number;
  readonly lastHitZ?: number;
  readonly lastHitImpulse?: number;
}

/**
 * 把生命值事件翻译成这一帧要写进参数段的那五个数。
 *
 * **没有冲量的事件写静止值**（治疗、火、跌落，以及压根没有生命值的东西）：计数也一
 * 起归零。留着上一箭的计数与轴，下一次真的中箭时「和上一帧不一样」就成立不了了——
 * 而这条规则写在三处（玩家、远端玩家、Replica）迟早会有一处写反，所以它只有这一份。
 */
export function resolveSlimeImpactParams(
  out: SlimeImpactParams,
  health: SlimeImpactHealth | undefined,
): SlimeImpactParams {
  const impulse = health?.lastHitImpulse ?? 0;
  if (!health || !(impulse > 0)) {
    out.revision = 0;
    out.directionX = 0;
    out.directionY = 0;
    out.directionZ = 0;
    out.impulse = 0;
    return out;
  }
  out.revision = health.eventRevision;
  out.directionX = health.lastHitX ?? 0;
  out.directionY = health.lastHitY ?? 0;
  out.directionZ = health.lastHitZ ?? 0;
  out.impulse = impulse;
  return out;
}

/** 一次中箭：方向已归一化，冲量已夹到 [0, 1]。 */
export interface SlimeImpact {
  readonly directionX: number;
  readonly directionY: number;
  readonly directionZ: number;
  readonly impulse: number;
}

/**
 * 把「计数变了」翻译成「这一帧挨了一下」，一次性表现的老规矩（对照
 * `DeathCollapseTimer`）。
 *
 * **第一次看到一个计数只记下来，不放动画**：中途进房间、或者一具早就挨过打的
 * Replica 刚进 AOI，都不该把它过去的伤当着玩家的面重演一遍。只有「先记住它现在的
 * 计数、之后计数又变了」才是发生在眼前的一次。
 *
 * **计数变了但没有方向**（治疗、火、跌落、调试指令）同样要把新计数吃下去，只是不
 * 放动画——不吃的话，下一次真的中箭时「和上一帧不一样」会连着成立两次。
 */
export class SlimeImpactTrigger {
  private seenRevision?: number;

  /** 这一帧该砸的那一下；没有就是 undefined。 */
  public consume(params: SlimeImpactParams | undefined): SlimeImpact | undefined {
    if (!params) return undefined;
    const revision = Number.isFinite(params.revision) ? Math.max(0, Math.round(params.revision)) : 0;
    const previous = this.seenRevision;
    this.seenRevision = revision;
    if (previous === undefined || revision === previous) return undefined;
    // 计数归零只发生在槽位被回收给另一个 proxy 时：那是另一个人的身体，不是一箭。
    if (revision === 0) return undefined;
    const length = Math.hypot(params.directionX, params.directionY, params.directionZ);
    const impulse = Number(params.impulse);
    if (!(length > 1e-6) || !Number.isFinite(length) || !(impulse > 0)) return undefined;
    return {
      directionX: params.directionX / length,
      directionY: params.directionY / length,
      directionZ: params.directionZ / length,
      impulse: Math.min(1, impulse),
    };
  }
}
