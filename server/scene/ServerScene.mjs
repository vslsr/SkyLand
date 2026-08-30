const MOVE_SPEED = 4.5;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

export class ServerScene {
  constructor(id = 'grassland') {
    this.id = id;
    this.tick = 0;
    this.players = new Map();
  }

  addPlayer(player) {
    this.players.set(player.id, {
      id: player.id,
      name: player.name,
      position: { x: 0, y: 0, z: 4.5 },
      look: { yaw: 0, pitch: 0 },
      input: { x: 0, y: 0, z: 0 },
      sequence: 0,
    });
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
  }

  applyInput(playerId, message) {
    const player = this.players.get(playerId);
    const sequence = Math.max(0, Math.floor(Number(message.sequence) || 0));
    if (!player || sequence < player.sequence) return;

    player.sequence = sequence;
    player.input = {
      x: clamp(message.move?.x, -1, 1),
      y: clamp(message.move?.y, -1, 1),
      z: clamp(message.move?.z, -1, 1),
    };
    player.look = {
      yaw: Number(message.look?.yaw) || 0,
      pitch: clamp(message.look?.pitch, -1.5, 1.5),
    };
  }

  update(deltaSeconds) {
    this.tick += 1;
    for (const player of this.players.values()) {
      const length = Math.hypot(player.input.x, player.input.y, player.input.z);
      if (length === 0) continue;
      const scale = (MOVE_SPEED * deltaSeconds) / Math.max(1, length);
      player.position.x += player.input.x * scale;
      player.position.y = clamp(player.position.y + player.input.y * scale, 0.5, 30);
      player.position.z += player.input.z * scale;
    }
  }

  createSnapshot() {
    return {
      sceneId: this.id,
      tick: this.tick,
      serverTime: Date.now(),
      players: Array.from(this.players.values(), (player) => ({
        id: player.id,
        name: player.name,
        position: player.position,
        look: player.look,
        acknowledgedSequence: player.sequence,
      })),
    };
  }
}
