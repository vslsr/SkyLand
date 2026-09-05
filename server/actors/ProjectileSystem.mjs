import {
  HEALTH_COMPONENT,
  PROJECTILE_COMPONENT,
  SIMPLE_COLLISION_COMPONENT,
  TRANSFORM_COMPONENT,
  createSimpleCollisionFromCharacter,
} from '../../shared/actor/index.mjs';
import {
  ballisticArcPoint,
  sweepProjectileArc,
  sweepProjectileTargets,
} from '../../shared/ballistics/index.mjs';

/**
 * 飞在空中的弹药，每 tick 推进一小段并**沿途做碰撞检测**（设计稿 `@w 木弓` 的 `A`）。
 *
 * 这个 System 是「箭穿墙」的正面修复。以前的模型是：松手那一刻就按朝向和蓄力比例
 * 反解出落点、当场结算，飞出去的箭只是客户端画的一段动画。于是墙、地形、站在半路
 * 上的人全都没有机会说话——判定在它们之前就做完了。
 *
 * 现在这一箭是世界里一件真东西：
 *
 * 1. **推进**：沿射出那一刻定下的弧走 `travel ∈ [0, 1]`，速度恒定。走的是同一条
 *    `ballisticArc`，所以蓄力时那条白线、飞着的这支箭、下面这次扫掠是同一条曲线。
 * 2. **扫掠**：这一 tick 走过的那**一段**交给 `sweepProjectileArc` 扫一次——世界几何
 *    问 Rapier（地形、墙、静态物件），实体问它们自己的 `SimpleCollision`。先碰到
 *    的那一个决定这一箭停在哪儿。
 * 3. **结算**：停下的那一刻才把伤害交出去（`world.context.applyProjectileImpact`），
 *    落点就是它真正停住的位置，不是名义落点。
 * 4. **收走**：停住之后插在那儿 `lingerSeconds` 秒，让眼睛跟得上，然后从世界里摘掉。
 *    回收归这个 System 自己管，弹药原型因此不带 `lifetime`——那个 Component 只由
 *    `HighCountActorSystem` 兑现（它要 itemStack + residency + dropMotion），挂在箭上
 *    是一个没人跑的计时器。这里的上界是确定的：`flightSeconds + lingerSeconds`。
 *
 * **为什么不逐帧积分速度**：弧在射出那一刻就完整定下来了，推进只是沿它取点。改成
 * 存速度加重力的话，客户端画线一遍、服务端飞一遍，两条积分的误差会让「我瞄的那条
 * 线」和「箭真的飞的那条线」慢慢分开。
 *
 * **成本有上界**：每 tick 的工作量正比于**在飞的弹药数**乘以每段一次扫掠查询，
 * 段数按这一 tick 走过的弧长比例分（见 `PROJECTILE_ARC_SEGMENTS`），与射程和世界
 * 面积都无关。候选实体走「带生命值的 Actor」这一条索引，场景常驻 Actor 由 Schema
 * 限制在 256 个以内。天上一支箭都没有时这个 System 只是一次空查询。
 */
export class ProjectileSystem {
  /** 每 tick 复用的候选实体表，避免每支箭各建一份。 */
  #targets = [];
  /** 玩家的窄相形状是算出来的（他们没有 SimpleCollision），算一次就留着。 */
  #characterCollisions = new WeakMap();
  #point = { x: 0, y: 0, z: 0 };

