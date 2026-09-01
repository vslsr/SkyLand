import { ActorComponent } from '../ActorComponent.mjs';

export const PLAYER_JUMP_COMPONENT = 'playerJump';

const GROUND_EPSILON = 1e-4;

function finiteInRange(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, number))
    : fallback;
}

/**
 * 客户端预测与房间进程共用的跳跃状态。
 *
 * 组件只负责竖直冲量、重力和落地状态；XZ 位移仍由 PlayerMovementComponent
 * 与现有碰撞解算负责，因此空中方向输入不会产生第二套移动规则。
 */
export class PlayerJumpComponent extends ActorComponent {
  constructor(definition = {}) {
    super(PLAYER_JUMP_COMPONENT);
    this.impulse = finiteInRange(definition.impulse, 7, 0.1, 30);
    this.gravity = finiteInRange(definition.gravity, 22, 0.1, 60);
    this.maximumFallSpeed = finiteInRange(definition.maximumFallSpeed, 20, 0.1, 60);
    this.airControl = finiteInRange(definition.airControl, 0.85, 0, 1);
    this.verticalVelocity = 0;
    this.grounded = true;
    this.pressed = false;
  }

  get isAirborne() {
    return !this.grounded;
  }

  get horizontalControlScale() {
    return this.grounded ? 1 : this.airControl;
  }

  /** 按下沿只触发一次；一直按住不会在落地时自动连续跳。 */
  setPressed(pressed) {
    const nextPressed = pressed === true;
    const started = nextPressed && !this.pressed;
    this.pressed = nextPressed;
    if (!started || !this.grounded) return false;
    this.verticalVelocity = this.impulse;
    this.grounded = false;
    return true;
  }

  /** 半隐式重力前的精确匀加速位移，结果不依赖客户端帧率分段。 */
  integrate(positionY, deltaSeconds) {
    const y = Number.isFinite(Number(positionY)) ? Number(positionY) : 0;
    const seconds = Math.max(0, Number(deltaSeconds) || 0);
    if (this.grounded || seconds <= 0) return y;
    const previousVelocity = this.verticalVelocity;
    const unconstrainedVelocity = previousVelocity - this.gravity * seconds;
    this.verticalVelocity = Math.max(-this.maximumFallSpeed, unconstrainedVelocity);
    if (unconstrainedVelocity >= -this.maximumFallSpeed) {
      return y + previousVelocity * seconds - 0.5 * this.gravity * seconds * seconds;
    }
    const timeToMaximumFall = Math.max(
      0,
      (previousVelocity + this.maximumFallSpeed) / this.gravity,
    );
    const acceleratedDistance = (
      previousVelocity * timeToMaximumFall
      - 0.5 * this.gravity * timeToMaximumFall * timeToMaximumFall
    );
    return y + acceleratedDistance - this.maximumFallSpeed * (seconds - timeToMaximumFall);
  }

  /** 只在下降并接触支撑面时落地；上升经过台阶高度不会被吸到台面。 */
  resolveGround(positionY, groundY) {
    const safeGroundY = Number.isFinite(Number(groundY)) ? Number(groundY) : 0;
    const safePositionY = Number.isFinite(Number(positionY)) ? Number(positionY) : safeGroundY;
    if (this.grounded) return safeGroundY;
    if (this.verticalVelocity <= 0 && safePositionY <= safeGroundY + GROUND_EPSILON) {
      this.verticalVelocity = 0;
      this.grounded = true;
      return safeGroundY;
    }
    return safePositionY;
  }

  /** 空中可跨越高度等于脚底相对起跳支撑面的净空，仍保留原有小台阶能力。 */
  traversableStepHeight(baseStepHeight, supportY, positionY) {
    const base = Math.max(0, Number(baseStepHeight) || 0);
    if (this.grounded) return base;
    const clearance = Math.max(0, (Number(positionY) || 0) - (Number(supportY) || 0));
    return Math.max(base, clearance);
  }

  /** 权威纠正发生瞬移时同步离地状态，避免位置与速度互相矛盾。 */
  applyAuthoritativeState(verticalVelocity, grounded) {
    this.verticalVelocity = finiteInRange(verticalVelocity, 0, -this.maximumFallSpeed, this.impulse);
    this.grounded = grounded === true;
    if (this.grounded) this.verticalVelocity = 0;
  }
}
