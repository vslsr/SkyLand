import {
  GENERATED_TREE_COMPONENT,
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
import { formatGeneratedTreeId } from '../../shared/world/generatedTree.mjs';
import { PROP_KIND, toWorldSeed } from '../../shared/world/worldConfig.mjs';
import { ChunkResidency } from '../scene/ChunkResidency.mjs';
import { createServerActor } from './ServerActorFactory.mjs';

const DEFAULT_RESIDENT_RADIUS = 2;

/**
 * 房间 DS 侧的生成树 Actor 常驻策略。
 *
 * 树和静态碰撞体一样由世界种子确定性推导，一个字节都不用同步。但树是可交互
 * 的，所以它必须以 Actor 的形式存在于 ActorWorld 里——而整个世界有约 2000
 * 棵，全部常驻的话每一个按 Component 查询的 System 都要为它们付钱：
 * `TemperatureSystem` 的热源收集就是 `query(transform)`，10 Hz 扫全世界的树。
 *
 * 因此这里和静态碰撞用同一套 ChunkResidency：只保留玩家周围的树，走远之后
 * 卸载。上界是玩家数 × (2 × keepRadius + 1)² 个 chunk 的树，与世界面积无关。
 *
 * **residentRadius 不能小于原型的 replicationPolicy.radiusChunks。** AOI 之内
 * 的树必须有 Actor，否则被砍倒的树没有快照条目，客户端会把它画回来。构造时
 * 直接从原型里取，避免两个半径各写一份之后悄悄失配。
 *
 * 卸载时把偏离默认生成结果的树（砍过一半或已倒下）记进 deviations，重新装载
 * 时恢复。没被动过的树不占任何状态内存，所以状态量跟着「玩家改动过多少棵树」
 * 走，而不是跟着世界里有多少棵树走。
 */
export class ServerGeneratedTreeActors {
  /**
   * @param {{
   *   world: import('../../shared/actor/ActorWorld.mjs').ActorWorld,
   *   archetype?: { id: string, components: object },
   *   worldSeed?: number,
   *   enabled?: boolean,
   *   residentRadius?: number,
   *   keepRadius?: number,
   * }} options
   */
  constructor(options) {
    this.world = options.world;
    this.archetype = options.archetype;
    this.worldSeed = toWorldSeed(options.worldSeed);
    const enabled = options.enabled !== false && Boolean(this.archetype?.components.generatedTree);
    // 复制半径决定了「哪些树的状态必须能进快照」，常驻半径不能比它小。
    const replicationRadius = this.archetype?.components.replicationPolicy?.radiusChunks ?? 0;
    const residentRadius = Math.max(
      options.residentRadius ?? DEFAULT_RESIDENT_RADIUS,
      replicationRadius,
    );
    /** @type {Map<string, string[]>} chunk key → 该 chunk 装载出来的 Actor id。 */
    this.actorIdsByChunk = new Map();
    /** @type {Map<string, { health: number, removed: boolean, revision: number }>} */
    this.deviations = new Map();
    /** 放置记录缓冲区复用，避免每装载一个 chunk 都新建一次。 */
    this.propBuffer = new Int32Array(PROP_BUFFER_LENGTH);
    this.residency = new ChunkResidency({
      enabled,
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

  /** 当前真正存在于 ActorWorld 里的生成树数量。 */
  get residentActorCount() {
    let count = 0;
    for (const actorIds of this.actorIdsByChunk.values()) count += actorIds.length;
    return count;
  }

  /** 被玩家改动过、需要跨卸载保留的树数量。 */
  get deviationCount() {
    return this.deviations.size;
  }

  /** @param {number} x @param {number} z */
  ensureAround(x, z) {
    this.residency.ensureAround(x, z);
  }

  /** @param {Iterable<{ x: number, z: number }>} focuses */
  sync(focuses) {
    this.residency.sync(focuses);
  }

  /** 房间清空或场景重置：卸掉全部常驻树，偏离态一并丢弃。 */
  clear() {
    this.residency.clear();
    this.deviations.clear();
  }

  /** @param {number} chunkX @param {number} chunkZ @param {string} key */
  mountChunk(chunkX, chunkZ, key) {
    const propCount = generateChunkProps(this.worldSeed, chunkX, chunkZ, this.propBuffer);
    const actorIds = [];
    for (let propIndex = 0; propIndex < propCount; propIndex += 1) {
      const offset = propIndex * PROP_STRIDE;
      if (this.propBuffer[offset + PROP_FIELD.KIND] !== PROP_KIND.TREE) continue;
      const id = formatGeneratedTreeId(chunkX, chunkZ, propIndex);
      // 同一个 chunk 不会装两次，这里只防御 ensureAround 与 sync 的竞争。
      if (this.world.getActor(id)) continue;
      const deviation = this.deviations.get(id);
      const actor = createServerActor({
        id,
        archetypeId: this.archetype.id,
        localTransform: {
          position: [
            this.propBuffer[offset + PROP_FIELD.X_MM] / 1000,
            0,
            this.propBuffer[offset + PROP_FIELD.Z_MM] / 1000,
          ],
          yaw: this.propBuffer[offset + PROP_FIELD.ROTATION_MRAD] / 1000,
        },
      }, this.archetype, {
        replicated: false,
        generatedTree: {
          chunkX,
          chunkZ,
          propIndex,
          scale: this.propBuffer[offset + PROP_FIELD.SCALE_THOUSANDTHS] / 1000,
          ...deviation,
        },
      });
      if (deviation) {
        // 偏离态必须立刻可复制：AOI 里的客户端要靠这一条把树从世界里抹掉，
        // 否则重新走回这一片时树会原地长回来。
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
   * 记下一棵树偏离默认生成结果的部分。完好无损的树什么都不记，
   * 所以状态量与「被动过的树」成正比，而不是与世界里的树成正比。
   * @param {import('../../shared/actor/Actor.mjs').Actor} actor
   */
  captureDeviation(actor) {
    const tree = actor.getComponent(GENERATED_TREE_COMPONENT);
    if (!tree) return;
    if (!tree.removed && tree.health >= tree.maximumHealth) {
      this.deviations.delete(actor.id);
      return;
    }
    this.deviations.set(actor.id, {
      health: tree.health,
      removed: tree.removed,
      revision: tree.revision,
    });
  }

  /**
   * 砍伐等改动发生时立即登记，不必等到卸载。
   * 这样即使 Actor 被别的路径移除，偏离态也不会丢。
   * @param {import('../../shared/actor/Actor.mjs').Actor} actor
   */
  recordDeviation(actor) {
    if (!actor.hasComponents(REPLICATED_COMPONENT)) actor.addComponent(new ReplicatedComponent());
    this.captureDeviation(actor);
  }
}
