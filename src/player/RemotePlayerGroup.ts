import type { GrassInteractionTarget } from '../grass';
import type { InterpolatedPlayerState } from '../network/protocol';
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import type { ActorArchetypeDefinition } from '../scenes/data/SceneDefinition';
import type { RenderScene } from '../render/RenderScene';
import type { RenderTransformBuffer } from '../render/RenderTransformBuffer';
import { RemotePlayer } from './RemotePlayer';
import { collectBiters, resolveBiteTips } from './slimeBiteTip';
import { createSlimeBiteParams, type SlimeBiteParams } from '../render/RenderSlimeBite';
import {
  RemotePlayerColliders,
  type RemotePlayerColliderState,
} from './RemotePlayerColliders';

/**
 * 远端玩家集合：按快照增删改，本地玩家由 PlayerEntity 单独负责。
 *
 * 这里以前有一个自己的 `THREE.Group` 装所有远端玩家的模型。现在每名远端玩家
 * 都是渲染世界里的一个 proxy，所以这个类不再持有任何场景图节点——
 * 它只是一张 id → RemotePlayer 的表。
 */
export class RemotePlayerGroup {
  private readonly players = new Map<string, RemotePlayer>();
  /** 每帧复用的突起向量缓冲，算完就写进各自的参数段。 */
  private readonly biteTips: SlimeBiteParams = createSlimeBiteParams();
  /** 调用方没给「谁咬着谁」时自己建一张，同样复用不重新分配。 */
  private readonly biters = new Map<string, InterpolatedPlayerState[]>();
  private archetype?: ActorArchetypeDefinition;
  private colliders?: RemotePlayerColliders;
  private renderWorld?: { scene: RenderScene; transforms: RenderTransformBuffer };

  public constructor(private readonly grassInteraction: GrassInteractionTarget & {
    sampleGroundHeight?(x: number, z: number): number;
    samplePlayerHeight?(x: number, z: number, buoyancyDraft?: number): number;
    getPhysicsWorld?(): PhysicsWorld | undefined;
  }) {}

  /** 换场景时重新绑定：proxy 属于某一张地图的渲染世界，不能跨地图留着。 */
  public setRenderWorld(
    renderWorld: { scene: RenderScene; transforms: RenderTransformBuffer } | undefined,
  ): void {
    if (this.renderWorld === renderWorld) return;
    this.clear();
    this.renderWorld = renderWorld;
  }

  public get size(): number {
    return this.players.size;
  }

  public configure(archetype: ActorArchetypeDefinition): void {
    if (this.archetype?.id !== archetype.id) this.clear();
    this.archetype = archetype;
  }

  public sync(
    states: InterpolatedPlayerState[],
    localPlayerId?: string,
    biters?: ReadonlyMap<string, InterpolatedPlayerState[]>,
  ): void {
    const archetype = this.archetype;
    const renderWorld = this.renderWorld;
    if (!archetype || !renderWorld) return;
    const seen = new Set<string>();
    // 「谁咬着谁」是快照里唯一和咬有关的字段；尖是各客户端按这一帧的插值位置
    // 自己算的，所以不用多下发六个数，也不会比位置慢一个快照。
    const biterOf = biters ?? collectBiters(states, this.biters);

    for (const state of states) {
      if (state.id === localPlayerId) continue;
      seen.add(state.id);
      const existing = this.players.get(state.id) ?? new RemotePlayer(
        state,
        this.grassInteraction,
        archetype,
        renderWorld,
      );
      if (this.players.has(state.id)) existing.applyState(state);
      else this.players.set(state.id, existing);
      existing.setBiteTips(resolveBiteTips(state, biterOf.get(state.id), archetype, this.biteTips));
    }

    for (const [id, player] of this.players) {
      if (seen.has(id)) continue;
      player.dispose();
      this.players.delete(id);
    }

    // 本地预测要撞得到别人，否则贴身时每份快照都会把玩家拉回来一次。
    this.syncColliders();
  }

  /** 代理尺寸取自当前原型，所以第一名远端玩家出现之后才建得起来。 */
  private syncColliders(): void {
    const first: RemotePlayer | undefined = this.players.values().next().value;
    if (!this.colliders) {
      if (!first) return;
      this.colliders = new RemotePlayerColliders(
        this.grassInteraction.getPhysicsWorld?.(),
        first.collisionShape,
      );
    }
    const states: RemotePlayerColliderState[] = [];
    for (const [id, player] of this.players) states.push({ id, ...player.feetPosition });
    this.colliders.sync(states);
  }

  public update(deltaSeconds: number): void {
    for (const player of this.players.values()) player.update(deltaSeconds);
  }

  public clear(): void {
    for (const player of this.players.values()) player.dispose();
    this.players.clear();
    this.colliders?.clear();
    // 换原型会换碰撞尺寸，代理连同它缓存的形状一起重建。
    this.colliders = undefined;
  }
}