  update(world, deltaSeconds, elapsedSeconds) {
    const step = Math.max(0, Number(deltaSeconds) || 0);
    const now = Number(elapsedSeconds) || 0;
    const flying = world.query(PROJECTILE_COMPONENT, TRANSFORM_COMPONENT);
    if (flying.length === 0) return;
    this.#collectTargets(world);
    const physics = world.context.physics;

    for (const actor of flying) {
      const projectile = actor.requireComponent(PROJECTILE_COMPONENT);
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      if (projectile.stopped) {
        // 插在那儿的那一段：位置不再变，到点收走。
        if (now >= projectile.stoppedAt + projectile.lingerSeconds) world.removeActorTree(actor.id);
        continue;
      }
      if (step <= 0) continue;

      const nextTravel = Math.min(1, projectile.travel + step / projectile.flightSeconds);
      const hit = sweepProjectileArc(projectile, {
        radius: projectile.radius,
        from: projectile.travel,
        to: nextTravel,
        // 射手自己排在物理那一路之外：出手点在他身体里面，不排掉的话第一段扫掠
        // 就撞在自己的角色胶囊上。实体那一路由 `sweepProjectileTargets` 排。
        sweepWorld: physics
          ? (start, end, radius) => physics.castProjectileSphere(
            start,
            end,
            radius,
            projectile.ownerActorId,
          )
          : undefined,
        sweepTargets: (start, end, radius) => sweepProjectileTargets(
          start,
          end,
          radius,
          this.#targets,
          projectile.ownerActorId,
        ),
      });

      projectile.travel = hit.travel;
      this.#writeTransform(projectile, transform);
      // 撞上了、或者走完了整条弧（落到名义落点那一格地面上）——两种都是「到了」，
      // 伤害在这一刻结算。走完整条弧也算命中，否则射空的一箭会永远飞在空中。
      if (hit.blocked || hit.travel >= 1) {
        projectile.stop(hit.travel, now);
        world.context.applyProjectileImpact?.(projectile, {
          x: hit.x,
          y: hit.y,
          z: hit.z,
          targetActorId: hit.targetId,
          blocked: hit.blocked,
        });
      }
    }
  }

  /** 这一箭这一刻该在哪儿、朝哪儿。俯仰不过网：渲染侧按位移自己求切线。 */
  #writeTransform(projectile, transform) {
    ballisticArcPoint(projectile, projectile.travel, this.#point);
    transform.setWorldTransform(
      [this.#point.x, this.#point.y, this.#point.z],
      Math.atan2(projectile.impactX - projectile.originX, projectile.impactZ - projectile.originZ),
    );
  }

  /**
   * 这一 tick 里能被射中的东西：带生命值、还活着、有窄相形状的 Actor。
   *
   * 没有生命值的静态物件不收——它们本来就在 Rapier 那一路的世界几何里，在这里再
   * 算一遍只会让同一堵墙被扫两次。尸体不收：一箭钉在尸体上会挡住它后面还活着的
   * 那一只。
   *
   * **玩家要单独算一份形状**：他们没有 `SimpleCollisionComponent`（推出归角色
   * 控制器那具 Rapier 胶囊管）。少了这一份，Rapier 仍会把箭挡在别人身上，但回答
   * 不了「插在谁身上」——那一箭就只剩落点半径那一圈溅射，正面射中和擦着脚边落地
   * 变成同一件事。
   */
  #collectTargets(world) {
    this.#targets.length = 0;
    for (const actor of world.query(HEALTH_COMPONENT, TRANSFORM_COMPONENT)) {
      if (actor.requireComponent(HEALTH_COMPONENT).dead) continue;
      const collision = actor.getComponent(SIMPLE_COLLISION_COMPONENT)
        ?? this.#characterCollisionOf(actor);
      if (!collision) continue;
      this.#targets.push({
        id: actor.id,
        collision,
        transform: actor.requireComponent(TRANSFORM_COMPONENT),
      });
    }
  }

  /** 角色的圆柱窄相。尺寸取角色控制器用的那一对，不是模型半径。 */
  #characterCollisionOf(actor) {
    const radius = Number(actor.collisionRadius);
    const height = Number(actor.collisionHeight);
    if (!Number.isFinite(radius) || !Number.isFinite(height)) return undefined;
    let collision = this.#characterCollisions.get(actor);
    if (!collision) {
      collision = createSimpleCollisionFromCharacter(radius, height);
      this.#characterCollisions.set(actor, collision);
    }
    return collision;
  }
}
