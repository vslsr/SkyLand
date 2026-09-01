import {
  GENERATED_PROP_COMPONENT,
  INTERACTABLE_COMPONENT,
  REPLICATED_COMPONENT,
  ReplicatedComponent,
} from '../../shared/actor/index.mjs';
import {
  PROP_BUFFER_LENGTH,
  PROP_FIELD,
  PROP_STRIDE,
  generateChunkProps,
} from '../../shared/world/chunkContent.mjs';
import {
  PROP_KIND_BY_NAME,
  formatGeneratedPropId,
} from '../../shared/world/generatedProp.mjs';
import { toWorldSeed } from '../../shared/world/worldConfig.mjs';
import { ChunkResidency } from '../scene/ChunkResidency.mjs';
import { createServerActor } from './ServerActorFactory.mjs';

const DEFAULT_RESIDENT_RADIUS = 2;

/**
 * 房间 DS 侧的世界生成物件 Actor 常驻策略。
 *
 * 树、石头这些由世界种子确定性推导的东西和静态碰撞体一样，一个字节都不用同步。
 * 但它们可交互，所以必须以 Actor 的形式存在于 ActorWorld 里——而整个世界有约
 * 2000 棵树和 900 块石头，全部常驻的话每一个按 Component 查询的 System 都要为
 * 它们付钱：`TemperatureSystem` 的热源收集就是 `query(transform)`。
 *
 * 因此这里和静态碰撞用同一套 ChunkResidency：只保留玩家周围的物件，走远之后
 * 卸载。上界是玩家数 × (2 × keepRadius + 1)² 个 chunk 的物件，与世界面积无关。
 *
 * **residentRadius 不能小于原型的 replicationPolicy.radiusChunks。** AOI 之内
 * 的物件必须有 Actor，否则被采掉的那个没有快照条目，客户端会把它画回来。构造时
 * 直接从原型里取所有种类的最大值，避免两个半径各写一份之后悄悄失配。
 *
 * 哪一种物件由哪个原型承载，来自场景的 `gameplay.worldProps`：同一棵树在不同
 * 地图上可以是不同的玩法对象，而原型只描述「它是什么」。这里把那份绑定解析成
 * 一张 kind → archetype 的表，没有绑定的种类就是纯布景，不产生 Actor。
 *
 * 卸载时把偏离默认生成结果的物件（采过一半、已采完、或者还在冷却）记进
 * deviations，重新装载时恢复。没被动过的物件不占任何状态内存，所以状态量跟着
 * 「玩家改动过多少个」走，而不是跟着世界里有多少个走。
 *
 * 可再生物件的冷却用绝对服务端时间记，卸载期间不需要任何逐 tick 计时：装回来
 * 时比一次 readyAt 就知道长回来没有，长回来的直接丢掉记录，回到「没被动过」。
 */
