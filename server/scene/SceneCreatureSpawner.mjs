import {
  HEALTH_COMPONENT,
  TRANSFORM_COMPONENT,
  createSimpleCollisionFromRender,
} from '../../shared/actor/index.mjs';
import { STATIC_SURFACE_KEY } from '../../shared/build/index.mjs';
import { COLLISION_LAYER } from '../../shared/collision/index.mjs';
import { createServerActor } from '../actors/ServerActorFactory.mjs';
import {
  DESPAWN_VERDICT,
  canSpawnCreatureAt,
  creatureCap,
  despawnVerdict,
  isCreatureChunk,
  isNightWindow,
  packSize,
  sampleSpawnPoint,
  spawnChunkOf,
} from '../../shared/world/creatureSpawn.mjs';
import { toWorldSeed } from '../../shared/world/worldConfig.mjs';

/** 一群里的个体在刷新点周围散开的半径，米。 */
const PACK_SCATTER_RADIUS = 2.5;
/** 随机消失档每个周期的消失概率。走远之后世界会慢慢空掉，而不是「啪」地一下。 */
const RANDOM_DESPAWN_CHANCE = 0.25;
/** 一次周期最多补的时长。进程卡顿之后不该一口气刷出好几轮。 */
const MAXIMUM_CATCH_UP_SECONDS = 5;
/** 夜间窗口。和天空真正暗下来的那一段对齐，不额外做成配置项。 */
const NIGHT_FROM_HOUR = 19;
const NIGHT_TO_HOUR = 5;

