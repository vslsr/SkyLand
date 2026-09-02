import {
  MOVEMENT_IDLE_TIMEOUT_MS,
  SIMULATION_STEP_SECONDS,
} from '../../shared/networkTuning.mjs';

/** 补步用的中性输入：不移动、不冲刺、不跳，只让重力和碰撞继续生效。 */
const NEUTRAL_INPUT = Object.freeze({
  move: Object.freeze({ x: 0, z: 0 }),
  sprint: false,
  jump: false,
});

/** 单个 tick 最多替一名玩家补的固定步数，防止长时间静默后一次补几百步。 */
export const MAXIMUM_IDLE_CATCH_UP_STEPS = 6;

/** 低于这个速度且已落地就认为玩家静止，不需要继续模拟。 */
const RESTING_SPEED = 1e-3;

function isResting(state) {
  return state.grounded === true
    && Math.abs(state.vy) <= RESTING_SPEED
    && Math.hypot(state.vx, state.vz) <= RESTING_SPEED;
}

/**
 * 客户端停止上行时继续推进权威模拟。
 *
 * 玩家的固定步本来只由输入包驱动，一旦客户端不再发包（标签页被节流、网络
 * 中断，或者故意静默），权威状态就会连重力都停下来，玩家停在半空。这里在
 * 房间 tick 上补中性输入：只有**超过输入空闲阈值**且**还在运动**的玩家会被
 * 补步，站着不动的玩家一步都不跑。
 *
 * 成本上界是「房间人数 × MAXIMUM_IDLE_CATCH_UP_STEPS」，与世界面积无关。
 */
export class PlayerIdleSimulation {
  /**
   * @param {{
   *   stepPlayer: (player: object, input: object) => void,
   *   preparePlayer?: (player: object) => void,
   *   idleTimeoutMs?: number,
   *   maximumCatchUpSteps?: number,
   * }} options
   */
  constructor(options) {
    this.stepPlayer = options.stepPlayer;
    this.preparePlayer = options.preparePlayer;
    this.idleTimeoutMs = options.idleTimeoutMs ?? MOVEMENT_IDLE_TIMEOUT_MS;
    this.maximumCatchUpSteps = Math.max(1, options.maximumCatchUpSteps ?? MAXIMUM_IDLE_CATCH_UP_STEPS);
  }

  /** 收到真实输入后清空补步余量，避免同一段时间被模拟两次。 */
  reset(player) {
    player.idleStepAccumulator = 0;
  }

  /**
   * @param {Iterable<object>} players
   * @param {number} elapsedSeconds 本 tick 的真实时长
   * @param {number} now 服务端时钟（毫秒）
   * @returns {number} 本次实际补出的固定步总数
   */
  advance(players, elapsedSeconds, now) {
    const delta = Number(elapsedSeconds);
    if (!(delta > 0) || !Number.isFinite(delta)) return 0;
    let stepped = 0;
    for (const player of players) {
      if (now - player.lastInputAt <= this.idleTimeoutMs) {
        player.idleStepAccumulator = 0;
        continue;
      }
      // 站在地上不动的玩家没有需要推进的状态，补步只会白跑一次 world.step()。
      if (isResting(player.characterState)) {
        player.idleStepAccumulator = 0;
        continue;
      }
      const accumulated = (player.idleStepAccumulator ?? 0) + delta;
      const available = Math.floor((accumulated + 1e-12) / SIMULATION_STEP_SECONDS);
      const count = Math.min(available, this.maximumCatchUpSteps, Math.floor(player.stepBudget));
      player.idleStepAccumulator = count >= available
        ? accumulated - count * SIMULATION_STEP_SECONDS
        // 预算或补步上限吃掉了这一段，只留亚步余量，不让欠账无限堆积。
        : accumulated % SIMULATION_STEP_SECONDS;
      if (count < 1) continue;
      // 玩法系统可能直接改过 Transform；和输入包一样，先让刚体回到同一份
      // characterState 上，否则这一批补步会从旧位置出发。
      this.preparePlayer?.(player);
      for (let index = 0; index < count; index += 1) this.stepPlayer(player, NEUTRAL_INPUT);
      stepped += count;
    }
    return stepped;
  }
}
