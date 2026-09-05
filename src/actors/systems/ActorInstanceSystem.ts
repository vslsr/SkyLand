import {
  ACTOR_RESIDENCY_COMPONENT,
  COMBUSTIBLE_COMPONENT,
  DROP_MOTION_COMPONENT,
  ITEM_STACK_COMPONENT,
  TRANSFORM_COMPONENT,
  type Actor,
  type ActorResidencyComponent,
  type ActorWorld,
  type CombustibleComponent,
  type DropMotionComponent,
  type ItemStackComponent,
  type TransformComponent,
} from '../../../shared/actor/index.mjs';
import {
  PROP_ARCHETYPE,
  PROP_BURNING,
  PROP_ID,
  PROP_RESIDENCY,
  PROP_SINGLE,
  residencyCode,
} from '../../render/propInstanceLayout';
import { RENDER_PROXY_COMPONENT } from '../components/RenderProxyComponent';
import { chewBodyOffset, chewFoodScale } from '../../player/chewAnimation';
import {
  InstanceIdTable,
  type RenderInstanceBuffer,
} from '../../render/RenderInstanceBuffer';

/**
 * 合批内容的实例表由哪些原型、按什么规则产出（实现路径文档 §3）。
 *
 * 渲染侧要的只有下标：哪个原型、哪种驻留态、烧没烧、是单个还是一堆。
 * 「哪些原型走合批」「数量为 1 时换模板」这两条是**玩法事实**，所以留在这一侧；
 * 那些下标怎么变成几何与材质，是渲染侧的事。
 */
export interface ActorInstanceCatalog {
  /** 原型 id → 下标。渲染侧用同一张表反查 render 定义。 */
  readonly archetypeIndex: ReadonlyMap<string, number>;
  /** 这个原型走不走合批。 */
  isBatched(archetypeId: string): boolean;
  /** 数量为 1 时是否换成「单个」模板（四件物品都有：一个就是一个）。 */
  supportsSingle(archetypeId: string): boolean;
  /**
   * 这个 Actor 正被吃到哪一步（[0, 1]）；没在被吃就是 undefined。
   *
   * 「谁正被吃」是玩法事实，所以由这一侧给出；这里只把它翻成一个位置偏移和一个
   * 缩放倍率。手上那件食物因此和嘴一起抖、一口口变小——两样都读
   * `chewAnimation` 那一份曲线，所以嚼在同一拍上。
   */
  chewRatioOf?(actorId: string): number | undefined;
}

/**
 * 把这一帧走合批的 Actor 摊进实例通道。
 *
 * 这个 System 和 `ActorTransformSystem` 是同一类东西：**只写字节，不 import three**。
 * 差别只在写的是哪一条通道——proxy 走 transform SoA，合批内容走实例表。
 */
export class ActorInstanceSystem {
  private readonly ids = new InstanceIdTable();
  private readonly live = new Set<string>();

  public constructor(
    private readonly instances: RenderInstanceBuffer,
    private readonly catalog: ActorInstanceCatalog,
  ) {}

  public update(world: ActorWorld, _deltaSeconds: number, _elapsedSeconds: number): void {
    this.instances.beginFrame();
    this.live.clear();
    for (const actor of world.query(TRANSFORM_COMPONENT, ITEM_STACK_COMPONENT) as Actor[]) {
      const archetypeIndex = this.catalog.archetypeIndex.get(actor.archetypeId);
      if (archetypeIndex === undefined || !this.catalog.isBatched(actor.archetypeId)) continue;
      // 已经有 proxy 的不再进合批：一个 Actor 要么是合批里的一个实例，要么是渲染
      // 世界里的一棵模型，两边都画就会看见两把弓叠在一起。会形变的手持物走的正是
      // 后一条（见 `ClientActorSystem` 的 `HAND_DEFORMED_MODELS`）。
      if (actor.getComponent(RENDER_PROXY_COMPONENT)) continue;
      const transform = actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent;
      const stack = actor.requireComponent(ITEM_STACK_COMPONENT) as ItemStackComponent;
      const residency = actor.getComponent(
        ACTOR_RESIDENCY_COMPONENT,
      ) as ActorResidencyComponent | undefined;
      const combustible = actor.getComponent(
        COMBUSTIBLE_COMPONENT,
      ) as CombustibleComponent | undefined;
      const motion = actor.getComponent(DROP_MOTION_COMPONENT) as DropMotionComponent | undefined;
      const single = this.catalog.supportsSingle(actor.archetypeId) && stack.quantity === 1;
      const chewRatio = this.catalog.chewRatioOf?.(actor.id);
      // 嘴上那件食物的世界坐标是权威给的，抖动是纯表现——所以抖动只加在写出去的
      // 这一帧上，不回写 Transform。
      const chew = chewRatio === undefined
        ? undefined
        : { offset: chewBodyOffset(chewRatio), scale: chewFoodScale(chewRatio) };
      this.live.add(actor.id);
      const integers = [0, 0, 0, 0, 0];
      integers[PROP_ARCHETYPE] = archetypeIndex;
      integers[PROP_RESIDENCY] = residencyCode(residency?.state);
      integers[PROP_BURNING] = combustible?.burning ? 1 : 0;
      integers[PROP_SINGLE] = single ? 1 : 0;
      integers[PROP_ID] = this.ids.acquire(actor.id);
      this.instances.push(integers, [
        transform.x + (chew?.offset.x ?? 0),
        transform.y + (chew?.offset.y ?? 0),
        transform.z + (chew?.offset.z ?? 0),
        transform.yaw,
        stack.quantity,
        // 只有「单个」形态才滚：一堆果子没有刚体姿态可言。
        single ? (motion?.radius ?? 0) : 0,
        chew?.scale ?? 1,
      ]);
    }
    // 离开视野的把号码还回去，下一个 Actor 复用——渲染侧的滚动状态按号码记账，
    // 所以这一步和 proxy 槽位回收是同一条不变量。
    this.ids.retainOnly(this.live);
  }

  public dispose(): void {
    this.ids.clear();
    this.live.clear();
  }
}
