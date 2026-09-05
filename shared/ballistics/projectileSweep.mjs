import { sweepSphereAgainstSimpleCollision } from '../collision/collisionBox.mjs';
import { ballisticArcPoint } from './ballisticArc.mjs';

/**
 * 弹药沿弧的碰撞检测，两端共用（设计稿 `@w 木弓` 的 `A`／`D`）。
 *
 * **原来为什么没有**：一次射击在松手那一刻就结算完了，落点由朝向和蓄力比例反解，
 * 抛物线只是表现。那套模型下箭确实不需要飞行物理——但它也因此**穿墙**：墙后面
 * 的东西照打，地形抬高一米也拦不住，画出来的箭直接从石头里穿过去。
 *
 * **现在是什么**：弧是这一箭的行进路径。射出去的是一个真的会飞的 Actor
 * （`server/actors/ProjectileSystem.mjs`），每个 tick 沿弧推进一小段，**那一段**
 * 拿到这里扫一次：第一件挡住它的东西决定这一箭停在哪儿、什么时候停。伤害在
 * 那一刻才结算，不在松手那一刻。
 *
 * **为什么是纯函数加两个回调**：这里既不认识 Rapier，也不认识 Actor 世界。世界几何
 * （地形、墙、静态物件）在服务端来自房间的 `PhysicsWorld`、在客户端来自本地那一个；
 * 实体来自各自的 Actor 世界。两边的**取法**不同，**算法**必须相同，所以算法在这里，
 * 取法留给调用方。客户端的蓄力预览线用同一个函数走完整条弧，于是「线画到哪儿」和
 * 「箭飞到哪儿」是同一次计算的两次调用。
 *
 * **成本有上界**：一段弧按它占整条弧的比例切段，整条弧最多 `PROJECTILE_ARC_SEGMENTS`
 * 段，与射程、世界大小都无关；每段一次扫掠查询。实体那一路由调用方喂候选，
 * 调用方自己收敛候选集（服务端走的是场景内带生命值的 Actor，Schema 限在 256 个以内）。
 */

/** 整条弧切成几段去扫。段越多越贴合弧、查询也越多；16 段在 22 米射程上每段约 1.4 米。 */
export const PROJECTILE_ARC_SEGMENTS = 16;

/**
 * 弹药的碰撞半径，米。
 *
 * 不是箭杆的粗细：细成一条线的话，贴着墙角射出去的一箭会从两片三角形之间的缝里
 * 钻过去。给它一个手指粗细的球，扫掠出来的结果才和眼睛看到的一致。
 */
export const PROJECTILE_RADIUS = 0.08;

/**
 * 沿弧的 `[from, to]` 一段扫掠，返回这一段里这一箭停在哪儿。
 *
 * @param {import('./ballisticArc.mjs').BallisticArc} arc 名义弧（没被挡住时的那条）
 * @param {{
 *   sweepWorld?: (start: readonly [number, number, number], end: readonly [number, number, number], radius: number) => number,
 *   sweepTargets?: (start: readonly [number, number, number], end: readonly [number, number, number], radius: number) => ({ fraction: number, id?: string } | undefined),
 *   radius?: number,
 *   from?: number,
 *   to?: number,
 *   segments?: number,
 * }} probes
 * @returns {{ travel: number, x: number, y: number, z: number, blocked: boolean, targetId?: string }}
 */
export function sweepProjectileArc(arc, probes = {}) {
  const radius = positive(probes.radius, PROJECTILE_RADIUS);
  const from = clamp01(probes.from ?? 0);
  const to = Math.max(from, clamp01(probes.to ?? 1));
  // 段数按这一段占整条弧的比例分：一个 tick 只推进弧的十分之一时不该扫十六段。
  const segments = Math.max(1, Math.round(positive(
    probes.segments,
    PROJECTILE_ARC_SEGMENTS * (to - from),
  )));
  const start = [0, 0, 0];
  const end = [0, 0, 0];
  const point = { x: 0, y: 0, z: 0 };

  ballisticArcPoint(arc, from, point);
  start[0] = point.x; start[1] = point.y; start[2] = point.z;

  for (let index = 0; index < segments; index += 1) {
    const segmentFrom = from + ((to - from) * index) / segments;
    const segmentTo = from + ((to - from) * (index + 1)) / segments;
    ballisticArcPoint(arc, segmentTo, point);
    end[0] = point.x; end[1] = point.y; end[2] = point.z;

    // 世界几何与实体各扫一次，取先碰到的那一个。同一段里两者都碰到时，近的那个
    // 才是真的：贴着墙站的那只史莱姆挨打，站在墙后面的那只不挨打。
    const world = clamp01(probes.sweepWorld?.(start, end, radius) ?? 1);
    const target = probes.sweepTargets?.(start, end, radius);
    const targetFraction = target ? clamp01(target.fraction) : 1;
    const hit = Math.min(world, targetFraction);
    if (hit < 1) {
      const travel = segmentFrom + (segmentTo - segmentFrom) * hit;
      ballisticArcPoint(arc, travel, point);
      return {
        travel,
        x: point.x,
        y: point.y,
        z: point.z,
        blocked: true,
        targetId: targetFraction <= world ? target?.id : undefined,
      };
    }

    start[0] = end[0]; start[1] = end[1]; start[2] = end[2];
  }

  ballisticArcPoint(arc, to, point);
  return { travel: to, x: point.x, y: point.y, z: point.z, blocked: false };
}

/**
 * 一段线段扫过这些候选实体，最先碰到的那一个。
 *
 * 用的是 Actor 的 `SimpleCollision`——和准星拾取、相机悬臂同一份窄相实现
 * （`sweepSphereAgainstSimpleCollision`）。射手自己由 `excludeId` 剔掉：射出去的
 * 东西打不到射出它的人（弓的最短射程只有 6 米，出手点就在自己身上）。
 *
 * @param {readonly [number, number, number]} start
 * @param {readonly [number, number, number]} end
 * @param {number} radius
 * @param {Iterable<{ id?: string, collision: object, transform: object }>} candidates
 * @param {string} [excludeId] 跳过这一个：射手自己。
 * @returns {{ fraction: number, id?: string } | undefined}
 */
export function sweepProjectileTargets(start, end, radius, candidates, excludeId) {
  let nearest;
  for (const candidate of candidates) {
    if (excludeId !== undefined && candidate.id === excludeId) continue;
    const fraction = sweepSphereAgainstSimpleCollision(start, end, radius, candidate);
    if (!(fraction < 1)) continue;
    if (nearest && fraction >= nearest.fraction) continue;
    nearest = { fraction, id: candidate.id };
  }
  return nearest;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, number));
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
