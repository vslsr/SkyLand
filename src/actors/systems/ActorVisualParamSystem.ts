import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import {
  TRANSFORM_COMPONENT,
  type TransformComponent,
} from '../../../shared/actor/components/TransformComponent.mjs';
import type { RenderTransformBuffer } from '../../render/RenderTransformBuffer';
import {
  SLIME_MOTION_AT_REST,
  writeSlimeMotionParams,
} from '../../render/RenderSlimeMotion';
import {
  SLIME_GROUND_PROBE_AT_REST,
  writeSlimeGroundProbeParams,
} from '../../render/RenderSlimeLegs';
import {
  PARAM_BUOYANCY_DRAFT,
  PARAM_BUOYANCY_STATIC_PITCH,
  PARAM_BUOYANCY_STATIC_ROLL,
  PARAM_DROP_RADIUS,
  PARAM_DROP_ROTATION_W,
  PARAM_DROP_ROTATION_X,
  PARAM_DROP_ROTATION_Y,
  PARAM_DROP_ROTATION_Z,
  PARAM_ELASTIC_DETACH_LENGTH,
  PARAM_ELASTIC_DETACHED,
  PARAM_ELASTIC_HELD,
  PARAM_ELASTIC_RELEASE_REVISION,
  PARAM_ELASTIC_TARGET_X,
  PARAM_ELASTIC_TARGET_Y,
  PARAM_ELASTIC_TARGET_Z,
  PARAM_FIRE_TARGET_INTENSITY,
  PARAM_TEMPERATURE,
  RENDER_VISUAL_PARAM_COUNT,
} from '../../render/RenderVisualParams';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../components/RenderProxyComponent';
import {
  LEG_GROUND_PROBE_COMPONENT,
  type LegGroundProbeComponent,
} from '../components/LegGroundProbeComponent';
import {
  FIRE_VISUAL_COMPONENT,
  type FireVisualComponent,
} from '../components/FireVisualComponent';
import {
  BUOYANCY_COMPONENT,
  type BuoyancyComponent,
  DROP_MOTION_COMPONENT,
  type DropMotionComponent,
  ELASTIC_DETACH_COMPONENT,
  type ElasticDetachComponent,
  ELASTIC_TETHER_COMPONENT,
  type ElasticTetherComponent,
  TEMPERATURE_COMPONENT,
  type TemperatureComponent,
} from '../../../shared/actor/index.mjs';

/**
 * 把玩法侧决定的表现参数写进边界（引擎迁移路线图 第 1.5 步）。
 *
 * 和 `ActorTransformSystem` 一样，这个文件不 import three——它只写字节。
 *
 * **每帧写满所有存活槽位**，包括没有火焰的 Actor（写 0）。这是刻意的：
 * `ThreeRenderScene` 销毁 proxy 后会立刻把槽位还给 freeSlots 供复用，
 * 参数段若只在「值变化时」写，复用槽位的新 proxy 就会读到上一个 proxy 的火焰
 * 强度。逐帧写满让参数段沿用 transform 段已有的那条不变量，不需要另立一条
 * 「谁负责清零」的规则。
 *
 * 必须排在 `RenderTransformSyncSystem` 之前——参数要和 transform 同一次翻面。
 */
export class ActorVisualParamSystem {
  public constructor(private readonly transforms: RenderTransformBuffer) {}

  public update(world: ActorWorld, _deltaSeconds: number, _elapsedSeconds: number): void {
    for (const actor of world.query(RENDER_PROXY_COMPONENT) as Actor[]) {
      const proxy = actor.requireComponent(RENDER_PROXY_COMPONENT) as RenderProxyComponent;
      const fire = actor.getComponent(FIRE_VISUAL_COMPONENT) as FireVisualComponent | undefined;
      this.transforms.writeParam(
        proxy.proxyId,
        PARAM_FIRE_TARGET_INTENSITY,
        fire ? fire.targetIntensity : 0,
      );
      const temperature = actor.getComponent(
        TEMPERATURE_COMPONENT,
      ) as TemperatureComponent | undefined;
      this.transforms.writeParam(
        proxy.proxyId,
        PARAM_TEMPERATURE,
        temperature ? temperature.temperature : 0,
      );
      // Replica 的史莱姆不自己走路——服务端不复制运动演示，它们静止在原地
      // 摆动。运动参数由玩家实体自己写（它们不是 Replica，不经过这个 System），
      // 所以这里写的是静止值，而不是「跳过不写」：槽位会被复用，上一个玩家
      // 留下的速度会让新 proxy 一出生就在滑行。
      writeSlimeMotionParams(this.transforms, proxy.proxyId, SLIME_MOTION_AT_REST);
      this.writeGroundProbe(actor, proxy);
      this.writeBuoyancy(actor, proxy);
      this.writeElastic(actor, proxy);
      this.writeDropMotion(actor, proxy);
    }
  }

