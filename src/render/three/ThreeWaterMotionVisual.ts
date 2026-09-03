import * as THREE from 'three';
import { sampleOceanWaveHeight } from '../../ocean/oceanWaveMath';
import type { OceanVisualDefinition } from '../../scenes/data/SceneDefinition';
import {
  PARAM_BUOYANCY_DRAFT,
  PARAM_BUOYANCY_STATIC_PITCH,
  PARAM_BUOYANCY_STATIC_ROLL,
} from '../RenderVisualParams';
import { NULL_PROXY_ID } from '../RenderScene';
import type { RenderTransform, RenderTransformBuffer } from '../RenderTransformBuffer';
import type { ThreeMeshProxy } from './ThreeMeshProxy';

/** 船体与货箱用同一条通道，但公式不同：船读五个采样点，货箱只读一个。 */
export type WaterMotionMode = 'hull' | 'cargo';

const CARGO_FLOAT_OFFSET = 0.14;

/**
 * 客户端波面上的浮动表现（实现路径文档 §1.75）。
 *
 * 这里以前是 `WaterBobVisualSystem` 与 `CargoVisualSystem` 两个 Actor 世界的
 * System。它们只写 `visualRoot` 的局部变换，从不碰权威 Transform——也就是说
 * 从头到尾都是渲染侧的工作，挂在 Actor 世界里唯一的理由是「那里拿得到
 * BuoyancyComponent」。
 *
 * 现在浪高由渲染侧自己采样（浪的公式属于渲染配置），过边界的只剩吃水深度和
 * 装载造成的静态倾斜。世界坐标与父子关系直接读 SoA。
 */
export class ThreeWaterMotionVisual {
  private readonly world: RenderTransform = { x: 0, y: 0, z: 0, yaw: 0 };

  public constructor(private readonly ocean: OceanVisualDefinition) {}

  public update(
    proxy: ThreeMeshProxy,
    mode: WaterMotionMode,
    transforms: RenderTransformBuffer,
    deltaSeconds: number,
    elapsedSeconds: number,
  ): void {
    transforms.readTransform(proxy.id, this.world);
    if (mode === 'cargo') {
      // 装上船之后由 ThreeAttachmentVisual 继承父级的波动，自己不能再浮一次。
      const parented = transforms.readParent(proxy.id) !== NULL_PROXY_ID;
      const targetY = parented
        ? 0
        : this.sample(this.world.x, this.world.z, elapsedSeconds) - CARGO_FLOAT_OFFSET;
      this.applyLerp(proxy, deltaSeconds, 8, targetY, 0, 0);
      return;
    }

    const sinYaw = Math.sin(this.world.yaw);
    const cosYaw = Math.cos(this.world.yaw);
    const halfLength = proxy.length * 0.5;
    const halfWidth = proxy.width * 0.5;
    const center = this.sample(this.world.x, this.world.z, elapsedSeconds);
    const bow = this.sample(
      this.world.x + sinYaw * halfLength,
      this.world.z + cosYaw * halfLength,
      elapsedSeconds,
    );
    const stern = this.sample(
      this.world.x - sinYaw * halfLength,
      this.world.z - cosYaw * halfLength,
      elapsedSeconds,
    );
    const right = this.sample(
      this.world.x + cosYaw * halfWidth,
      this.world.z - sinYaw * halfWidth,
      elapsedSeconds,
    );
    const left = this.sample(
      this.world.x - cosYaw * halfWidth,
      this.world.z + sinYaw * halfWidth,
      elapsedSeconds,
    );
    const targetPitch = THREE.MathUtils.clamp(
      Math.atan2(stern - bow, proxy.length)
        + transforms.readParam(proxy.id, PARAM_BUOYANCY_STATIC_PITCH),
      -0.07,
      0.07,
    );
    const targetRoll = THREE.MathUtils.clamp(
      Math.atan2(right - left, proxy.width)
        + transforms.readParam(proxy.id, PARAM_BUOYANCY_STATIC_ROLL),
      -0.09,
      0.09,
    );
    const targetY = center - transforms.readParam(proxy.id, PARAM_BUOYANCY_DRAFT);
    this.applyLerp(proxy, deltaSeconds, 7, targetY, targetPitch, targetRoll);
  }

  private sample(x: number, z: number, elapsedSeconds: number): number {
    return sampleOceanWaveHeight(x, z, elapsedSeconds, this.ocean);
  }

  private applyLerp(
    proxy: ThreeMeshProxy,
    deltaSeconds: number,
    response: number,
    targetY: number,
    targetPitch: number,
    targetRoll: number,
  ): void {
    const amount = deltaSeconds > 0 ? 1 - Math.exp(-response * deltaSeconds) : 1;
    const visual = proxy.visualRoot;
    visual.position.y = THREE.MathUtils.lerp(visual.position.y, targetY, amount);
    visual.rotation.x = THREE.MathUtils.lerp(visual.rotation.x, targetPitch, amount);
    visual.rotation.z = THREE.MathUtils.lerp(visual.rotation.z, targetRoll, amount);
  }
}
