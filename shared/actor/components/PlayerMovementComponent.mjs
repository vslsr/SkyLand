import {
  PLAYER_MOVE_SPEED,
  PLAYER_SPRINT_MULTIPLIER,
} from '../../playerMovement.mjs';
import { ActorComponent } from '../ActorComponent.mjs';

export const PLAYER_MOVEMENT_COMPONENT = 'playerMovement';

function finiteInRange(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, number))
    : fallback;
}

/** 玩家 Actor 的共享移动参数；本地预测与房间 DS 都读取这个 Component。 */
export class PlayerMovementComponent extends ActorComponent {
  constructor(definition = {}) {
    super(PLAYER_MOVEMENT_COMPONENT);
    this.walkSpeed = finiteInRange(definition.walkSpeed, PLAYER_MOVE_SPEED, 0.01, 30);
    this.sprintMultiplier = finiteInRange(
      definition.sprintMultiplier,
      PLAYER_SPRINT_MULTIPLIER,
      1,
      4,
    );
    this.maximumStepHeight = finiteInRange(definition.maximumStepHeight, 0, 0, 2);
    this.acceleration = finiteInRange(definition.acceleration, 28, 0.1, 100);
    this.deceleration = finiteInRange(definition.deceleration, 24, 0.1, 100);
    this.airAcceleration = finiteInRange(definition.airAcceleration, 8, 0, 100);
    this.airDrag = finiteInRange(definition.airDrag, 0.6, 0, 20);
  }
}
