import {
  applyPlayerMovement,
  createSpawnPoint,
  normalizeAngle,
  sanitizeMoveInput,
  toFiniteNumber,
} from '../../shared/playerMovement.mjs';
import {
  INPUT_TIME_BUDGET_SECONDS,
  MAXIMUM_INPUT_DELTA_SECONDS,
  MOVEMENT_IDLE_TIMEOUT_MS,
} from '../../shared/networkTuning.mjs';

function roundCoordinate(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * 房间内的权威世界状态。
 *
 * 客户端提交的是「方向 + 加速开关 + 这段时间有多长」，而不是坐标；
 * 位置一律由这里用 shared/playerMovement 推进，所以速度上限、活动范围
 * 和朝向范围都握在服务端手上。
 */
export class ServerScene {
  constructor(id = 'grassland', options = {}) {
    this.id = id;
    this.tick = 0;
    this.players = new Map();
    this.now = options.now ?? (() => Date.now());
    this.lastRefillAt = this.now();
  }

  addPlayer(player) {
    const spawn = createSpawnPoint(player.slot ?? this.players.size);
    this.players.set(player.id, {
      id: player.id,
      name: player.name,
      x: spawn.x,
      z: spawn.z,
      yaw: Math.PI,
      speed: 0,
      sequence: 0,
      timeBudget: INPUT_TIME_BUDGET_SECONDS,
      lastInputAt: this.now(),
    });
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
  }

  /**
   * 校验并应用一条输入。位移在收到消息时立即结算，
   * 这样客户端按真实帧时间做的预测才能和服务端对齐。
   */
  applyInput(playerId, message) {
    const player = this.players.get(playerId);
    if (!player) return;

    // 序号必须严格递增，重放和乱序到达的旧输入一律丢弃。
    const sequence = Math.floor(toFiniteNumber(message?.sequence, 0));
    if (sequence <= player.sequence) return;
    player.sequence = sequence;

    // 客户端报的时长不可信：先钳制单条上限，再从服务器时钟维护的
    // 时间预算里扣除，谎报时长最多只能提前花光预算，不能凭空加速。
    const requested = Math.max(
      0,
      Math.min(toFiniteNumber(message?.deltaSeconds, 0), MAXIMUM_INPUT_DELTA_SECONDS),
    );
    const granted = Math.min(requested, player.timeBudget);
    player.timeBudget -= granted;

    player.yaw = normalizeAngle(toFiniteNumber(message?.yaw, player.yaw));

    const move = sanitizeMoveInput({ ...message?.move, sprint: message?.sprint === true });
    const next = applyPlayerMovement({ x: player.x, z: player.z }, move, granted);
    const distance = Math.hypot(next.x - player.x, next.z - player.z);
    player.x = next.x;
    player.z = next.z;
    player.speed = granted > 0 ? distance / granted : 0;
    player.lastInputAt = this.now();
  }

  /** 按真实经过的时间补充每名玩家的模拟时间预算。 */
  update() {
    this.tick += 1;
    const now = this.now();
    const elapsedSeconds = Math.max(0, (now - this.lastRefillAt) / 1000);
    this.lastRefillAt = now;

    for (const player of this.players.values()) {
      player.timeBudget = Math.min(
        INPUT_TIME_BUDGET_SECONDS,
        player.timeBudget + elapsedSeconds,
      );
      if (now - player.lastInputAt > MOVEMENT_IDLE_TIMEOUT_MS) player.speed = 0;
    }
  }

  createSnapshot() {
    return {
      sceneId: this.id,
      tick: this.tick,
      serverTime: this.now(),
      players: Array.from(this.players.values(), (player) => ({
        id: player.id,
        name: player.name,
        x: roundCoordinate(player.x),
        z: roundCoordinate(player.z),
        yaw: roundCoordinate(player.yaw),
        speed: roundCoordinate(player.speed),
        sequence: player.sequence,
      })),
    };
  }
}
