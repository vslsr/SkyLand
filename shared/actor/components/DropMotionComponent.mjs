import { ActorComponent } from '../ActorComponent.mjs';

export const DROP_MOTION_COMPONENT = 'dropMotion';

/** 只在 active 阶段参与轻量弹道结算；sleeping 后不再逐 tick 移动。 */
export class DropMotionComponent extends ActorComponent {
  constructor(definition = {}) {
    super(DROP_MOTION_COMPONENT);
    const velocity = Array.isArray(definition.velocity) ? definition.velocity : [0, 0, 0];
    this.velocityX = Number(velocity[0]) || 0;
    this.velocityY = Number(velocity[1]) || 0;
    this.velocityZ = Number(velocity[2]) || 0;
    this.gravity = Math.max(0, Number(definition.gravity) || 9.8);
    this.drag = Math.max(0, Number(definition.drag) || 5);
    this.groundDrag = Math.max(0, Number(definition.groundDrag ?? this.drag) || 0);
    this.restitution = Math.max(0, Math.min(1, Number(definition.restitution) || 0));
    /** 大于 0 时按球体中心结算地面接触与水平碰撞，也供客户端计算滚动角。 */
    this.radius = Math.max(0, Number(definition.radius) || 0);
    this.settleSpeed = Math.max(0.01, Number(definition.settleSpeed) || 0.08);
    /** 角阻尼越小翻得越久；掉落物默认让它翻上一会儿再停。 */
    this.angularDamping = Math.max(0, Number(definition.angularDamping ?? 1.1));
    this.groundedSeconds = 0;
    // 刚体解算出来的朝向。位置决定落在哪，朝向决定它是躺着还是立着。
    this.rotationX = 0;
    this.rotationY = 0;
    this.rotationZ = 0;
    this.rotationW = 1;
    const rotation = Array.isArray(definition.rotation) ? definition.rotation : undefined;
    if (rotation) {
      this.setRotation({
        x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3],
      });
    }
  }

  setRotation(rotation) {
    const x = Number(rotation?.x);
    const y = Number(rotation?.y);
    const z = Number(rotation?.z);
    const w = Number(rotation?.w);
    const length = Math.hypot(x, y, z, w);
    if (!Number.isFinite(length) || length < 1e-6) return false;
    this.rotationX = x / length;
    this.rotationY = y / length;
    this.rotationZ = z / length;
    this.rotationW = w / length;
    return true;
  }
}
