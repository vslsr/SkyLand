import {
  GENERATED_PROP_COMPONENT,
  INTERACTABLE_COMPONENT,
  TRANSFORM_COMPONENT,
  type Actor,
  type ActorWorld,
  type GeneratedPropComponent,
  type InteractableComponent,
  type TransformComponent,
} from '../../../shared/actor/index.mjs';
import {
  FRUIT_COUNT,
  FRUIT_SCALE,
  FRUIT_X,
  FRUIT_Y,
  FRUIT_YAW,
  FRUIT_Z,
} from '../../render/fruitInstanceLayout';
import type { RenderInstanceBuffer } from '../../render/RenderInstanceBuffer';

/** 哪些原型会结果子。和合批那张表一样，这是玩法事实，留在这一侧。 */
export interface FruitTreeCatalog {
  bearsFruit(archetypeId: string): boolean;
}

/**
 * 把这一帧「结着果子的树」摊进果实实例通道（实现路径文档 §3）。
 *
 * 拆出这个 System 的理由不只是「渲染侧不该扫 ActorWorld」——原来那份代码在
 * 渲染系统里**写玩法状态**：
 *
 * ```
 * if (interactable) interactable.enabled = isReady;   // 渲染系统改交互开关
 * ```
 *
 * 冷却中的树不能采，这是规则，不是画法。判熟与开关交互提示因此整个留在这一侧，
 * 渲染侧只收到「这棵树在哪、多大、结几个」。
 *
 * 熟没熟由**绝对服务端时间**决定（`GeneratedPropComponent.readyAt` 直接从快照
 * 复制过来），所以时钟要由外面喂进来——ActorWorld 的 `elapsedSeconds` 是客户端
 * 本地的，对不上。
 */
export class ActorFruitInstanceSystem {
  public constructor(
    private readonly instances: RenderInstanceBuffer,
    private readonly catalog: FruitTreeCatalog,
    /** 换算过的服务端秒数；还没收到快照时返回 undefined。 */
    private readonly serverSeconds: () => number | undefined,
  ) {}

  public update(world: ActorWorld, _deltaSeconds: number, _elapsedSeconds: number): void {
    this.instances.beginFrame();
    // 还没收到快照时一律按「熟了」处理，避免刚进场那一瞬间满树果子闪一下才出现。
    const now = this.serverSeconds();
    for (const actor of world.query(TRANSFORM_COMPONENT, GENERATED_PROP_COMPONENT) as Actor[]) {
      if (!this.catalog.bearsFruit(actor.archetypeId)) continue;
      const prop = actor.requireComponent(GENERATED_PROP_COMPONENT) as GeneratedPropComponent;
      if (prop.dropSpawnPattern !== 'fruit-anchors') continue;
      const isReady = now === undefined || prop.isReady(now);
      // 冷却中的树没有可采的东西，交互提示也跟着关掉。
      const interactable = actor.getComponent(
        INTERACTABLE_COMPONENT,
      ) as InteractableComponent | undefined;
      if (interactable) interactable.enabled = isReady;
      if (!isReady) continue;
      const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
      const floats = [0, 0, 0, 0, 0, 0];
      floats[FRUIT_X] = transform.x;
      floats[FRUIT_Y] = transform.y;
      floats[FRUIT_Z] = transform.z;
      floats[FRUIT_YAW] = transform.yaw;
      floats[FRUIT_SCALE] = prop.scale;
      floats[FRUIT_COUNT] = prop.dropQuantity;
      this.instances.push([], floats);
    }
  }
}
