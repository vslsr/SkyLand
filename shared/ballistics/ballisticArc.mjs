/**
 * 那条抛物弧本身（设计稿 `@w 木弓` 的 `A`）。
 *
 * 蓄力时画出来的白线、松手之后飞出去的那支箭、服务端判定时走的那条弹道，走的
 * 必须是**同一条弧**——各算一遍的话，箭会从线旁边擦过去，而玩家看的就是「我瞄
 * 的那条线」；服务端要是走另一条，被墙挡住的位置两端还会对不上。
 *
 * 它原先住在 `src/render/`：那时弧确实只是表现，判定只认落点与半径。加入弹药
 * 碰撞之后它同时是判定的行进路径（`projectileSweep.mjs` 沿它扫掠），所以搬到
 * shared 来，两端读同一份。`src/render/ballisticArc.ts` 只剩类型与再导出。
 */

/**
 * @typedef {{
 *   originX: number, originY: number, originZ: number,
 *   impactX: number, impactY: number, impactZ: number,
 *   ratio: number,
 *   travel?: number,
 * }} BallisticArc
 */

/** 弧顶最高抬到射程的几分之一。拉满时最平，轻放时最吊。 */
const APEX_RATIO = 0.22;

/**
 * 出手点比脚底高多少：弓握在身前偏上，弧从那里出去才不像贴着地面爬。
 *
 * 两端共用同一个值。客户端画线、服务端判定各写一个的话，贴着矮墙射出去的一箭
 * 会一边被挡住、一边飞过去。
 */
export const MUZZLE_HEIGHT = 0.62;

/**
 * 这条弧的弧顶抬多高。距离和蓄力比例一起决定它。
 *
 * 用的是**没被挡住时**的那对端点，`travel` 不参与：抛物线的形状由这一箭射多远
 * 决定，墙只是把它截断，不会把它压平。
 *
 * @param {BallisticArc} arc
 * @returns {number}
 */
export function ballisticArcApex(arc) {
  const distance = Math.hypot(arc.impactX - arc.originX, arc.impactZ - arc.originZ);
  return distance * APEX_RATIO * (1 - arc.ratio * 0.55);
}

/**
 * 弧上 `t ∈ [0, 1]` 处那一点。
 *
 * 水平方向匀速推进、竖直方向在两端连线上叠一条标准抛物线（两端为 0、中间最高）。
 * 写进 `out` 而不是返回一个新对象：飞行中的箭每帧都要问它要两次（当前点与前一点，
 * 用来求朝向），扫掠时每一段还要问两次，每次新建对象只是白白喂给 GC。
 *
 * @param {BallisticArc} arc
 * @param {number} t
 * @param {{ x: number, y: number, z: number }} out
 * @returns {{ x: number, y: number, z: number }}
 */
export function ballisticArcPoint(arc, t, out) {
  const apex = ballisticArcApex(arc);
  out.x = arc.originX + (arc.impactX - arc.originX) * t;
  out.y = arc.originY + (arc.impactY - arc.originY) * t + apex * 4 * t * (1 - t);
  out.z = arc.originZ + (arc.impactZ - arc.originZ) * t;
  return out;
}

/**
 * 弧在 `t` 处的**切线**：单位向量，也就是这一刻箭尖朝的方向。
 *
 * 解析求导，不是拿两帧位移去差分：差分要么被快照率限住（20 Hz 的位置插值是折线，
 * 每个接缝上切线跳一次），要么在停住那一帧退化成零向量。这条曲线的导数是写得出来的，
 * 就不该去猜它。
 *
 * 水平方向匀速，所以只有竖直那一项随 t 变：`dy/dt = (impactY - originY) + 4·apex·(1 - 2t)`。
 * 起手时它是正的（往上），过了弧顶变负（扎下去）。
 *
 * 退化成零向量（原点与落点重合、且弧顶为 0）时给正前方，不让它变成 NaN。
 *
 * @param {BallisticArc} arc
 * @param {number} t
 * @param {{ x: number, y: number, z: number }} out
 * @returns {{ x: number, y: number, z: number }}
 */
export function ballisticArcTangent(arc, t, out) {
  const apex = ballisticArcApex(arc);
  const dx = arc.impactX - arc.originX;
  const dz = arc.impactZ - arc.originZ;
  const dy = (arc.impactY - arc.originY) + apex * 4 * (1 - 2 * t);
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 1e-9)) {
    out.x = 0;
    out.y = 0;
    out.z = 1;
    return out;
  }
  out.x = dx / length;
  out.y = dy / length;
  out.z = dz / length;
  return out;
}

/**
 * 这一箭实际走完弧的百分之多少。没被挡住就是 1。
 *
 * **为什么截断记成一个比例，而不是把落点改小**：被墙挡住的一箭走的是原来那条
 * 抛物线的前一段，不是一条到墙为止的新抛物线。把端点改小会顺带把弧顶压平，
 * 画出来的线于是从墙面下方擦过去——玩家看到的落点对了，路径却错了。留着原来
 * 那对端点、只截掉后面一段，预览线、飞行的箭、判定读的就都是同一条曲线的
 * 同一个前缀。
 *
 * @param {BallisticArc} arc
 * @returns {number}
 */
export function ballisticArcTravel(arc) {
  const travel = Number(arc?.travel);
  if (!Number.isFinite(travel)) return 1;
  return Math.min(1, Math.max(0, travel));
}

/**
 * 这一箭真正落在哪儿：弧走到 `travel` 为止的那一点。没被挡住时就是名义落点。
 *
 * @param {BallisticArc} arc
 * @param {{ x: number, y: number, z: number }} out
 * @returns {{ x: number, y: number, z: number }}
 */
export function ballisticArcImpact(arc, out) {
  return ballisticArcPoint(arc, ballisticArcTravel(arc), out);
}