export class ServerGeneratedPropActors {
  /**
   * @param {{
   *   world: import('../../shared/actor/ActorWorld.mjs').ActorWorld,
   *   archetypes?: ReadonlyArray<{ id: string, components: object }>,
   *   worldProps?: Record<string, string>,
   *   worldSeed?: number,
   *   enabled?: boolean,
   *   residentRadius?: number,
   *   keepRadius?: number,
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    this.world = options.world;
    this.worldSeed = toWorldSeed(options.worldSeed);
    /** 绝对服务端秒数，冷却结算用的就是它。 */
    this.now = options.now ?? (() => Date.now() / 1000);
    /** @type {Map<number, { id: string, components: object }>} 物件种类 → 承载它的原型。 */
    this.archetypesByKind = new Map();
    const archetypesById = new Map((options.archetypes ?? []).map((each) => [each.id, each]));
    let replicationRadius = 0;
    for (const [name, archetypeId] of Object.entries(options.worldProps ?? {})) {
      const kind = PROP_KIND_BY_NAME[name];
      const archetype = archetypesById.get(archetypeId);
      // 绑定的合法性在 SceneCatalog 就校验过了；这里只是不让一个坏配置炸在
      // 每一次 chunk 装载上。
      if (kind === undefined || !archetype?.components.generatedProp) continue;
      this.archetypesByKind.set(kind, archetype);
      replicationRadius = Math.max(
        replicationRadius,
        archetype.components.replicationPolicy?.radiusChunks ?? 0,
      );
    }
    const residentRadius = Math.max(
      options.residentRadius ?? DEFAULT_RESIDENT_RADIUS,
      replicationRadius,
    );
    /** @type {Map<string, string[]>} chunk key → 该 chunk 装载出来的 Actor id。 */
    this.actorIdsByChunk = new Map();
    /** @type {Map<string, { health: number, removed: boolean, readyAt: number, revision: number }>} */
    this.deviations = new Map();
    /** 放置记录缓冲区复用，避免每装载一个 chunk 都新建一次。 */
    this.propBuffer = new Int32Array(PROP_BUFFER_LENGTH);
    this.residency = new ChunkResidency({
      enabled: options.enabled !== false && this.archetypesByKind.size > 0,
      residentRadius,
      keepRadius: options.keepRadius ?? residentRadius + 1,
      onLoad: (chunkX, chunkZ, key) => this.mountChunk(chunkX, chunkZ, key),
      onUnload: (key) => this.unmountChunk(key),
    });
  }

  get enabled() {
    return this.residency.enabled;
  }

  get residentRadius() {
    return this.residency.residentRadius;
  }

  get keepRadius() {
    return this.residency.keepRadius;
  }

  get residentChunkCount() {
    return this.residency.residentCount;
  }

  /** 当前真正存在于 ActorWorld 里的生成物件数量。 */
  get residentActorCount() {
    let count = 0;
    for (const actorIds of this.actorIdsByChunk.values()) count += actorIds.length;
    return count;
  }

  /** 被玩家改动过、需要跨卸载保留的物件数量。 */
  get deviationCount() {
    return this.deviations.size;
  }

  /** @param {number} kind */
  archetypeForKind(kind) {
    return this.archetypesByKind.get(kind);
  }

  /** @param {number} x @param {number} z */
  ensureAround(x, z) {
    this.residency.ensureAround(x, z);
  }

  /** @param {Iterable<{ x: number, z: number }>} focuses */
  sync(focuses) {
    this.residency.sync(focuses);
  }

  /** 房间清空或场景重置：卸掉全部常驻物件，偏离态一并丢弃。 */
  clear() {
    this.residency.clear();
    this.deviations.clear();
  }

  /** @param {number} chunkX @param {number} chunkZ @param {string} key */
  mountChunk(chunkX, chunkZ, key) {
    const propCount = generateChunkProps(this.worldSeed, chunkX, chunkZ, this.propBuffer);
    const elapsedSeconds = this.now();
    const actorIds = [];
    for (let propIndex = 0; propIndex < propCount; propIndex += 1) {
      const offset = propIndex * PROP_STRIDE;
      const kind = this.propBuffer[offset + PROP_FIELD.KIND];
      const archetype = this.archetypesByKind.get(kind);
      // 没有原型的种类是纯布景（草），不产生 Actor。
      if (!archetype) continue;
      const id = formatGeneratedPropId(kind, chunkX, chunkZ, propIndex);
      // 同一个 chunk 不会装两次，这里只防御 ensureAround 与 sync 的竞争。
      if (this.world.getActor(id)) continue;
      // 卸载期间长回来的，装载这一刻就把记录丢掉，回到「没被动过」。
      const deviation = this.takeLiveDeviation(id, elapsedSeconds);
      const actor = createServerActor({
        id,
        archetypeId: archetype.id,
        localTransform: {
          position: [
            this.propBuffer[offset + PROP_FIELD.X_MM] / 1000,
            0,
            this.propBuffer[offset + PROP_FIELD.Z_MM] / 1000,
          ],
          yaw: this.propBuffer[offset + PROP_FIELD.ROTATION_MRAD] / 1000,
        },
      }, archetype, {
        replicated: false,
        generatedProp: {
          kind,
          chunkX,
          chunkZ,
          propIndex,
          scale: this.propBuffer[offset + PROP_FIELD.SCALE_THOUSANDTHS] / 1000,
          ...deviation,
        },
      });
      if (deviation) {
        // 偏离态必须立刻可复制：AOI 里的客户端要靠这一条把物件从世界里抹掉，
        // 否则重新走回这一片时它会原地长回来。
        actor.addComponent(new ReplicatedComponent());
        if (deviation.removed) {
          const interactable = actor.getComponent(INTERACTABLE_COMPONENT);
          if (interactable) interactable.enabled = false;
        }
      }
      this.world.addActor(actor);
      actorIds.push(id);
    }
    this.actorIdsByChunk.set(key, actorIds);
  }

  /** @param {string} key */
  unmountChunk(key) {
    const actorIds = this.actorIdsByChunk.get(key);
    if (!actorIds) return;
    this.actorIdsByChunk.delete(key);
    for (const actorId of actorIds) {
      const actor = this.world.getActor(actorId);
      if (!actor) continue;
      this.captureDeviation(actor);
      this.world.removeActor(actorId);
    }
  }

  /**
   * 记下一个物件偏离默认生成结果的部分。完好无损的什么都不记，
   * 所以状态量与「被动过的物件」成正比，而不是与世界里的物件成正比。
   * @param {import('../../shared/actor/Actor.mjs').Actor} actor
   */
  captureDeviation(actor) {
    const prop = actor.getComponent(GENERATED_PROP_COMPONENT);
    if (!prop) return;
    if (prop.isPristine(this.now())) {
      this.deviations.delete(actor.id);
      return;
    }
    this.deviations.set(actor.id, {
      health: prop.health,
      removed: prop.removed,
      readyAt: prop.readyAt,
      revision: prop.revision,
    });
  }

  /**
   * 取出仍然有效的偏离态。冷却已经过去的记录在这里被丢掉——这就是「长回来」
   * 的全部实现：没有定时器，没有逐 tick 扫描，只有装载时的一次比较。
   * @param {string} actorId
   * @param {number} elapsedSeconds
   */
  takeLiveDeviation(actorId, elapsedSeconds) {
    const deviation = this.deviations.get(actorId);
    if (!deviation) return undefined;
    const regrown = !deviation.removed
      && deviation.readyAt > 0
      && elapsedSeconds >= deviation.readyAt;
    if (!regrown) return deviation;
    this.deviations.delete(actorId);
    return undefined;
  }

  /**
   * 采集等改动发生时立即登记，不必等到卸载。
   * 这样即使 Actor 被别的路径移除，偏离态也不会丢。
   * @param {import('../../shared/actor/Actor.mjs').Actor} actor
   */
  recordDeviation(actor) {
    if (!actor.hasComponents(REPLICATED_COMPONENT)) actor.addComponent(new ReplicatedComponent());
    this.captureDeviation(actor);
  }
}
