import type { ActorArchetypeDefinition } from '../scenes/data/SceneDefinition';

/**
 * 点光源在边界上的那一半（引擎迁移路线图 第 1.5 步的通道形状）。
 *
 * 这个文件里**没有 three**，只有几个数：它同时被玩法侧（`ClientActorSystem`
 * 建 spawn 描述）和渲染侧（`ThreePointLightVisual` 兑现成 uniform）引用，
 * 而边界上只能放数据。
 *
 * 参考项目（`.cursor/demo/line-art-style-magic-cabin-main/`）把壁炉与吊灯的
 * 位置、半径、近远两色和强度直接写死在 FILL 材质的 uniform 里。SkyLand 的火堆
 * 是可建造、会流送进出的 Actor，所以同一批数值改为**按 Actor 原型配置**、
 * 随 proxy 建立与销毁进出，照明方法本身照抄。
 */

/** 原型 JSON 里那份 `pointLight` 配置（已由服务端目录净化过）。 */
export type PointLightConfig = NonNullable<
  ActorArchetypeDefinition['components']['pointLight']
>;

/**
 * 一盏灯**建立时就定下来**的事实：颜色、够到多远、多亮、抖不抖。
 *
 * 它走 `MeshProxyDesc` 而不是每帧的参数段，理由和 `render` 一样——这些值在
 * Actor 活着的时候不会变。每帧过边界的只有「亮不亮」那一个标量
 * （`PARAM_POINT_LIGHT_INTENSITY`）。
 */
export interface PointLightDesc {
  /** 光源附近的颜色。 */
  readonly color: string;
  /** 光晕边缘的颜色。炭火近处发黄、边缘转深橙，靠这一对拉出色阶。 */
  readonly edgeColor: string;
  /** 照明半径（米）。超出这个距离贡献恒为 0。 */
  readonly radius: number;
  /** 强度倍率。1 是参考项目壁炉那一档。 */
  readonly intensity: number;
  /** 光心相对 Actor 原点抬高多少米——火焰在柴堆之上，不在地面上。 */
  readonly heightOffset: number;
  /** 闪烁幅度 [0, 1]。0 是稳定的灯，篝火取 0.2 上下。 */
  readonly flicker: number;
}

/**
 * 把原型配置补齐成 spawn 描述。
 *
 * 默认值在这里而不是在 schema 里：schema 只管「写下来的值合不合法」，
 * 「没写的时候算什么」是这条通道自己的事，两侧都从这一个函数取，不会各补各的。
 */
export function resolvePointLightDesc(config: PointLightConfig): PointLightDesc {
  return {
    color: config.color,
    edgeColor: config.edgeColor ?? config.color,
    radius: config.radius,
    intensity: config.intensity,
    heightOffset: config.heightOffset ?? 0,
    flicker: config.flicker ?? 0,
  };
}
