import type { Actor, ActorWorld } from '../../../shared/actor/index.mjs';
import type { RenderTransformBuffer } from '../../render/RenderTransformBuffer';
import {
  SLIME_MOTION_AT_REST,
  writeSlimeMotionParams,
} from '../../render/RenderSlimeMotion';
import {
  PARAM_FIRE_TARGET_INTENSITY,
  PARAM_TEMPERATURE,
  RENDER_VISUAL_PARAM_COUNT,
} from '../../render/RenderVisualParams';
import {
  RENDER_PROXY_COMPONENT,
  type RenderProxyComponent,
} from '../components/RenderProxyComponent';
import {
  FIRE_VISUAL_COMPONENT,
  type FireVisualComponent,
} from '../components/FireVisualComponent';
import {
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
    }
  }
}

// 新增参数时把它写进上面的循环，并确认 RENDER_VISUAL_PARAM_COUNT 已经加一——
// 漏掉任何一项都会让复用槽位继承上一个 proxy 的值。
void RENDER_VISUAL_PARAM_COUNT;
