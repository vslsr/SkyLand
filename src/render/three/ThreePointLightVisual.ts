import * as THREE from 'three';
import type { SceneEnvironmentRuntime } from '../../materials/createFillMaterial';
import { MAX_ENVIRONMENT_POINT_LIGHTS } from '../../shaders/environmentLighting';
import type { PointLightDesc } from '../RenderPointLights';
import type { ProxyId } from '../RenderScene';
import type { RenderTransform, RenderTransformBuffer } from '../RenderTransformBuffer';
import { PARAM_POINT_LIGHT_INTENSITY } from '../RenderVisualParams';

/**
 * 篝火与灯把周围点亮的那一半（参考项目 `index.html` 的 FILL 材质点光源）。
 *
 * 这是渲染世界自己的表现系统：它不认识 Actor，只按 `ProxyId` 从边界的参数段读
 * 「亮不亮」，颜色与半径在 proxy 建立时就登记好了，位置每帧从 transform SoA 取。
 *
 * 三件事留在这一侧，因为它们都是**逐渲染帧的动画状态**，不是玩法状态：
 *
 * - **强度平滑**。玩法侧给的是 0 / 1，火点着与熄掉要有一段渐变，和
 *   `ThreeFireVisual` 用同一条时间常数——光和火焰必须一起亮、一起灭。
 * - **闪烁**。逐光源一条正弦叠加，折进强度里；着色器因此不必知道时间。
 * - **白昼衰减**。正午的篝火不该把地面照亮，取 `runtime.daylight`（天气系统
 *   这一帧刚写过）按参考项目的 `1 - uDaylight * 0.75` 压下去。
 *
 * ## 大世界边界
 *
 * 篝火是可建造的固定物件，一片营地里可以有十几堆。**着色器里的循环次数与
 * 世界里的火堆数无关**：这里每帧只挑离视点最近的 `MAX_ENVIRONMENT_POINT_LIGHTS`
 * 盏写进 uniform，其余的连 uniform 都占不到。挑选本身是一次线性扫描加定长插入，
 * 不排序、不分配，代价正比于**视野内已复制的**发光 Actor 数（AOI 之外的根本
 * 没有 proxy），而不是世界面积。
 */

/** 已登记的一盏灯：spawn 时的描述，加上预先解析好的两个颜色。 */
interface RegisteredLight {
  readonly desc: PointLightDesc;
  /** 逐帧复用：每帧重新解析一次 `#rrggbb` 是纯浪费。 */
  readonly color: THREE.Color;
  readonly edgeColor: THREE.Color;
  /** 闪烁相位。按槽位号推，所以同一片营地里的几堆火不会齐步抖。 */
  readonly phase: number;
}

/** 这一帧入选的一盏灯。定长复用，不每帧分配。 */
interface SelectedLight {
  light?: RegisteredLight;
  x: number;
  y: number;
  z: number;
  strength: number;
  /** 到视点的平方距离，只用来排序。 */
  distanceSquared: number;
}

/** 参考项目的白昼衰减：正午压到四分之一，夜里满强度。 */
function daylightFade(daylight: number): number {
  return 1 - Math.max(0, Math.min(1, daylight)) * 0.75;
}

export class ThreePointLightVisual {
  /** proxyId → 那盏灯。只有配了 `pointLight` 的 proxy 在表里。 */
  private readonly lights = new Map<ProxyId, RegisteredLight>();
  /** proxyId → 平滑后的当前强度。渲染侧独占的动画状态。 */
  private readonly intensities = new Map<ProxyId, number>();
  /** 这一帧入选的几盏，按距离升序。长度恒为上限，`light` 为空表示这一格没人。 */
  private readonly selected: SelectedLight[] = Array.from(
    { length: MAX_ENVIRONMENT_POINT_LIGHTS },
    () => ({ light: undefined, x: 0, y: 0, z: 0, strength: 0, distanceSquared: 0 }),
  );
  /** 逐帧复用的 transform 读出缓冲。 */
  private readonly world: RenderTransform = { x: 0, y: 0, z: 0, yaw: 0 };

  public register(id: ProxyId, desc: PointLightDesc): void {
    this.lights.set(id, {
      desc,
      color: new THREE.Color(desc.color),
      edgeColor: new THREE.Color(desc.edgeColor),
      // 槽位会被回收，所以相位会跟着复用——这没关系：它只要在同屏的几盏之间
      // 不同就够了，不需要跨会话稳定。
      phase: (id * 2.399963) % (Math.PI * 2),
    });
  }

  /** 槽位会被复用：proxy 销毁后必须丢掉它的动画状态，否则新 Actor 继承旧亮度。 */
  public forget(id: ProxyId): void {
    this.lights.delete(id);
    this.intensities.delete(id);
  }

