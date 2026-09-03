import type { CollisionWorld } from '../../shared/collision/index.mjs';
import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import { createLineArtScene } from './createLineArtScene';
import type { SceneComposition } from './SceneVisualSystem';
import type { SceneWorld } from './SceneWorld';

/** 组合里属于渲染的那一半的接收方。`SceneRenderer` 实现它。 */
export interface SceneRenderHost {
  adoptComposition(composition: SceneComposition): void;
}

/**
 * 一局的**装配归属**（引擎迁移路线图 第 3 步）。
 *
 * 「建一张地图、把两半分别交出去、下一张来时按顺序拆掉」这件事曾经归
 * `SceneRenderer`：它有 `loadScene` / `showEmptyScene` / `replaceScene`，还自己留着
 * `collisionWorld` / `physicsWorld` / `terrainWorld` 三个引用去 `clear()` 和
 * `dispose()`。**一个叫渲染器的类在释放物理世界**——那就是装配归属没定下来的样子。
 *
 * 归属定在这里之后，canvas 那一侧只剩「接住渲染那一半」这一个动作。渲染循环搬进
 * worker 那天，动的是 `SceneRenderer`，这个类一个字都不用改：它认识的是
 * `SceneComposition` 这份数据和两个接收方，不认识 `THREE.Scene`，也不认识画布。
 *
 * 拆的顺序是有约束的，写在 `#replace` 里。
 */
export class SceneCompositionHost {
  #composition?: SceneComposition;
  #collision?: CollisionWorld;
  #physics?: PhysicsWorld;

  public constructor(
    private readonly world: SceneWorld,
    private readonly render: SceneRenderHost,
  ) {}

  /**
   * 加载一张地图。`worldSeed` 来自房间，决定流式世界长什么样；
   * 不做流式加载的场景会忽略它。
   */
  public load(definition: SceneDefinition, worldSeed?: number): void {
    if (definition.renderer.type !== 'line-art') {
      throw new Error(`不支持的场景渲染器：${definition.renderer.type as string}`);
    }
    this.#replace(createLineArtScene(definition, worldSeed), {
      // 「没有地面、只有海」是这张地图的玩法事实：脚下踩到的是水面高度。
      fixedWaterWorld: definition.renderer.content.ocean === true
        && definition.renderer.content.ground === false,
      fixedWaterLevel: definition.gameplay.water?.seaLevel ?? 0,
    });
  }

  /** 退回大厅背后那个什么都没有的场景。 */
  public clear(): void {
    // 没有 scene：空画面归渲染侧自己铺。这一层不认识 `THREE.Scene`。
    this.#replace({ visualSystems: [] }, { fixedWaterWorld: false, fixedWaterLevel: 0 });
    this.world.clear();
  }

  #replace(
    next: SceneComposition,
    water: { fixedWaterWorld: boolean; fixedWaterLevel: number },
  ): void {
    // 先停掉上一张地图的每帧动作，再动它们摸过的东西——顺序反了就会有 System
    // 在自己的资源被释放之后再跑一次。
    for (const system of this.#composition?.visualSystems ?? []) system.dispose?.();
    // 碰撞与物理随场景走：上一张地图的 chunk 与 Actor 碰撞体一起丢掉，
    // 不会有残留的盒子挡住新地图里的路。
    this.#collision?.clear();
    this.#physics?.dispose();

    this.#composition = next;
    this.#collision = next.collisionWorld;
    this.#physics = next.physicsWorld;
    this.world.adopt(next, water);
    this.render.adoptComposition(next);
  }
}
