import { ActorComponent } from '../ActorComponent.mjs';

export const MOVING_ENTITY_COMPONENT = 'movingEntity';

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * **实体**：在游戏里频繁移动的东西。这是最基础的那一层类型，生物、玩家、以后
 * 会跑的载具都挂同一个它。
 *
 * 为什么是一个 Component 而不是一条类继承链：这个仓库里「一件东西是什么」一律
 * 由它挂了哪些 Component 推出来（见 `actorTags.mjs` 与 `.cursor/rules/`）。写成
 * `class Creature extends Entity` 的话，「会走路」这件事就同时记在两个地方——
 * 类型树上一份、Component 上一份——而一只被别的系统推着走的箱子永远不会是
 * `Creature` 的子类，却确确实实是一个频繁移动的圆。挂一个 Component 上去就行了。
 *
 * 它声明的是**别人需要知道的那点事**，只有两件：
 *
 * 1. `radius`——它在地面上占多大一个圆。避障、寻路的「这一格塞不塞得下」、
 *    碰撞推出，三处必须是同一个数；各写各的就会出现「走得进去却被推出来」。
 * 2. `avoidsCrowd`——它自己让不让路。写 `false` 的**仍然是别人的障碍**，
 *    玩家就是这一类：谁也不许替玩家打方向盘，但生物必须绕着他走。
 *
 * 剩下三个是**运行期**的量（这一刻走多快、在不在走、离目标还有多远），由驱动
 * 这只实体的那个系统每 tick 写进来。放在这里而不是让避障自己去问各式各样的
 * 驱动者，是因为驱动者只有一个，而想知道的系统会越来越多。
 */
export class MovingEntityComponent extends ActorComponent {
  constructor(definition = {}) {
    super(MOVING_ENTITY_COMPONENT);
    /** 地面足迹半径，米。 */
    this.radius = Math.max(0.05, finiteOr(definition.radius, 0.4));
    /** 自己要不要给别的实体让路。false 的仍然是别人的障碍。 */
    this.avoidsCrowd = definition.avoidCrowd !== false;

    /** 这一刻的行进速度，米每秒。避障用它决定预测窗口看多远。 */
    this.speed = 0;
    /** 这一刻在不在被推着走。站着不动的挡路者不会让路，避让责任全在对方。 */
    this.moving = false;
    /** 离自己目标还有多远，米。没有目标就是 Infinity。 */
    this.goalDistance = Infinity;
    /**
     * 这一 tick 在避障位置表里的下标，由建表的那个系统写，-1 表示没进表。
     *
     * 存在这里是为了让「Actor → 表里第几个」这件事是 O(1) 的：避障每 tick 要
     * 按下标回读几万次邻居，而每次都去查一张 Map 就是每 tick 几万次哈希。
     */
    this.frameIndex = -1;
  }

  /** 驱动者每 tick 报一次自己的运动状态。 */
  reportMotion(speed, moving, goalDistance = Infinity) {
    this.speed = Math.max(0, finiteOr(speed, 0));
    this.moving = moving === true;
    this.goalDistance = Number.isFinite(goalDistance) ? goalDistance : Infinity;
  }
}