  /**
   * 腿部落脚的地面窗口。只有带 `LegGroundProbeComponent` 的 Actor 会真的去采地形，
   * 因此每帧的地形采样次数正比于「长腿的 Actor 数」，而不是全部 Replica。
   * 其余槽位写静止值（radius=0，渲染侧据此退回自己的兜底平面）。
   */
  private writeGroundProbe(actor: Actor, proxy: RenderProxyComponent): void {
    const legs = actor.getComponent(
      LEG_GROUND_PROBE_COMPONENT,
    ) as LegGroundProbeComponent | undefined;
    if (!legs) {
      writeSlimeGroundProbeParams(this.transforms, proxy.proxyId, SLIME_GROUND_PROBE_AT_REST);
      return;
    }
    const transform = actor.getComponent(TRANSFORM_COMPONENT) as TransformComponent | undefined;
    if (transform) legs.refresh(transform.x, transform.y, transform.z);
    writeSlimeGroundProbeParams(this.transforms, proxy.proxyId, legs.probe);
  }

  /** 船体波动只要三个静态偏置；浪高由渲染侧自己采。 */
  private writeBuoyancy(actor: Actor, proxy: RenderProxyComponent): void {
    const buoyancy = actor.getComponent(BUOYANCY_COMPONENT) as BuoyancyComponent | undefined;
    this.transforms.writeParam(proxy.proxyId, PARAM_BUOYANCY_DRAFT, buoyancy?.draft ?? 0);
    this.transforms.writeParam(
      proxy.proxyId,
      PARAM_BUOYANCY_STATIC_PITCH,
      buoyancy?.staticPitch ?? 0,
    );
    this.transforms.writeParam(
      proxy.proxyId,
      PARAM_BUOYANCY_STATIC_ROLL,
      buoyancy?.staticRoll ?? 0,
    );
  }

  private writeElastic(actor: Actor, proxy: RenderProxyComponent): void {
    const detach = actor.getComponent(
      ELASTIC_DETACH_COMPONENT,
    ) as ElasticDetachComponent | undefined;
    const tether = actor.getComponent(
      ELASTIC_TETHER_COMPONENT,
    ) as ElasticTetherComponent | undefined;
    this.transforms.writeParam(
      proxy.proxyId,
      PARAM_ELASTIC_DETACHED,
      detach?.detached ? 1 : 0,
    );
    // 渲染侧只需要知道弹簧刚度取哪一档，不需要知道是谁在拉。
    this.transforms.writeParam(
      proxy.proxyId,
      PARAM_ELASTIC_HELD,
      tether?.holderPlayerId != null ? 1 : 0,
    );
    this.transforms.writeParam(proxy.proxyId, PARAM_ELASTIC_TARGET_X, tether?.targetX ?? 0);
    this.transforms.writeParam(proxy.proxyId, PARAM_ELASTIC_TARGET_Y, tether?.targetY ?? 0);
    this.transforms.writeParam(proxy.proxyId, PARAM_ELASTIC_TARGET_Z, tether?.targetZ ?? 0);
    this.transforms.writeParam(
      proxy.proxyId,
      PARAM_ELASTIC_DETACH_LENGTH,
      tether?.detachLength ?? 0,
    );
    this.transforms.writeParam(
      proxy.proxyId,
      PARAM_ELASTIC_RELEASE_REVISION,
      tether?.releaseRevision ?? 0,
    );
  }

  private writeDropMotion(actor: Actor, proxy: RenderProxyComponent): void {
    const motion = actor.getComponent(DROP_MOTION_COMPONENT) as DropMotionComponent | undefined;
    this.transforms.writeParam(proxy.proxyId, PARAM_DROP_RADIUS, motion?.radius ?? 0);
    this.transforms.writeParam(proxy.proxyId, PARAM_DROP_ROTATION_X, motion?.rotationX ?? 0);
    this.transforms.writeParam(proxy.proxyId, PARAM_DROP_ROTATION_Y, motion?.rotationY ?? 0);
    this.transforms.writeParam(proxy.proxyId, PARAM_DROP_ROTATION_Z, motion?.rotationZ ?? 0);
    this.transforms.writeParam(proxy.proxyId, PARAM_DROP_ROTATION_W, motion?.rotationW ?? 0);
  }
}

// 新增参数时把它写进上面的循环，并确认 RENDER_VISUAL_PARAM_COUNT 已经加一——
// 漏掉任何一项都会让复用槽位继承上一个 proxy 的值。
void RENDER_VISUAL_PARAM_COUNT;