function createRandom(seed) {
  let state = (seed >>> 0) || 0x9e37_79b9;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * 房间里的生物自然刷新。
 *
 * 规则全在 `shared/world/creatureSpawn.mjs`，这里只负责**什么时候问它们**：
 * 按周期跑（不是每 tick）、按配额刷、成群落地、走远了收走。分开的理由和寻路
 * 那一层一样——规则是纯函数，可以单独测；调度要认识场景、玩家和 ActorWorld，
 * 只能在这里。
 *
 * ## 大世界
 *
 * 这个类不持有任何按面积增长的东西，成本只跟三个数走：
 *
 * - **在场玩家数**。候选点是从某个玩家周围的圆环里取的，没有人在场就一次都不取。
 * - **配额**。`capPerPlayer × 玩家数`，再被 `maximumPerRoom` 封顶。
 * - **每周期的尝试次数**。地形不合适就放弃这一次，不重试到成功——一个被水围住的
 *   玩家应该让刷新变稀，而不是让这一帧变长。
 *
 * 活着的个体登记在一张 id 表里，大小等于配额。**不扫世界**：`ActorWorld` 里
 * 有多少 Actor 与这里无关。
 *
 * ## 边界
 *
 * - 只在流式地形图上刷（需要 `cellCodeAt` 才能问「这一格是什么」）。
 * - 刷出来的个体**不持久**：房间重启不保留，走远了就消失。Minecraft 用挂牌
 *   (persistence) 把一只怪钉住，那要的是一条玩家能操作的路径，现在还没有。
 * - 一次只按一个玩家取候选点。要「每个玩家都有自己的一份配额」得先有分组，
 *   而这一版的配额是全房间共享的。
 */
export class SceneCreatureSpawner {
  /**
   * @param {import('./ServerScene.mjs').ServerScene} scene
   * @param {ReadonlyArray<object>} [rules] 场景的 gameplay.creatureSpawns
   */
  constructor(scene, rules = []) {
    this.scene = scene;
    this.random = createRandom(toWorldSeed(scene.worldSeed) ^ 0x63_7275_65);
    /**
     * 每条规则一份运行态。规则本身来自场景数据且不可变，这里只挂上判据要用的
     * 查询、「下一次什么时候刷」和「现在有哪些是它刷出来的」。
     * @type {Array<{
     *   rule: object,
     *   archetype: object,
     *   world: object,
     *   secondsUntilCycle: number,
     *   liveIds: Set<string>,
     * }>}
     */
    this.entries = [];
    // 复用的输出对象，热路径不为每个候选点分配。放在早退之前赋值：一张不刷怪
    // 的图上它们用不到，但半个构造完的对象是个只在以后才会咬人的坑。
    this.scratchPoint = { x: 0, z: 0 };
    this.scratchCell = { cellX: 0, cellZ: 0, y: 0 };
    // 没有台阶地形就没有「这一格是什么」可问，整套刷新在这张图上不存在。
    if (!scene.terrainCellCodeAt) return;
    for (const rule of rules) {
      const archetype = scene.actorWorld.context.archetypes?.get(rule.archetypeId);
      // 绑定的合法性在 SceneCatalog 就校验过了；这里只是不让一个坏配置每个
      // 周期炸一次。
      if (!archetype) continue;
      // 足迹取自这只生物**自己那份碰撞盒**的推导函数，不在这里另算一遍：
      // 「刷得进去」和「站得住」必须是同一个圆，否则会刷出一只当场被推开的怪。
      const collision = createSimpleCollisionFromRender(
        archetype.components.render,
        archetype.components.dropMotion,
      );
      this.entries.push({
        rule,
        archetype,
        // 判据要问的四个查询按规则建**一次**。一个周期要试十几个候选点，
        // 每次现建一份就是十几个只活一瞬间的闭包。
        world: this.createWorldQueries({
          radius: Math.min(collision.halfWidth, collision.halfLength),
          minimumY: collision.minimumY,
          maximumY: collision.maximumY,
        }),
        // 错开首次刷新，房间开局不会在同一秒把所有种类一起放出来。
        secondsUntilCycle: this.random() * rule.cycleSeconds,
        liveIds: new Set(),
      });
    }
  }

  get enabled() {
    return this.entries.length > 0;
  }

  /** 当前由刷新产生、仍然活着的个体总数。测试与调试用。 */
  get liveCount() {
    let count = 0;
    for (const entry of this.entries) count += entry.liveIds.size;
    return count;
  }

  /** 房间清空或场景重置：把刷出来的全部收走。 */
  clear() {
    for (const entry of this.entries) {
      for (const actorId of entry.liveIds) this.scene.actorWorld.removeActor(actorId);
      entry.liveIds.clear();
    }
  }

  /**
   * 推进刷新时钟。每 tick 调一次，只在周期到点的那一次真的做事。
   * @param {number} deltaSeconds
   */
  advance(deltaSeconds) {
    if (!this.enabled) return;
    const step = Math.max(0, Math.min(Number(deltaSeconds) || 0, MAXIMUM_CATCH_UP_SECONDS));
    if (step <= 0) return;
    const players = [...this.scene.players.values()].filter(
      (player) => !player.getComponent(HEALTH_COMPONENT)?.dead,
    );
    for (const entry of this.entries) {
      entry.secondsUntilCycle -= step;
      if (entry.secondsUntilCycle > 0) continue;
      entry.secondsUntilCycle += entry.rule.cycleSeconds;
      this.runCycle(entry, players);
    }
  }

  /** 一个周期：先收走该走的，再按剩下的配额刷。 */
  runCycle(entry, players) {
    this.pruneAndDespawn(entry, players);
    if (players.length === 0) return;
    if (entry.rule.nightOnly && !this.isNight()) return;
    const cap = creatureCap(players.length, entry.rule.capPerPlayer, entry.rule.maximumPerRoom);
    // 尝试次数**不**随缺口放大：配额空着说明这一带刷不出来（水、建筑、太挤），
    // 那时该让刷新变稀，而不是让这一个周期把 CPU 花在同一片刷不出的地上。
    for (let attempt = 0; attempt < entry.rule.attemptsPerCycle; attempt += 1) {
      if (entry.liveIds.size >= cap) return;
      this.attemptSpawn(entry, players, cap);
    }
  }

  /** 一次刷新尝试：取一个候选点，过了全部判据就在那儿放下一小群。 */
  attemptSpawn(entry, players, cap) {
    const rule = entry.rule;
    const anchor = players[Math.floor(this.random() * players.length) % players.length];
    sampleSpawnPoint(
      anchor,
      rule.minimumDistance,
      rule.maximumDistance,
      this.random(),
      this.random(),
      this.scratchPoint,
    );
    const centerX = this.scratchPoint.x;
    const centerZ = this.scratchPoint.z;
    if (!this.canPlaceAt(entry, players, centerX, centerZ)) return;

    const packTotal = packSize(this.random(), 1, rule.packMaximum);
    for (let index = 0; index < packTotal; index += 1) {
      if (entry.liveIds.size >= cap) return;
      // 第一只落在刷新点上，同伴散在周围。**同伴各自再过一遍完整判据**，不是只
      // 沾队长的光：一群怪不该因为「队长站得下」就整队站进树里，也不该因为队长
      // 站在刷新区块的边上就把半群撒进旁边那个不出怪的 chunk。
      const x = index === 0 ? centerX : centerX + (this.random() * 2 - 1) * PACK_SCATTER_RADIUS;
      const z = index === 0 ? centerZ : centerZ + (this.random() * 2 - 1) * PACK_SCATTER_RADIUS;
      if (index > 0 && !this.canPlaceAt(entry, players, x, z)) continue;
      this.spawnOne(entry, x, this.scratchCell.y, z);
    }
  }

  /**
   * 一个具体的点能不能放下一只。
   *
   * 三条判据合在一处，因为刷新点和它的同伴走的必须是同一条：分成两套的那一刻，
   * 「刷出来的都在刷新区块里」这句话就不再成立，而它正是这套机制对玩家的承诺。
   * 通过时 `scratchCell` 里留着落地高度。
   */
  canPlaceAt(entry, players, x, z) {
    const rule = entry.rule;
    const { chunkX, chunkZ } = spawnChunkOf(x, z);
    // 出怪的地图和世界本身一样是种子的纯函数：那一片地一直出，另一片一直不出。
    if (!isCreatureChunk(this.scene.worldSeed, chunkX, chunkZ, rule.chunkOneIn, rule.chunkSalt)) {
      return false;
    }
    // 别在别人脸上刷。取候选点的圆环只排除了锚点玩家，这里管的是**其他**玩家。
    this.scratchPoint.x = x;
    this.scratchPoint.z = z;
    if (this.nearestPlayerDistance(this.scratchPoint, players) < rule.minimumDistance) return false;
    return canSpawnCreatureAt(entry.world, x, z, this.scratchCell);
  }

  /** 放下一只。id 带着规则名，调试时一眼看得出它是谁刷的。 */
  spawnOne(entry, x, y, z) {
    const scene = this.scene;
    const id = `spawn-${entry.rule.archetypeId}-${(scene.nextSpawnedCreatureId += 1).toString(36)}`;
    const actor = createServerActor({
      id,
      archetypeId: entry.archetype.id,
      localTransform: { position: [x, y, z], yaw: this.random() * Math.PI * 2 },
    }, entry.archetype);
    scene.actorWorld.addActor(actor);
    entry.liveIds.add(id);
    return actor;
  }

  /**
   * 收走已经不在的和该消失的。
   *
   * 「已经不在」指被打死之后 `HealthSystem` 收走的那些：配额必须跟着它们释放，
   * 否则打完一波之后房间就再也刷不出东西了。
   */
  pruneAndDespawn(entry, players) {
    for (const actorId of Array.from(entry.liveIds)) {
      const actor = this.scene.actorWorld.getActor(actorId);
      if (!actor) {
        entry.liveIds.delete(actorId);
        continue;
      }
      const transform = actor.getComponent(TRANSFORM_COMPONENT);
      const distance = transform
        ? this.nearestPlayerDistance(transform, players)
        : Number.POSITIVE_INFINITY;
      const verdict = despawnVerdict(
        distance,
        entry.rule.maximumDistance,
        this.random(),
        RANDOM_DESPAWN_CHANCE,
      );
      if (verdict === DESPAWN_VERDICT.KEEP) continue;
      this.scene.actorWorld.removeActor(actorId);
      entry.liveIds.delete(actorId);
    }
  }

  /** 没有玩家时是 Infinity——那正是「立刻消失」想要的输入。 */
  nearestPlayerDistance(point, players) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const player of players) {
      const distance = Math.hypot(player.x - point.x, player.z - point.z);
      if (distance < nearest) nearest = distance;
    }
    return nearest;
  }

  isNight() {
    const environment = this.scene.environment;
    // 昼夜没开的图上「夜里刷」永远不成立，而不是永远成立：一张停在正午的地图
    // 突然整天出怪，作者会以为是自己写错了配置。
    if (!environment?.dayNightEnabled) return false;
    return isNightWindow(environment.timeOfDay, NIGHT_FROM_HOUR, NIGHT_TO_HOUR);
  }

  /**
   * 把场景的几份权威数据包成刷新判据要的四个查询。
   *
   * 和寻路那一层同一条纪律：**不新建任何一份世界数据**。刷新看到的地形就是玩家
   * 走的地形，看到的建筑块就是玩家刚铺的那一块，塞不塞得下用的就是把玩家推开的
   * 那一份圆形推出。
   */
  createWorldQueries(footprint) {
    const scene = this.scene;
    return {
      cellCodeAt: scene.terrainCellCodeAt,
      hasBuildPieceAt: (cellX, cellZ) => scene.buildSites.isOccupied(STATIC_SURFACE_KEY, cellX, cellZ),
      groundHeightAt: (x, z) => scene.actorWorld.context.groundHeightAt?.(x, z),
      withinBounds: (x, z) => (
        x >= scene.bounds.minimumX && x <= scene.bounds.maximumX
        && z >= scene.bounds.minimumZ && z <= scene.bounds.maximumZ
      ),
      fits: (x, z, y) => {
        const resolved = scene.collision.resolveCircle({ x, z }, footprint.radius, {
          layers: COLLISION_LAYER.MOVEMENT,
          // 刷新不许「踩上去」：站得住要靠脚下这一格本身，不能靠迈上旁边那块石头。
          verticalProfile: {
            minimumY: y + footprint.minimumY,
            maximumY: y + footprint.maximumY,
            maximumStepHeight: 0,
          },
        });
        return Math.abs(resolved.x - x) < 1e-3 && Math.abs(resolved.z - z) < 1e-3;
      },
    };
  }
}
