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
import { selectWorldPropVariant } from '../../shared/world/worldPropVariants.mjs';
import { ChunkResidency } from '../scene/ChunkResidency.mjs';
import { createServerActor } from './ServerActorFactory.mjs';

const DEFAULT_RESIDENT_RADIUS = 2;

/**
 * 房间 DS 侧的世界生成物件 Actor 常驻策略。
 *
 * 树、石头这些可由客户端推导的采集物只同步偏离态；蘑菇一类会变化的交互对象则
 * 同步完整 Actor。两者都只在玩家附近进入 ActorWorld，不能让整个世界一次性常驻。
 *
 * 因此这里和静态碰撞用同一套 ChunkResidency：只保留玩家周围的物件，走远之后
 * 卸载。上界是玩家数 × (2 × keepRadius + 1)² 个 chunk 的物件，与世界面积无关。
 *
 * **residentRadius 不能小于原型的 replicationPolicy.radiusChunks。** AOI 之内
 * 的物件必须有 Actor，否则被采掉的那个没有快照条目，客户端会把它画回来。构造时
 * 直接从原型里取所有种类的最大值，避免两个半径各写一份之后悄悄失配。
 *
 * 哪一种物件可由哪些原型承载，来自场景的 `gameplay.worldProps`。每条放置记录
 * 再按房间种子与自身地址做带权选择，同一片林子因此可以混合普通树与果树；没有
 * 绑定的种类仍是纯布景，不产生 Actor。
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
   *   worldProps?: Record<string, Array<{ archetypeId: string, weight: number }>>,
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
    /** @type {Map<number, Array<{ archetype: { id: string, components: object }, weight: number }>>} */
    this.archetypeVariantsByKind = new Map();
    const archetypesById = new Map((options.archetypes ?? []).map((each) => [each.id, each]));
    let replicationRadius = 0;
    for (const [name, variants] of Object.entries(options.worldProps ?? {})) {
      const kind = PROP_KIND_BY_NAME[name];
      if (kind === undefined || !Array.isArray(variants)) continue;
      const resolved = [];
      for (const variant of variants) {
        const archetype = archetypesById.get(variant?.archetypeId);
        // 绑定的合法性在 SceneCatalog 就校验过了；这里只是不让一个坏配置炸在
        // 每一次 chunk 装载上。
        const isGeneratedActor = Boolean(
          archetype?.components.generatedProp || archetype?.components.elasticTether,
        );
        if (!isGeneratedActor || !Number.isInteger(variant?.weight)) continue;
        resolved.push({ archetype, weight: variant.weight });
        replicationRadius = Math.max(
          replicationRadius,
          archetype.components.replicationPolicy?.radiusChunks ?? 0,
        );
      }
      if (resolved.length > 0) this.archetypeVariantsByKind.set(kind, resolved);
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
      enabled: options.enabled !== false && this.archetypeVariantsByKind.size > 0,
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
    return this.archetypeVariantsByKind.get(kind)?.[0]?.archetype;
  }

  /**
   * @param {number} kind
   * @param {number} chunkX
   * @param {number} chunkZ
   * @param {number} propIndex
   */
  archetypeForProp(kind, chunkX, chunkZ, propIndex) {
    return selectWorldPropVariant(
      this.worldSeed,
      kind,
      chunkX,
      chunkZ,
      propIndex,
      this.archetypeVariantsByKind.get(kind) ?? [],
    )?.archetype;
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
      const archetype = this.archetypeForProp(kind, chunkX, chunkZ, propIndex);
      // 没有原型的种类是纯布景（草），不产生 Actor。
      if (!archetype) continue;
      const id = formatGeneratedPropId(kind, chunkX, chunkZ, propIndex);
      // 同一个 chunk 不会装两次，这里只防御 ensureAround 与 sync 的竞争。
      if (this.world.getActor(id)) continue;
      const generatedProp = archetype.components.generatedProp;
      // 只有可采集生成物有偏离态；完整复制的蘑菇始终从原型默认状态装载。
      const deviation = generatedProp
        ? this.takeLiveDeviation(id, elapsedSeconds)
        : undefined;
      const actor = createServerActor({
        id,
        archetypeId: archetype.id,
        localTransform: {
          position: [
            this.propBuffer[offset + PROP_FIELD.X_MM] / 1000,
            this.propBuffer[offset + PROP_FIELD.Y_MM] / 1000,
            this.propBuffer[offset + PROP_FIELD.Z_MM] / 1000,
          ],
          yaw: this.propBuffer[offset + PROP_FIELD.ROTATION_MRAD] / 1000,
        },
      }, archetype, generatedProp
        ? {
            // 完好的采集物由客户端从 chunk 记录推导，不进入常规完整快照。
            replicated: false,
            generatedProp: {
              kind,
              chunkX,
              chunkZ,
              propIndex,
              scale: this.propBuffer[offset + PROP_FIELD.SCALE_THOUSANDTHS] / 1000,
              ...deviation,
            },
          }
        : {
            // 蘑菇的交互状态会变化，必须走带 archetype/transform 的完整 Actor 快照。
            replicated: true,
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