  /**
   * 挑出这一帧照明的几盏，写进全场共享的环境 uniform。
   *
   * `runtime` 缺席（单测里那种不带共享 uniform 的环境）时只更新自己的平滑状态：
   * 没有可写的地方，也就没有可看的光。
   */
  public update(
    transforms: RenderTransformBuffer,
    deltaSeconds: number,
    elapsedSeconds: number,
    viewPosition: THREE.Vector3,
    runtime?: SceneEnvironmentRuntime,
  ): void {
    // 和火焰同一条时间常数：光与火焰必须一起亮、一起灭。
    const smoothing = 1 - Math.exp(-7 * Math.max(0, Math.min(deltaSeconds, 0.1)));
    const fade = daylightFade(runtime?.daylight.value ?? 1);
    let count = 0;
    for (const [id, light] of this.lights) {
      const target = transforms.readParam(id, PARAM_POINT_LIGHT_INTENSITY);
      let intensity = this.intensities.get(id) ?? target;
      intensity += (target - intensity) * smoothing;
      // 和火焰用同一对阈值：吸附到 0，灯才关得掉。
      if (Math.abs(target - intensity) < 0.002) intensity = target;
      this.intensities.set(id, intensity);
      if (intensity <= 0.01) continue;
      const strength = intensity * light.desc.intensity * fade
        * flickerScale(light, elapsedSeconds);
      if (strength <= 0.002) continue;
      // 边界上传的是**世界坐标**，所以船上的篝火不必再去解一遍父子层级。
      transforms.readTransform(id, this.world);
      const y = this.world.y + light.desc.heightOffset;
      const distanceSquared = (this.world.x - viewPosition.x) ** 2
        + (y - viewPosition.y) ** 2
        + (this.world.z - viewPosition.z) ** 2;
      count = this.#insert(light, this.world.x, y, this.world.z, strength, distanceSquared, count);
    }
    if (runtime) this.#writeUniforms(runtime, count);
  }

  /** 换地图或退出时清空。uniform 跟着场景一起换掉，不需要在这里擦。 */
  public dispose(): void {
    this.lights.clear();
    this.intensities.clear();
  }

  /**
   * 定长插入排序：把这一盏放进「最近的 N 盏」里，放不下就丢掉。
   *
   * 用它而不是「全收下再排序」，是因为收集的代价必须与发光 Actor 数成正比、
   * 与它们的**位置**无关——玩家在营地中央转身时，入选的几盏会换，帧代价不变。
   */
  #insert(
    light: RegisteredLight,
    x: number,
    y: number,
    z: number,
    strength: number,
    distanceSquared: number,
    count: number,
  ): number {
    const limit = this.selected.length;
    if (count >= limit && distanceSquared >= this.selected[limit - 1].distanceSquared) {
      return count;
    }
    let index = Math.min(count, limit - 1);
    while (index > 0 && this.selected[index - 1].distanceSquared > distanceSquared) {
      const target = this.selected[index];
      const source = this.selected[index - 1];
      target.light = source.light;
      target.x = source.x;
      target.y = source.y;
      target.z = source.z;
      target.strength = source.strength;
      target.distanceSquared = source.distanceSquared;
      index -= 1;
    }
    const slot = this.selected[index];
    slot.light = light;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.strength = strength;
    slot.distanceSquared = distanceSquared;
    return Math.min(count + 1, limit);
  }

  /**
   * 每帧写满所有槽位，包括没人的那几格（强度写 0）。
   *
   * 和参数段同一条不变量：只在「有变化」时写，走远之后那盏火就会永远留在
   * uniform 里，跟着玩家照亮半张地图。
   */
  #writeUniforms(runtime: SceneEnvironmentRuntime, count: number): void {
    for (let slot = 0; slot < this.selected.length; slot += 1) {
      const falloff = runtime.pointLightFalloff.value[slot];
      if (slot >= count) {
        // 半径留 1 而不是 0：强度为 0 时着色器不会读它，但除以 0 会算出 NaN。
        falloff.set(1, 0);
        continue;
      }
      const selected = this.selected[slot];
      const light = selected.light!;
      runtime.pointLightPositions.value[slot].set(selected.x, selected.y, selected.z);
      runtime.pointLightColors.value[slot].copy(light.color);
      runtime.pointLightEdgeColors.value[slot].copy(light.edgeColor);
      falloff.set(light.desc.radius, selected.strength);
    }
  }
}

/**
 * 闪烁倍率，照参考项目那串正弦：三层不同频率叠加，最慢的一层主导，
 * 快的两层只负责让火焰「跳」一下。取值落在 `[1 - flicker, 1]`，
 * `flicker` 为 0 时恒为 1（稳定的灯）。
 */
function flickerScale(light: RegisteredLight, elapsedSeconds: number): number {
  if (light.desc.flicker <= 0) return 1;
  const wave = 0.62 * Math.sin(elapsedSeconds * 6.7 + light.phase)
    + 0.23 * Math.sin(elapsedSeconds * 11.3 + light.phase * 2.1)
    + 0.15 * Math.sin(elapsedSeconds * 19.7 + light.phase * 3.7);
  return 1 - light.desc.flicker * (0.5 - 0.5 * wave);
}
