import type { ProxyId } from './RenderScene';
import type { RenderTransformBuffer } from './RenderTransformBuffer';
import {
  PARAM_SLIME_AIRBORNE,
  PARAM_SLIME_COLLISION_DISPLACEMENT_X,
  PARAM_SLIME_COLLISION_DISPLACEMENT_Z,
  PARAM_SLIME_SPEED,
  PARAM_SLIME_VELOCITY_X,
  PARAM_SLIME_VELOCITY_Z,
  PARAM_SLIME_VERTICAL_VELOCITY,
} from './RenderVisualParams';

/**
 * 史莱姆软体的运动输入，玩法侧写、渲染侧读（实现路径文档 §1.5）。
 *
 * 这些字段以前是 `HybridSlimeMotionPresentation`，由玩法侧直接调用挂在 Actor 上
 * 的表现 Component。现在它们只是参数段里的七个 f32：写的一侧不认识 rig，
 * 读的一侧不认识 Actor。
 *
 * 这个文件不 import three——它是玩法侧也能用的写入口。
 */
export interface SlimeMotionParams {
  movementSpeed: number;
  movementVelocityX: number;
  movementVelocityZ: number;
  verticalVelocity: number;
  /** 与参数段一致：0 表示贴地。 */
  airborne: number;
  collisionDisplacementX: number;
  collisionDisplacementZ: number;
}

/** 复用槽位的初值，也是「不驱动这项表现」的槽位每帧写进去的那组值。 */
export const SLIME_MOTION_AT_REST: SlimeMotionParams = {
  movementSpeed: 0,
  movementVelocityX: 0,
  movementVelocityZ: 0,
  verticalVelocity: 0,
  airborne: 0,
  collisionDisplacementX: 0,
  collisionDisplacementZ: 0,
};

export function writeSlimeMotionParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  motion: SlimeMotionParams,
): void {
  transforms.writeParam(id, PARAM_SLIME_SPEED, motion.movementSpeed);
  transforms.writeParam(id, PARAM_SLIME_VELOCITY_X, motion.movementVelocityX);
  transforms.writeParam(id, PARAM_SLIME_VELOCITY_Z, motion.movementVelocityZ);
  transforms.writeParam(id, PARAM_SLIME_VERTICAL_VELOCITY, motion.verticalVelocity);
  transforms.writeParam(id, PARAM_SLIME_AIRBORNE, motion.airborne);
  transforms.writeParam(id, PARAM_SLIME_COLLISION_DISPLACEMENT_X, motion.collisionDisplacementX);
  transforms.writeParam(id, PARAM_SLIME_COLLISION_DISPLACEMENT_Z, motion.collisionDisplacementZ);
}

export function readSlimeMotionParams(
  transforms: RenderTransformBuffer,
  id: ProxyId,
  out: SlimeMotionParams,
): SlimeMotionParams {
  out.movementSpeed = transforms.readParam(id, PARAM_SLIME_SPEED);
  out.movementVelocityX = transforms.readParam(id, PARAM_SLIME_VELOCITY_X);
  out.movementVelocityZ = transforms.readParam(id, PARAM_SLIME_VELOCITY_Z);
  out.verticalVelocity = transforms.readParam(id, PARAM_SLIME_VERTICAL_VELOCITY);
  out.airborne = transforms.readParam(id, PARAM_SLIME_AIRBORNE);
  out.collisionDisplacementX = transforms.readParam(id, PARAM_SLIME_COLLISION_DISPLACEMENT_X);
  out.collisionDisplacementZ = transforms.readParam(id, PARAM_SLIME_COLLISION_DISPLACEMENT_Z);
  return out;
}
