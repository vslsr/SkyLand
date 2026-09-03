import type { ProxyId } from './RenderScene';
import type { RenderTransformBuffer } from './RenderTransformBuffer';
import {
  PARAM_SLIME_DRAG_CONTACT_X,
  PARAM_SLIME_DRAG_CONTACT_Y,
  PARAM_SLIME_DRAG_CONTACT_Z,
  PARAM_SLIME_DRAG_PULL_X,
  PARAM_SLIME_DRAG_PULL_Y,
  PARAM_SLIME_DRAG_PINCH,
  PARAM_SLIME_DRAG_PULL_Z,
  PARAM_SLIME_DRAG_REVISION,
} from './RenderVisualParams';

/**
 * 别人拖出来的形变，玩法侧写、渲染侧读。
 *
 * 本地玩家的拖拽全程在渲染这一侧（指针、相机、外壳都在这里），不经过这条通道。
 * 走这里的是**从快照来的**那一份：玩法侧只是把六个本地坐标从网络搬到参数段，
 * 渲染侧再在自己的求解器上重放同一个手势。
 *
 * 这个文件不 import three——它是玩法侧也能用的写入口。
 */
export interface SlimeDragParams {
  /**
   * 抓取计数，**0 表示没有拖拽**。
   *
   * 渲染侧只比较「和上一帧一样吗」，不做算术，所以 f32 够用；一次会话里它到不了
   * f32 整数精度的边界（2^24）。取 0 作静止值是因为「不驱动这项表现的槽位每帧写 0」
   * 是参数段的通用规则，而服务端的 revision 从 1 开始。
   */
  revision: number;
  /** 命中点，proxy 本地坐标。 */
  contactX: number;
  contactY: number;
  contactZ: number;
  /** 命中点到指针目标的位移，proxy 本地坐标。 */
  pullX: number;
  pullY: number;
  pullZ: number;
  /** 这一次抓取有多尖：0 整团跟随（鼠标拖拽），1 只在命中处拔尖（咬住）。 */
  pinch: number;
}

/** 复用槽位的初值，也是「没有人在拖」的槽位每帧写进去的那组值。 */
export const SLIME_DRAG_AT_REST: SlimeDragParams = {
  revision: 0,
  contactX: 0,
  contactY: 0,
  contactZ: 0,
  pullX: 0,
  pullY: 0,
  pullZ: 0,
  pinch: 0,
};

export function writeSlimeDragParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  drag: SlimeDragParams,
): void {
  transforms.writeParam(id, PARAM_SLIME_DRAG_REVISION, drag.revision);
  transforms.writeParam(id, PARAM_SLIME_DRAG_CONTACT_X, drag.contactX);
  transforms.writeParam(id, PARAM_SLIME_DRAG_CONTACT_Y, drag.contactY);
  transforms.writeParam(id, PARAM_SLIME_DRAG_CONTACT_Z, drag.contactZ);
  transforms.writeParam(id, PARAM_SLIME_DRAG_PULL_X, drag.pullX);
  transforms.writeParam(id, PARAM_SLIME_DRAG_PULL_Y, drag.pullY);
  transforms.writeParam(id, PARAM_SLIME_DRAG_PULL_Z, drag.pullZ);
  transforms.writeParam(id, PARAM_SLIME_DRAG_PINCH, drag.pinch);
}

export function readSlimeDragParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  out: SlimeDragParams,
): SlimeDragParams {
  out.revision = transforms.readParam(id, PARAM_SLIME_DRAG_REVISION);
  out.contactX = transforms.readParam(id, PARAM_SLIME_DRAG_CONTACT_X);
  out.contactY = transforms.readParam(id, PARAM_SLIME_DRAG_CONTACT_Y);
  out.contactZ = transforms.readParam(id, PARAM_SLIME_DRAG_CONTACT_Z);
  out.pullX = transforms.readParam(id, PARAM_SLIME_DRAG_PULL_X);
  out.pullY = transforms.readParam(id, PARAM_SLIME_DRAG_PULL_Y);
  out.pullZ = transforms.readParam(id, PARAM_SLIME_DRAG_PULL_Z);
  out.pinch = transforms.readParam(id, PARAM_SLIME_DRAG_PINCH);
  return out;
}
