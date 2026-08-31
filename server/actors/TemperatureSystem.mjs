import {
  COMBUSTIBLE_COMPONENT,
  HEAT_EMITTER_COMPONENT,
  TEMPERATURE_COMPONENT,
  TRANSFORM_COMPONENT,
} from '../../shared/actor/index.mjs';
import { chunkRingDistance, toChunkCoordinate } from '../../shared/world/chunkKey.mjs';

const SIMULATION_STEP_SECONDS = 0.1;
const MAXIMUM_CATCH_UP_SECONDS = 0.5;
const SOURCE_CELL_SIZE = 4;
const PLAYER_ACTIVE_CHUNK_RADIUS = 2;
const TEMPERATURE_EPSILON = 0.01;

function cellCoordinate(value) {
  return Math.floor(value / SOURCE_CELL_SIZE);
}

function cellKey(x, z) {
  return `${x}:${z}`;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * 10 Hz 权威热传播。
 *
 * 场景 Actor 由 Schema 限制为 256 个；热源再按 4 米空间格局部查询，避免
 * 热源 × 可燃物的全连接扫描。空房间完全暂停；有玩家时只激活玩家 AOI、
 * 已燃烧 Actor 及被这些热源触达的邻居，成本不随世界总面积增长。
 */
export class TemperatureSystem {
  constructor() {
    this.accumulator = 0;
    this.sourceCells = new Map();
    this.sources = [];
    this.playerChunks = [];
    this.maximumSourceRadius = 0;
  }

  update(world, deltaSeconds) {
    const players = world.context?.players;
    if (players && players.size === 0) {
      this.accumulator = 0;
      return;
    }
    const safeDelta = clamp(Number(deltaSeconds) || 0, 0, MAXIMUM_CATCH_UP_SECONDS);
    this.accumulator = Math.min(this.accumulator + safeDelta, MAXIMUM_CATCH_UP_SECONDS);
    while (this.accumulator + Number.EPSILON >= SIMULATION_STEP_SECONDS) {
      this.accumulator -= SIMULATION_STEP_SECONDS;
      this.simulateStep(world, SIMULATION_STEP_SECONDS, players?.values?.() ?? []);
    }
  }

  simulateStep(world, deltaSeconds, players) {
    this.collectPlayerChunks(players);
    this.collectSources(world);
    for (const actor of world.query(TRANSFORM_COMPONENT, TEMPERATURE_COMPONENT)) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const temperature = actor.requireComponent(TEMPERATURE_COMPONENT);
      const combustible = actor.getComponent(COMBUSTIBLE_COMPONENT);
      const nearPlayer = this.isNearPlayer(transform.x, transform.z);
      const receivedHeat = this.sampleHeat(transform.x, transform.z);
      if (!nearPlayer && !combustible?.burning && receivedHeat <= 0) continue;

      const previousTemperature = temperature.temperature;
      const cooling = temperature.coolingRate
        * (temperature.temperature - temperature.ambientTemperature);
      temperature.temperature = clamp(
        temperature.temperature
          + (receivedHeat / temperature.heatCapacity - cooling) * deltaSeconds,
        -273.15,
        2000,
      );
      if (Math.abs(temperature.temperature - previousTemperature) >= TEMPERATURE_EPSILON) {
        temperature.revision += 1;
      }
      if (!combustible) continue;

      const wasBurning = combustible.burning;
      const previousFuel = combustible.fuel;
      if (!combustible.burning
        && combustible.fuel > 0
        && temperature.temperature >= combustible.ignitionTemperature) {
        combustible.burning = true;
      }
      if (combustible.burning) {
        combustible.fuel = Math.max(0, combustible.fuel - combustible.burnRate * deltaSeconds);
        if (combustible.fuel <= 0
          || temperature.temperature <= combustible.extinguishTemperature) {
          combustible.burning = false;
        }
      }
      if (wasBurning !== combustible.burning
        || Math.abs(previousFuel - combustible.fuel) >= TEMPERATURE_EPSILON) {
        combustible.revision += 1;
      }
    }
  }

  collectPlayerChunks(players) {
    this.playerChunks.length = 0;
    for (const player of players) {
      this.playerChunks.push({
        x: toChunkCoordinate(player.x),
        z: toChunkCoordinate(player.z),
      });
    }
  }

  isNearPlayer(x, z) {
    if (this.playerChunks.length === 0) return true;
    const chunkX = toChunkCoordinate(x);
    const chunkZ = toChunkCoordinate(z);
    return this.playerChunks.some((playerChunk) => chunkRingDistance(
      playerChunk.x,
      playerChunk.z,
      chunkX,
      chunkZ,
    ) <= PLAYER_ACTIVE_CHUNK_RADIUS);
  }

  collectSources(world) {
    this.sourceCells.clear();
    this.sources.length = 0;
    this.maximumSourceRadius = 0;
    for (const actor of world.query(TRANSFORM_COMPONENT)) {
      const transform = actor.requireComponent(TRANSFORM_COMPONENT);
      const emitter = actor.getComponent(HEAT_EMITTER_COMPONENT);
      const combustible = actor.getComponent(COMBUSTIBLE_COMPONENT);
      if (emitter?.enabled && this.isNearPlayer(transform.x, transform.z)) {
        this.registerSource(transform.x, transform.z, emitter.power, emitter.radius);
      }
      if (combustible?.burning) {
        this.registerSource(
          transform.x,
          transform.z,
          combustible.heatOutput,
          combustible.heatRadius,
        );
      }
    }
  }

  registerSource(x, z, power, radius) {
    const source = { x, z, power, radius };
    this.sources.push(source);
    this.maximumSourceRadius = Math.max(this.maximumSourceRadius, radius);
    const key = cellKey(cellCoordinate(source.x), cellCoordinate(source.z));
    const bucket = this.sourceCells.get(key);
    if (bucket) bucket.push(source);
    else this.sourceCells.set(key, [source]);
  }

  sampleHeat(x, z) {
    if (this.sources.length === 0) return 0;
    const reach = Math.ceil(this.maximumSourceRadius / SOURCE_CELL_SIZE);
    const centerX = cellCoordinate(x);
    const centerZ = cellCoordinate(z);
    let heat = 0;
    for (let offsetZ = -reach; offsetZ <= reach; offsetZ += 1) {
      for (let offsetX = -reach; offsetX <= reach; offsetX += 1) {
        const bucket = this.sourceCells.get(cellKey(centerX + offsetX, centerZ + offsetZ));
        if (!bucket) continue;
        for (const source of bucket) {
          const distance = Math.hypot(x - source.x, z - source.z);
          if (distance >= source.radius) continue;
          const normalized = 1 - distance / source.radius;
          heat += source.power * normalized * normalized;
        }
      }
    }
    return heat;
  }
}
