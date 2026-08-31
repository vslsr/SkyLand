/**
 * 碰撞层。
 *
 * 一个物件对「玩家推出」和「镜头遮挡」的形状往往不一样：树干挡住走路，
 * 宽大的树冠不挡走路却必须挡镜头，否则相机会从枝叶里穿过去。与其为两套
 * 用途各维护一份碰撞世界，不如让同一份盒子带上位掩码，查询时按层过滤。
 */

export const COLLISION_LAYER = {
  /** 参与圆形移动体的水平推出。 */
  MOVEMENT: 1,
  /** 参与第三人称相机悬臂的扫掠遮挡。 */
  CAMERA: 2,
};

/** 同时参与推出与遮挡，实心物件的默认层。 */
export const COLLISION_LAYER_SOLID = COLLISION_LAYER.MOVEMENT | COLLISION_LAYER.CAMERA;

/** 查询时不做过滤。 */
export const COLLISION_LAYER_ALL = 0xffffffff;
