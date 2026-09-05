import {
  Actor,
  BuoyancyComponent,
  PlayerMovementComponent,
} from '../../shared/actor/index.mjs';
import { GrassDisplacementComponent } from '../actors/components/GrassDisplacementComponent';
import type { GrassInteractionTarget } from '../grass';
import type { InterpolatedPlayerState } from '../network/protocol';
import type { ActorArchetypeDefinition } from '../scenes/data/SceneDefinition';
import type { ProxyId, RenderScene } from '../render/RenderScene';
import type { RenderProxyTable, RenderWorldHandle } from '../render/RenderProxyTable';
import type { RenderTransformBuffer } from '../render/RenderTransformBuffer';
import {
  SLIME_MOTION_AT_REST,
  writeSlimeMotionParams,
  type SlimeMotionParams,
} from '../render/RenderSlimeMotion';
import { PARAM_HEALTH_DEATH_REVISION } from '../render/RenderVisualParams';
import {
  createSlimeImpactParams,
  resolveSlimeImpactParams,
  writeSlimeImpactParams,
} from '../render/RenderSlimeImpact';
import {
  SLIME_DRAG_AT_REST,
  writeSlimeDragParams,
  type SlimeDragParams,
} from '../render/RenderSlimeDrag';
import {
  createSlimeBiteParams,
  writeSlimeBiteParams,
  type SlimeBiteParams,
} from '../render/RenderSlimeBite';
import {
  SLIME_GROUND_PROBE_AT_REST,
  resolveSlimeLegGroundProbeLayout,
  writeSlimeGroundProbeParams,
} from '../render/RenderSlimeLegs';
import { LegGroundProbeComponent } from '../actors/components/LegGroundProbeComponent';
import {
  isPlayerRenderDefinition,
  resolvePlayerVisualShape,
  type PlayerVisualShape,
} from './playerVisualShape';

/** 同房间的另一名玩家：位置来自快照插值；混合软体只做不回写状态的客户端表现。 */
export class RemotePlayer extends Actor {
  public name: string;
  private readonly proxyId: ProxyId;
  /** 槽位表既是分配器也是命令口：销毁和回收槽位必须是同一件事。 */
  private readonly proxyIds: RenderProxyTable;
  private readonly renderScene: RenderScene;
  private readonly transforms: RenderTransformBuffer;
  /** 玩法侧的 f64 权威副本；渲染侧那份是镜像。和本地玩家同一套结构。 */
  private readonly transform = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly motion: SlimeMotionParams = { ...SLIME_MOTION_AT_REST };
  /** 快照里那一次拖拽；玩法侧只是把它从网络搬到参数段，重放在渲染侧。 */
  private readonly drag: SlimeDragParams = { ...SLIME_DRAG_AT_REST };
  private readonly biteTips: SlimeBiteParams = createSlimeBiteParams();
  private readonly visual: PlayerVisualShape;
  private readonly buoyancy?: BuoyancyComponent;
  private speed = 0;
  /** 死亡计数，从快照来。0 表示活着；渲染侧靠它变化踢一次倒下动画。 */
  private deathRevision = 0;
  /** 别人挨的那一箭，同样是复制来的。 */
  private readonly impact = createSlimeImpactParams();
  private verticalVelocity = 0;
  private grounded = true;

  private readonly grassDisplacement: GrassDisplacementComponent;
  /** 只有长腿外壳才有；和本地玩家同一套采样窗口。 */
  private readonly legGroundProbe?: LegGroundProbeComponent;

  public constructor(
    state: InterpolatedPlayerState,
    private readonly grassInteraction: GrassInteractionTarget & {
      sampleGroundHeight?(x: number, z: number): number;
      samplePlayerHeight?(x: number, z: number, buoyancyDraft?: number): number;
    },
    archetype: ActorArchetypeDefinition,
    renderWorld: RenderWorldHandle,
  ) {
    super(state.id, archetype.id);
    const render = archetype.components.render;
    if (!archetype.components.playerMovement || !isPlayerRenderDefinition(render)) {
      throw new Error(`玩家 Actor 原型无效：${archetype.id}`);
    }
    const movement = this.addComponent(new PlayerMovementComponent(
      archetype.components.playerMovement,
    )) as PlayerMovementComponent;
    this.buoyancy = archetype.components.buoyancy
      ? this.addComponent(new BuoyancyComponent(archetype.components.buoyancy)) as BuoyancyComponent
      : undefined;
    this.name = state.name;
    this.visual = resolvePlayerVisualShape(render);
    this.renderScene = renderWorld.scene;
    this.transforms = renderWorld.transforms;
    // 配色种子就是玩家 id：过边界的是身份，不是六个颜色值——哪种身份配哪套颜色
    // 是渲染侧的决定。
    this.proxyIds = renderWorld.proxyIds;
    this.proxyId = this.proxyIds.acquire();
    this.renderScene.createPlayerProxy(this.proxyId, {
      name: `remote-player-${state.id}`,
      render,
      paletteSeed: state.id,
      walkSpeed: movement.walkSpeed,
    });
    if (render.model === 'line-art-legged-slime') {
      this.legGroundProbe = this.addComponent(new LegGroundProbeComponent(
        grassInteraction.sampleGroundHeight?.bind(grassInteraction),
        resolveSlimeLegGroundProbeLayout(render),
      )) as LegGroundProbeComponent;
    }
    this.transform.x = state.x;
    this.transform.y = state.y ?? this.sampleHeight(state.x, state.z);
    this.transform.z = state.z;
    this.transform.yaw = state.yaw;
    this.verticalVelocity = state.verticalVelocity ?? 0;
    this.grounded = state.grounded ?? true;
    this.publishRenderState();
    this.grassDisplacement = this.addComponent(new GrassDisplacementComponent(
      (out) => {
        out.x = this.transform.x;
        out.y = this.transform.y;
        out.z = this.transform.z;
      },
      grassInteraction,
      { radius: this.visual.radius * 1.65 },
    )) as GrassDisplacementComponent;
  }

  /** 本地物理世界里给这名远端玩家建代理时用的圆柱尺寸。 */
  public get collisionShape(): { radius: number, height: number } {
    return { radius: this.visual.collisionRadius, height: this.visual.collisionHeight };
  }

  /** 快照插值后的脚底位置，供碰撞代理跟随。 */
  public get feetPosition(): { x: number, y: number, z: number } {
    return { x: this.transform.x, y: this.transform.y, z: this.transform.z };
  }

  public applyState(state: InterpolatedPlayerState): void {
    this.name = state.name;
    // 位置与朝向都已经在 SnapshotBuffer 里按渲染时间插值过，这里直接落到 transform 上。
    this.transform.x = state.x;
    this.transform.y = state.y ?? this.sampleHeight(state.x, state.z);
    this.transform.z = state.z;
    this.transform.yaw = state.yaw;
    this.speed = state.speed;
    this.verticalVelocity = state.verticalVelocity ?? 0;
    this.grounded = state.grounded ?? (state.y === undefined);
    // 死了之后停下来：快照里的速度本来就会归零，但倒下那一段不该还在走路。
    this.deathRevision = state.health?.dead ? state.health.deathRevision : 0;
    // 中箭那一下：别人身上的凹陷也该看得见，判据同样是事件计数变了。
    resolveSlimeImpactParams(this.impact, state.health);
    // 松手后快照不再带这个字段，revision 回到 0 就是「没有人在拖」。
    this.drag.revision = state.slimeDrag?.revision ?? 0;
    this.drag.contactX = state.slimeDrag?.contactX ?? 0;
    this.drag.contactY = state.slimeDrag?.contactY ?? 0;
    this.drag.contactZ = state.slimeDrag?.contactZ ?? 0;
    this.drag.pullX = state.slimeDrag?.pullX ?? 0;
    this.drag.pullY = state.slimeDrag?.pullY ?? 0;
    this.drag.pullZ = state.slimeDrag?.pullZ ?? 0;
  }

  /** 正被谁咬着捏出来的那些尖，由 `RemotePlayerGroup` 按两边位置当场算。 */
  public setBiteTips(tips: ArrayLike<number>): void {
    this.biteTips.set(tips);
  }

  public update(deltaSeconds: number): void {
    // 远端玩家没有本地预测的速度向量，方向由插值出来的朝向推出来——
    // 和搬迁前那条 sin/cos 一样。
    this.motion.movementSpeed = this.speed;
    this.motion.movementVelocityX = Math.sin(this.transform.yaw) * this.speed;
    this.motion.movementVelocityZ = Math.cos(this.transform.yaw) * this.speed;
    this.motion.verticalVelocity = this.verticalVelocity;
    this.motion.airborne = this.grounded ? 0 : 1;
    this.publishRenderState();
    this.grassDisplacement.update(deltaSeconds);
  }

  private publishRenderState(): void {
    this.transforms.write(
      this.proxyId,
      this.transform.x,
      this.transform.y,
      this.transform.z,
      this.transform.yaw,
    );
    writeSlimeMotionParams(this.transforms, this.proxyId, this.motion);
    // 死亡计数：别人的死同样是复制来的，0 表示还活着。
    this.transforms.writeParam(this.proxyId, PARAM_HEALTH_DEATH_REVISION, this.deathRevision);
    writeSlimeImpactParams(this.transforms, this.proxyId, this.impact);
    writeSlimeDragParams(this.transforms, this.proxyId, this.drag);
    writeSlimeBiteParams(this.transforms, this.proxyId, this.biteTips);
    const legs = this.legGroundProbe;
    if (legs) {
      legs.refresh(this.transform.x, this.transform.y, this.transform.z);
    }
    // 没有腿的外壳也要每帧写静止值：槽位会被回收，残留的采样窗口会让下一位
    // 玩家的腿踩在别处的地面上。
    writeSlimeGroundProbeParams(
      this.transforms,
      this.proxyId,
      legs ? legs.probe : SLIME_GROUND_PROBE_AT_REST,
    );
  }

  private sampleHeight(x: number, z: number): number {
    if (this.buoyancy && this.grassInteraction.samplePlayerHeight) {
      return this.grassInteraction.samplePlayerHeight(x, z, this.buoyancy.draft);
    }
    return this.grassInteraction.sampleGroundHeight?.(x, z) ?? 0;
  }

  public override dispose(): void {
    super.dispose();
    this.proxyIds.destroyMeshProxy(this.proxyId);
  }
}
