import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_GUIDE_LOCAL_COORDINATE } from '../../shared/actor/components/GuidePathComponent.mjs';
import {
  MAX_PATROL_LOCAL_COORDINATE,
  MAX_PATROL_WAYPOINTS,
} from '../../shared/actor/components/PatrolPathComponent.mjs';
import { itemCatalog } from '../../shared/items/index.mjs';

export const DEFAULT_ACTOR_DIRECTORY = fileURLToPath(new URL('../../config/actors/', import.meta.url));

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 走高数量合批绘制的堆叠模型。新增一种堆叠物就在这里登记。 */
const PILE_RENDER_MODELS = new Set([
  'line-art-wood-pile',
  'line-art-wood-log',
  'line-art-stone-pile',
  'line-art-fruit-pile',
]);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
/**
 * 能当玩家外壳的 render 模型。导出是有意的：场景校验与房间 DS 都要问同一个
 * 问题，各自写一串 `!==` 会让新增一种玩家外壳变成三处独立的改动。
 */
export const PLAYER_RENDER_MODELS = new Set([
  'line-art-player-slime',
  'line-art-pbf-slime',
  'line-art-legged-slime',
]);

export function isPlayerRenderModel(model) {
  return PLAYER_RENDER_MODELS.has(model);
}

function requireObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} 必须是对象`);
  }
  return value;
}

function requireId(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TypeError(`${path} 必须是小写 kebab-case id`);
  }
  return value;
}

function requireNumber(value, path, minimum = Number.NEGATIVE_INFINITY, maximum = Number.POSITIVE_INFINITY) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} 数值范围无效`);
  }
  return value;
}

function requireColor(value, path) {
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
    throw new TypeError(`${path} 必须是 #RRGGBB 颜色`);
  }
  return value;
}

function requireString(value, path, maximumLength) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) {
    throw new TypeError(`${path} 必须是 1-${maximumLength} 个字符的字符串`);
  }
  return value;
}

function validateBuoyancy(raw, filename) {
  const definition = requireObject(raw, `${filename}.components.buoyancy`);
  if (!Array.isArray(definition.parts) || definition.parts.length < 1 || definition.parts.length > 64) {
    throw new TypeError(`${filename}.components.buoyancy.parts 必须包含 1-64 个部件`);
  }
  const partIds = new Set();
  const parts = definition.parts.map((rawPart, index) => {
    const path = `${filename}.components.buoyancy.parts[${index}]`;
    const part = requireObject(rawPart, path);
    const id = requireId(part.id, `${path}.id`);
    if (partIds.has(id)) throw new TypeError(`${filename} 浮力部件 id 重复：${id}`);
    partIds.add(id);
    return {
      id,
      mass: requireNumber(part.mass, `${path}.mass`, 0),
      buoyancy: requireNumber(part.buoyancy, `${path}.buoyancy`, 0),
      integrity: requireNumber(part.integrity, `${path}.integrity`, 0, 1),
      localX: requireNumber(part.localX, `${path}.localX`),
      localZ: requireNumber(part.localZ, `${path}.localZ`),
    };
  });
  const minimumDraft = requireNumber(definition.minimumDraft, `${filename}.components.buoyancy.minimumDraft`, 0);
  const maximumDraft = requireNumber(definition.maximumDraft, `${filename}.components.buoyancy.maximumDraft`, 0);
  if (maximumDraft < minimumDraft) {
    throw new TypeError(`${filename}.components.buoyancy.maximumDraft 不能小于 minimumDraft`);
  }
  return {
    minimumBeam: requireNumber(definition.minimumBeam, `${filename}.components.buoyancy.minimumBeam`, Number.EPSILON),
    minimumLength: requireNumber(definition.minimumLength, `${filename}.components.buoyancy.minimumLength`, Number.EPSILON),
    maximumTrimRadians: requireNumber(definition.maximumTrimRadians, `${filename}.components.buoyancy.maximumTrimRadians`, 0, 0.25),
    minimumDraft,
    maximumDraft,
    bobAmplitude: definition.bobAmplitude === undefined
      ? 0
      : requireNumber(
          definition.bobAmplitude,
          `${filename}.components.buoyancy.bobAmplitude`,
          0,
          0.75,
        ),
    bobFrequency: definition.bobFrequency === undefined
      ? 0
      : requireNumber(
          definition.bobFrequency,
          `${filename}.components.buoyancy.bobFrequency`,
          0,
          2,
        ),
    parts,
  };
}

function validateVesselMotor(raw, filename) {
  const path = `${filename}.components.vesselMotor`;
  const definition = requireObject(raw, path);
  const inputTimeoutMs = requireNumber(definition.inputTimeoutMs, `${path}.inputTimeoutMs`, 100, 2000);
  if (!Number.isInteger(inputTimeoutMs)) throw new TypeError(`${path}.inputTimeoutMs 必须是整数`);
  return {
    maximumForwardSpeed: requireNumber(definition.maximumForwardSpeed, `${path}.maximumForwardSpeed`, Number.EPSILON, 30),
    maximumReverseSpeed: requireNumber(definition.maximumReverseSpeed, `${path}.maximumReverseSpeed`, Number.EPSILON, 15),
    acceleration: requireNumber(definition.acceleration, `${path}.acceleration`, Number.EPSILON, 30),
    deceleration: requireNumber(definition.deceleration, `${path}.deceleration`, Number.EPSILON, 30),
    drag: requireNumber(definition.drag, `${path}.drag`, Number.EPSILON, 30),
    turnSpeed: requireNumber(definition.turnSpeed, `${path}.turnSpeed`, Number.EPSILON, Math.PI * 2),
    inputTimeoutMs,
  };
}

function validatePlayerMovement(raw, filename) {
  const path = `${filename}.components.playerMovement`;
  const definition = requireObject(raw, path);
  return {
    walkSpeed: requireNumber(definition.walkSpeed, `${path}.walkSpeed`, Number.EPSILON, 30),
    sprintMultiplier: requireNumber(definition.sprintMultiplier, `${path}.sprintMultiplier`, 1, 4),
    maximumStepHeight: requireNumber(
      definition.maximumStepHeight,
      `${path}.maximumStepHeight`,
      0,
      2,
    ),
  };
}

function validateInteractable(raw, filename) {
  const path = `${filename}.components.interactable`;
  const definition = requireObject(raw, path);
  if (!['cargo-toggle', 'mushroom-bite', 'pickup-stack', 'harvest-prop', 'container-open'].includes(definition.action)) {
    throw new TypeError(`${path}.action 暂不支持：${definition.action}`);
  }
  return {
    action: definition.action,
    label: requireString(definition.label, `${path}.label`, 32),
    maximumDistance: requireNumber(definition.maximumDistance, `${path}.maximumDistance`, 0.5, 12),
  };
}

function validateCargo(raw, filename) {
  const path = `${filename}.components.cargo`;
  const definition = requireObject(raw, path);
  return {
    mass: requireNumber(definition.mass, `${path}.mass`, Number.EPSILON, 1000),
    mountLocalX: requireNumber(definition.mountLocalX, `${path}.mountLocalX`, -10, 10),
    mountLocalY: requireNumber(definition.mountLocalY, `${path}.mountLocalY`, -2, 10),
    mountLocalZ: requireNumber(definition.mountLocalZ, `${path}.mountLocalZ`, -10, 10),
  };
}

function validateElasticTether(raw, filename) {
  const path = `${filename}.components.elasticTether`;
  const definition = requireObject(raw, path);
  const restLength = requireNumber(definition.restLength, `${path}.restLength`, Number.EPSILON, 5);
  const breakLength = requireNumber(definition.breakLength, `${path}.breakLength`, Number.EPSILON, 12);
  if (breakLength <= restLength) {
    throw new TypeError(`${path}.breakLength 必须大于 restLength`);
  }
  return {
    restLength,
    breakLength,
    ...(definition.pullDistance !== undefined ? {
      pullDistance: requireNumber(definition.pullDistance, `${path}.pullDistance`, 0, 12),
    } : {}),
  };
}

function validateHazard(raw, filename) {
  const path = `${filename}.components.hazard`;
  const definition = requireObject(raw, path);
  const cooldownMs = requireNumber(definition.cooldownMs, `${path}.cooldownMs`, 100, 60_000);
  if (!Number.isInteger(cooldownMs)) throw new TypeError(`${path}.cooldownMs 必须是整数`);
  return {
    radius: requireNumber(definition.radius, `${path}.radius`, Number.EPSILON, 10),
    damage: requireNumber(definition.damage, `${path}.damage`, Number.EPSILON, 1),
    cooldownMs,
    partId: requireId(definition.partId, `${path}.partId`),
  };
}

function validateTemperature(raw, filename) {
  const path = `${filename}.components.temperature`;
  const definition = requireObject(raw, path);
  return {
    initialTemperature: requireNumber(definition.initialTemperature, `${path}.initialTemperature`, -100, 2000),
    ambientTemperature: requireNumber(definition.ambientTemperature, `${path}.ambientTemperature`, -100, 2000),
    heatCapacity: requireNumber(definition.heatCapacity, `${path}.heatCapacity`, Number.EPSILON, 10_000),
    coolingRate: requireNumber(definition.coolingRate, `${path}.coolingRate`, 0, 10),
  };
}

function validateCombustible(raw, filename) {
  const path = `${filename}.components.combustible`;
  const definition = requireObject(raw, path);
  const ignitionTemperature = requireNumber(
    definition.ignitionTemperature,
    `${path}.ignitionTemperature`,
    -100,
    2000,
  );
  const extinguishTemperature = requireNumber(
    definition.extinguishTemperature,
    `${path}.extinguishTemperature`,
    -100,
    2000,
  );
  if (extinguishTemperature >= ignitionTemperature) {
    throw new TypeError(`${path}.extinguishTemperature 必须小于 ignitionTemperature`);
  }
  return {
    ignitionTemperature,
    extinguishTemperature,
    fuel: requireNumber(definition.fuel, `${path}.fuel`, Number.EPSILON, 100_000),
    burnRate: requireNumber(definition.burnRate, `${path}.burnRate`, Number.EPSILON, 10_000),
    heatOutput: requireNumber(definition.heatOutput, `${path}.heatOutput`, Number.EPSILON, 100_000),
    heatRadius: requireNumber(definition.heatRadius, `${path}.heatRadius`, Number.EPSILON, 32),
  };
}

function validateHeatEmitter(raw, filename) {
  const path = `${filename}.components.heatEmitter`;
  const definition = requireObject(raw, path);
  if (typeof definition.enabled !== 'boolean') throw new TypeError(`${path}.enabled 必须是布尔值`);
  return {
    power: requireNumber(definition.power, `${path}.power`, Number.EPSILON, 100_000),
    radius: requireNumber(definition.radius, `${path}.radius`, Number.EPSILON, 32),
    enabled: definition.enabled,
  };
}

function validateInventory(raw, filename) {
  const path = `${filename}.components.inventory`;
  const definition = requireObject(raw, path);
  const slotCapacity = requireNumber(definition.slotCapacity, `${path}.slotCapacity`, 1, 64);
  if (!Number.isInteger(slotCapacity)) throw new TypeError(`${path}.slotCapacity 必须是整数`);
  const validated = { slotCapacity };
  if (definition.hotbarCapacity !== undefined) {
    const hotbarCapacity = requireNumber(definition.hotbarCapacity, `${path}.hotbarCapacity`, 1, 9);
    if (!Number.isInteger(hotbarCapacity)) throw new TypeError(`${path}.hotbarCapacity 必须是整数`);
    validated.hotbarCapacity = hotbarCapacity;
  }
  if (definition.stowHoldSeconds !== undefined) {
    validated.stowHoldSeconds = requireNumber(
      definition.stowHoldSeconds, `${path}.stowHoldSeconds`, 0.1, 5,
    );
  }
  return validated;
}

function validateContainer(raw, filename) {
  const path = `${filename}.components.container`;
  const definition = requireObject(raw, path);
  const slotCapacity = requireNumber(definition.slotCapacity, `${path}.slotCapacity`, 1, 256);
  if (!Number.isInteger(slotCapacity)) throw new TypeError(`${path}.slotCapacity 必须是整数`);
  return {
    slotCapacity,
    label: requireString(definition.label, `${path}.label`, 32),
    reach: requireNumber(definition.reach, `${path}.reach`, 0.5, 8),
  };
}

function validateItemStack(raw, filename) {
  const path = `${filename}.components.itemStack`;
  const definition = requireObject(raw, path);
  const defaultQuantity = requireNumber(definition.defaultQuantity, `${path}.defaultQuantity`, 1, 100_000);
  const maximumQuantity = requireNumber(definition.maximumQuantity, `${path}.maximumQuantity`, 1, 100_000);
  if (!Number.isInteger(defaultQuantity) || !Number.isInteger(maximumQuantity)) {
    throw new TypeError(`${path} 的数量必须是整数`);
  }
  if (defaultQuantity > maximumQuantity) throw new TypeError(`${path}.defaultQuantity 不能超过 maximumQuantity`);
  return {
    itemType: requireId(definition.itemType, `${path}.itemType`),
    displayName: requireString(definition.displayName, `${path}.displayName`, 32),
    defaultQuantity,
    maximumQuantity,
    compatibilityKey: requireId(definition.compatibilityKey, `${path}.compatibilityKey`),
  };
}

function validateActorResidency(raw, filename) {
  const path = `${filename}.components.actorResidency`;
  const definition = requireObject(raw, path);
  if (typeof definition.dormantEligible !== 'boolean') {
    throw new TypeError(`${path}.dormantEligible 必须是布尔值`);
  }
  return {
    sleepDelaySeconds: requireNumber(definition.sleepDelaySeconds, `${path}.sleepDelaySeconds`, 0, 60),
    dormantDelaySeconds: requireNumber(definition.dormantDelaySeconds, `${path}.dormantDelaySeconds`, 0, 600),
    dormantEligible: definition.dormantEligible,
  };
}

function validateDropMotion(raw, filename) {
  const path = `${filename}.components.dropMotion`;
  const definition = requireObject(raw, path);
  return {
    gravity: requireNumber(definition.gravity, `${path}.gravity`, 0, 50),
    drag: requireNumber(definition.drag, `${path}.drag`, 0, 50),
    ...(definition.groundDrag !== undefined ? {
      groundDrag: requireNumber(definition.groundDrag, `${path}.groundDrag`, 0, 50),
    } : {}),
    ...(definition.restitution !== undefined ? {
      restitution: requireNumber(definition.restitution, `${path}.restitution`, 0, 1),
    } : {}),
    ...(definition.radius !== undefined ? {
      radius: requireNumber(definition.radius, `${path}.radius`, 0, 3),
    } : {}),
    ...(definition.angularDamping !== undefined ? {
      angularDamping: requireNumber(definition.angularDamping, `${path}.angularDamping`, 0, 50),
    } : {}),
    settleSpeed: requireNumber(definition.settleSpeed, `${path}.settleSpeed`, Number.EPSILON, 10),
  };
}

function validateElasticDetach(raw, filename) {
  const path = `${filename}.components.elasticDetach`;
  requireObject(raw, path);
  return {};
}

function validatePickupDrop(raw, filename) {
  const path = `${filename}.components.pickupDrop`;
  const definition = requireObject(raw, path);
  return {
    mouthLocalX: requireNumber(definition.mouthLocalX, `${path}.mouthLocalX`, -10, 10),
    mouthLocalY: requireNumber(definition.mouthLocalY, `${path}.mouthLocalY`, -10, 10),
    mouthLocalZ: requireNumber(definition.mouthLocalZ, `${path}.mouthLocalZ`, -10, 10),
    mouthLocalYaw: requireNumber(definition.mouthLocalYaw, `${path}.mouthLocalYaw`, -Math.PI * 2, Math.PI * 2),
  };
}

function validatePlayerJump(raw, filename) {
  const path = `${filename}.components.playerJump`;
  const definition = requireObject(raw, path);
  return {
    impulse: requireNumber(definition.impulse, `${path}.impulse`, Number.EPSILON, 30),
    gravity: requireNumber(definition.gravity, `${path}.gravity`, Number.EPSILON, 60),
    maximumFallSpeed: requireNumber(
      definition.maximumFallSpeed,
      `${path}.maximumFallSpeed`,
      Number.EPSILON,
      60,
    ),
    airControl: requireNumber(definition.airControl, `${path}.airControl`, 0, 1),
  };
}

function validateSoftBodyDeformation(raw, filename) {
  const path = `${filename}.components.softBodyDeformation`;
  const definition = requireObject(raw, path);
  return {
    breakDistance: requireNumber(definition.breakDistance, `${path}.breakDistance`, Number.EPSILON, 12),
    ...(definition.selfReportTimeoutMs !== undefined ? {
      selfReportTimeoutMs: requireNumber(
        definition.selfReportTimeoutMs,
        `${path}.selfReportTimeoutMs`,
        Number.EPSILON,
        5000,
      ),
    } : {}),
  };
}

function validateBite(raw, filename) {
  const path = `${filename}.components.bite`;
  const definition = requireObject(raw, path);
  return {
    range: requireNumber(definition.range, `${path}.range`, Number.EPSILON, 8),
    ...(definition.facingDot !== undefined ? {
      facingDot: requireNumber(definition.facingDot, `${path}.facingDot`, -1, 1),
    } : {}),
    // 捏起来的那块皮再深也不该超过外壳本身：过了求解器的可见量程，每次咬都长一样。
    ...(definition.gripDepth !== undefined ? {
      gripDepth: requireNumber(definition.gripDepth, `${path}.gripDepth`, 0, 2),
    } : {}),
    ...(definition.leashSlack !== undefined ? {
      leashSlack: requireNumber(definition.leashSlack, `${path}.leashSlack`, 0, 8),
    } : {}),
    // 刚度乘固定步长超过 2 这个弹簧就会自激振荡；固定步是 1/60，所以卡在 120。
    ...(definition.leashStiffness !== undefined ? {
      leashStiffness: requireNumber(definition.leashStiffness, `${path}.leashStiffness`, 0, 120),
    } : {}),
    ...(definition.leashDamping !== undefined ? {
      leashDamping: requireNumber(definition.leashDamping, `${path}.leashDamping`, 0, 60),
    } : {}),
    ...(definition.leashCarry !== undefined ? {
      leashCarry: requireNumber(definition.leashCarry, `${path}.leashCarry`, 0, 60),
    } : {}),
  };
}

function validateSlimeSurfaceDrag(raw, filename) {
  const path = `${filename}.components.slimeSurfaceDrag`;
  const definition = requireObject(raw, path);
  return {
    maximumDistance: requireNumber(
      definition.maximumDistance,
      `${path}.maximumDistance`,
      Number.EPSILON,
      2,
    ),
    pullForce: requireNumber(definition.pullForce, `${path}.pullForce`, Number.EPSILON, 300),
    falloffExponent: requireNumber(definition.falloffExponent, `${path}.falloffExponent`, 1, 8),
    influenceRadius: requireNumber(
      definition.influenceRadius,
      `${path}.influenceRadius`,
      Number.EPSILON,
      2,
    ),
    ...(definition.acceleration !== undefined ? {
      acceleration: requireNumber(definition.acceleration, `${path}.acceleration`, Number.EPSILON, 100),
    } : {}),
    ...(definition.deceleration !== undefined ? {
      deceleration: requireNumber(definition.deceleration, `${path}.deceleration`, Number.EPSILON, 100),
    } : {}),
    ...(definition.airAcceleration !== undefined ? {
      airAcceleration: requireNumber(definition.airAcceleration, `${path}.airAcceleration`, 0, 100),
    } : {}),
    ...(definition.airDrag !== undefined ? {
      airDrag: requireNumber(definition.airDrag, `${path}.airDrag`, 0, 20),
    } : {}),
  };
}

function validateLifetime(raw, filename) {
  const path = `${filename}.components.lifetime`;
  const definition = requireObject(raw, path);
  return { lifetimeSeconds: requireNumber(definition.lifetimeSeconds, `${path}.lifetimeSeconds`, 0, 86_400) };
}

function validateReplicationPolicy(raw, filename) {
  const path = `${filename}.components.replicationPolicy`;
  const definition = requireObject(raw, path);
  if (definition.mode !== 'always' && definition.mode !== 'aoi') {
    throw new TypeError(`${path}.mode 必须是 always 或 aoi`);
  }
  const radiusChunks = requireNumber(definition.radiusChunks, `${path}.radiusChunks`, 0, 8);
  if (!Number.isInteger(radiusChunks)) throw new TypeError(`${path}.radiusChunks 必须是整数`);
  return { mode: definition.mode, radiusChunks };
}

function validatePatrolPath(raw, filename) {
  const path = `${filename}.components.patrolPath`;
  const definition = requireObject(raw, path);
  const knownKeys = new Set(['waypoints', 'speed', 'waitSeconds', 'mode']);
  for (const key of Object.keys(definition)) {
    if (!knownKeys.has(key)) throw new TypeError(`${path} 包含未知字段：${key}`);
  }
  const raws = definition.waypoints;
  if (!Array.isArray(raws) || raws.length < 2 || raws.length > MAX_PATROL_WAYPOINTS) {
    throw new TypeError(`${path}.waypoints 必须是 2 到 ${MAX_PATROL_WAYPOINTS} 个路点`);
  }
  const waypoints = raws.map((point, index) => {
    const pointPath = `${path}.waypoints[${index}]`;
    if (!Array.isArray(point) || point.length !== 3) {
      throw new TypeError(`${pointPath} 必须是 [x, y, z]`);
    }
    return point.map((value, axis) => requireNumber(
      value,
      `${pointPath}[${axis}]`,
      -MAX_PATROL_LOCAL_COORDINATE,
      MAX_PATROL_LOCAL_COORDINATE,
    ));
  });
  // 全部重合的路线走不动，也就没有巡逻可言；早点报错好过在场景里盯着它发呆。
  const moves = waypoints.some((point) => (
    Math.hypot(point[0] - waypoints[0][0], point[1] - waypoints[0][1], point[2] - waypoints[0][2])
      > 1e-6
  ));
  if (!moves) throw new TypeError(`${path}.waypoints 至少要有两个不重合的路点`);
  const mode = definition.mode ?? 'ping-pong';
  if (mode !== 'ping-pong' && mode !== 'loop') {
    throw new TypeError(`${path}.mode 必须是 ping-pong 或 loop`);
  }
  return {
    waypoints,
    speed: requireNumber(definition.speed, `${path}.speed`, Number.EPSILON, 20),
    waitSeconds: definition.waitSeconds === undefined
      ? 0
      : requireNumber(definition.waitSeconds, `${path}.waitSeconds`, 0, 60),
    mode,
  };
}

function validateGuidePath(raw, filename) {
  const path = `${filename}.components.guidePath`;
  const definition = requireObject(raw, path);
  const knownKeys = new Set([
    'points',
    'curve',
    'lineColor',
    'markerColor',
    'lineWidth',
    'dashLength',
    'gapLength',
    'dashSpeed',
    'markerSize',
    'hitRadius',
    'autoAdvance',
    'loop',
    'enabled',
    'currentPointIndex',
  ]);
  const unknownKeys = Object.keys(definition).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) throw new TypeError(`${path} 包含未知字段：${unknownKeys.join(', ')}`);
  if (!Array.isArray(definition.points) || definition.points.length < 2 || definition.points.length > 32) {
    throw new TypeError(`${path}.points 必须包含 2-32 个三维路点`);
  }
  const points = definition.points.map((rawPoint, pointIndex) => {
    if (!Array.isArray(rawPoint) || rawPoint.length !== 3) {
      throw new TypeError(`${path}.points[${pointIndex}] 必须包含 3 个数字`);
    }
    return rawPoint.map((value, axis) => (
      requireNumber(
        value,
        `${path}.points[${pointIndex}][${axis}]`,
        -MAX_GUIDE_LOCAL_COORDINATE,
        MAX_GUIDE_LOCAL_COORDINATE,
      )
    ));
  });
  if (definition.curve !== 'linear' && definition.curve !== 'catmull-rom') {
    throw new TypeError(`${path}.curve 必须是 linear 或 catmull-rom`);
  }
  for (const key of ['autoAdvance', 'loop', 'enabled']) {
    if (typeof definition[key] !== 'boolean') throw new TypeError(`${path}.${key} 必须是布尔值`);
  }
  const currentPointIndex = definition.currentPointIndex ?? 0;
  if (
    !Number.isInteger(currentPointIndex)
    || currentPointIndex < 0
    || currentPointIndex > points.length
  ) {
    throw new TypeError(`${path}.currentPointIndex 必须是 0-${points.length} 的整数`);
  }
  return {
    points,
    curve: definition.curve,
    lineColor: requireColor(definition.lineColor, `${path}.lineColor`),
    markerColor: requireColor(definition.markerColor, `${path}.markerColor`),
    lineWidth: requireNumber(definition.lineWidth, `${path}.lineWidth`, 1, 20),
    dashLength: requireNumber(definition.dashLength, `${path}.dashLength`, 0.05, 8),
    gapLength: requireNumber(definition.gapLength, `${path}.gapLength`, 0, 8),
    dashSpeed: requireNumber(definition.dashSpeed, `${path}.dashSpeed`, -8, 8),
    markerSize: requireNumber(definition.markerSize, `${path}.markerSize`, 0.1, 4),
    hitRadius: requireNumber(definition.hitRadius, `${path}.hitRadius`, 0.1, 8),
    autoAdvance: definition.autoAdvance,
    loop: definition.loop,
    enabled: definition.enabled,
    currentPointIndex,
  };
}

function validateGeneratedProp(raw, filename) {
  const path = `${filename}.components.generatedProp`;
  const definition = requireObject(raw, path);
  const dropPath = `${path}.drop`;
  const drop = requireObject(definition.drop, dropPath);
  const quantity = requireNumber(drop.quantity, `${dropPath}.quantity`, 1, 1000);
  if (!Number.isInteger(quantity)) throw new TypeError(`${dropPath}.quantity 必须是整数`);
  if (
    drop.spawnPattern !== undefined
    && drop.spawnPattern !== 'center'
    && drop.spawnPattern !== 'center-scatter'
    && drop.spawnPattern !== 'fruit-anchors'
  ) {
    throw new TypeError(`${dropPath}.spawnPattern 必须是 center、center-scatter 或 fruit-anchors`);
  }
  const validatedDrop = {
    archetypeId: requireId(drop.archetypeId, `${dropPath}.archetypeId`),
    quantity,
    ...(drop.spawnPattern !== undefined ? {
      spawnPattern: drop.spawnPattern,
    } : {}),
  };

  // 两种采集形态互斥：可再生的没有血量，掉血的不会长回来。
  // 同时写两套只会让「这一下到底扣血还是进冷却」变成靠读代码才能知道的事。
  if (definition.regrow !== undefined) {
    if (definition.maximumHealth !== undefined || definition.harvestDamage !== undefined) {
      throw new TypeError(`${path}.regrow 与 maximumHealth / harvestDamage 不能同时出现`);
    }
    const regrowPath = `${path}.regrow`;
    const regrow = requireObject(definition.regrow, regrowPath);
    const seconds = requireNumber(regrow.seconds, `${regrowPath}.seconds`, 1, 86_400);
    return { regrow: { seconds }, drop: validatedDrop };
  }

  const maximumHealth = requireNumber(definition.maximumHealth, `${path}.maximumHealth`, 1, 1000);
  const harvestDamage = requireNumber(definition.harvestDamage, `${path}.harvestDamage`, 1, 1000);
  if (![maximumHealth, harvestDamage].every(Number.isInteger)) {
    throw new TypeError(`${path} 的生命与伤害必须是整数`);
  }
  return { maximumHealth, harvestDamage, drop: validatedDrop };
}

function validateRender(raw, filename) {
  const path = `${filename}.components.render`;
  const render = requireObject(raw, path);
  if (render.model === 'line-art-player-slime') {
    return {
      model: render.model,
      radius: requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 2),
      membraneColor: requireColor(render.membraneColor, `${path}.membraneColor`),
      middleColor: requireColor(render.middleColor, `${path}.middleColor`),
      coreColor: requireColor(render.coreColor, `${path}.coreColor`),
      bubbleColor: requireColor(render.bubbleColor, `${path}.bubbleColor`),
      inkColor: requireColor(render.inkColor, `${path}.inkColor`),
      shadowColor: requireColor(render.shadowColor, `${path}.shadowColor`),
    };
  }
  if (render.model === 'line-art-pbf-slime') {
    const particleCount = requireNumber(render.particleCount, `${path}.particleCount`, 16, 192);
    const constraintIterations = requireNumber(
      render.constraintIterations,
      `${path}.constraintIterations`,
      1,
      5,
    );
    const bubbleCount = requireNumber(render.bubbleCount, `${path}.bubbleCount`, 0, 24);
    if (![particleCount, constraintIterations, bubbleCount].every(Number.isInteger)) {
      throw new TypeError(`${path} 的 particleCount、constraintIterations 和 bubbleCount 必须是整数`);
    }
    const radius = requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 2);
    const collisionRadius = requireNumber(
      render.collisionRadius,
      `${path}.collisionRadius`,
      Number.EPSILON,
      2,
    );
    const collisionHeight = requireNumber(
      render.collisionHeight,
      `${path}.collisionHeight`,
      Number.EPSILON,
      4,
    );
    if (collisionRadius >= radius) {
      throw new TypeError(`${path}.collisionRadius 必须小于外部蒙皮 radius`);
    }
    if (collisionHeight >= radius) {
      throw new TypeError(`${path}.collisionHeight 必须低于外部蒙皮顶部`);
    }
    return {
      model: render.model,
      radius,
      collisionRadius,
      collisionHeight,
      particleCount,
      constraintIterations,
      gravity: requireNumber(render.gravity, `${path}.gravity`, 0, 50),
      centerForce: requireNumber(render.centerForce, `${path}.centerForce`, 0, 100),
      viscosity: requireNumber(render.viscosity, `${path}.viscosity`, 0, 100),
      bubbleCount,
      bubbleSpeed: requireNumber(render.bubbleSpeed, `${path}.bubbleSpeed`, 0, 2),
      surfaceColor: requireColor(render.surfaceColor, `${path}.surfaceColor`),
      innerColor: requireColor(render.innerColor, `${path}.innerColor`),
      highlightColor: requireColor(render.highlightColor, `${path}.highlightColor`),
      bubbleColor: requireColor(render.bubbleColor, `${path}.bubbleColor`),
      inkColor: requireColor(render.inkColor, `${path}.inkColor`),
      shadowColor: requireColor(render.shadowColor, `${path}.shadowColor`),
    };
  }
  if (render.model === 'line-art-legged-slime') {
    const legCount = requireNumber(render.legCount, `${path}.legCount`, 2, 6);
    if (!Number.isInteger(legCount)) {
      throw new TypeError(`${path}.legCount 必须是整数`);
    }
    const radius = requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 2);
    const hipHeight = requireNumber(render.hipHeight, `${path}.hipHeight`, Number.EPSILON, 4);
    const thighLength = requireNumber(render.thighLength, `${path}.thighLength`, Number.EPSILON, 3);
    const shinLength = requireNumber(render.shinLength, `${path}.shinLength`, Number.EPSILON, 3);
    const legSpread = requireNumber(render.legSpread, `${path}.legSpread`, Number.EPSILON, 2);
    // 站姿下脚就够不到地的话，IK 每帧都在把落脚点往回收，腿会绷成一条直线并且
    // 一直打滑——「骨骼有关节」这件事在画面上直接消失。
    const standingReach = Math.hypot(hipHeight, legSpread);
    if (thighLength + shinLength <= standingReach) {
      throw new TypeError(
        `${path} 的 thighLength + shinLength 必须够到站姿落脚点（> ${standingReach.toFixed(3)}）`,
      );
    }
    return {
      model: render.model,
      radius,
      hipHeight,
      legSpread,
      legCount,
      thighLength,
      shinLength,
      legThickness: requireNumber(
        render.legThickness,
        `${path}.legThickness`,
        Number.EPSILON,
        0.3,
      ),
      footLength: requireNumber(render.footLength, `${path}.footLength`, Number.EPSILON, 0.6),
      stepLength: requireNumber(render.stepLength, `${path}.stepLength`, Number.EPSILON, 3),
      stepHeight: requireNumber(render.stepHeight, `${path}.stepHeight`, 0, 2),
      stepDuration: requireNumber(render.stepDuration, `${path}.stepDuration`, Number.EPSILON, 2),
      membraneColor: requireColor(render.membraneColor, `${path}.membraneColor`),
      middleColor: requireColor(render.middleColor, `${path}.middleColor`),
      coreColor: requireColor(render.coreColor, `${path}.coreColor`),
      bubbleColor: requireColor(render.bubbleColor, `${path}.bubbleColor`),
      inkColor: requireColor(render.inkColor, `${path}.inkColor`),
      shadowColor: requireColor(render.shadowColor, `${path}.shadowColor`),
      legColor: requireColor(render.legColor, `${path}.legColor`),
      footShadowColor: requireColor(render.footShadowColor, `${path}.footShadowColor`),
    };
  }
  if (render.model === 'line-art-raft') {
    return {
      model: render.model,
      foamColor: requireColor(render.foamColor, `${path}.foamColor`),
      length: requireNumber(render.length, `${path}.length`, Number.EPSILON, 30),
      width: requireNumber(render.width, `${path}.width`, Number.EPSILON, 30),
    };
  }
  if (render.model === 'line-art-cargo-crate') {
    return {
      model: render.model,
      color: requireColor(render.color, `${path}.color`),
      accentColor: requireColor(render.accentColor, `${path}.accentColor`),
      length: requireNumber(render.length, `${path}.length`, Number.EPSILON, 10),
      width: requireNumber(render.width, `${path}.width`, Number.EPSILON, 10),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 10),
    };
  }
  if (render.model === 'line-art-storage-chest') {
    return {
      model: render.model,
      color: requireColor(render.color, `${path}.color`),
      accentColor: requireColor(render.accentColor, `${path}.accentColor`),
      length: requireNumber(render.length, `${path}.length`, Number.EPSILON, 10),
      width: requireNumber(render.width, `${path}.width`, Number.EPSILON, 10),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 10),
    };
  }
  if (render.model === 'line-art-reef') {
    return {
      model: render.model,
      color: requireColor(render.color, `${path}.color`),
      accentColor: requireColor(render.accentColor, `${path}.accentColor`),
      radius: requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 10),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 20),
    };
  }
  if (render.model === 'line-art-elastic-mushroom') {
    return {
      model: render.model,
      capColor: requireColor(render.capColor, `${path}.capColor`),
      stemColor: requireColor(render.stemColor, `${path}.stemColor`),
      spotColor: requireColor(render.spotColor, `${path}.spotColor`),
      radius: requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 3),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 5),
    };
  }
  if (render.model === 'line-art-training-dummy') {
    return {
      model: render.model,
      woodColor: requireColor(render.woodColor, `${path}.woodColor`),
      accentColor: requireColor(render.accentColor, `${path}.accentColor`),
      radius: requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 3),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 6),
    };
  }
  if (render.model === 'line-art-focus-obelisk') {
    return {
      model: render.model,
      stoneColor: requireColor(render.stoneColor, `${path}.stoneColor`),
      crystalColor: requireColor(render.crystalColor, `${path}.crystalColor`),
      radius: requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 3),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 6),
    };
  }
  if (render.model === 'line-art-floor-plaque') {
    return {
      model: render.model,
      color: requireColor(render.color, `${path}.color`),
      accentColor: requireColor(render.accentColor, `${path}.accentColor`),
      width: requireNumber(render.width, `${path}.width`, Number.EPSILON, 12),
      length: requireNumber(render.length, `${path}.length`, Number.EPSILON, 12),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 1),
    };
  }
  if (render.model === 'line-art-campfire') {
    return {
      model: render.model,
      stoneColor: requireColor(render.stoneColor, `${path}.stoneColor`),
      woodColor: requireColor(render.woodColor, `${path}.woodColor`),
      emberColor: requireColor(render.emberColor, `${path}.emberColor`),
      radius: requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 3),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 3),
    };
  }
  if (render.model === 'line-art-dry-hay') {
    return {
      model: render.model,
      color: requireColor(render.color, `${path}.color`),
      accentColor: requireColor(render.accentColor, `${path}.accentColor`),
      radius: requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 3),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 3),
    };
  }
  if (render.model === 'line-art-wood-pile') {
    return {
      model: render.model,
      woodColor: requireColor(render.woodColor, `${path}.woodColor`),
      cutColor: requireColor(render.cutColor, `${path}.cutColor`),
      inkColor: requireColor(render.inkColor, `${path}.inkColor`),
      radius: requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 3),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 3),
    };
  }
  if (render.model === 'line-art-wood-log') {
    return {
      model: render.model,
      woodColor: requireColor(render.woodColor, `${path}.woodColor`),
      cutColor: requireColor(render.cutColor, `${path}.cutColor`),
      inkColor: requireColor(render.inkColor, `${path}.inkColor`),
      radius: requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 1),
      length: requireNumber(render.length, `${path}.length`, Number.EPSILON, 3),
    };
  }
  if (render.model === 'line-art-fruit-pile') {
    return {
      model: render.model,
      fruitColor: requireColor(render.fruitColor, `${path}.fruitColor`),
      accentColor: requireColor(render.accentColor, `${path}.accentColor`),
      inkColor: requireColor(render.inkColor, `${path}.inkColor`),
      radius: requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 3),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 3),
    };
  }
  if (render.model === 'line-art-stone-pile') {
    return {
      model: render.model,
      stoneColor: requireColor(render.stoneColor, `${path}.stoneColor`),
      accentColor: requireColor(render.accentColor, `${path}.accentColor`),
      inkColor: requireColor(render.inkColor, `${path}.inkColor`),
      radius: requireNumber(render.radius, `${path}.radius`, Number.EPSILON, 3),
      height: requireNumber(render.height, `${path}.height`, Number.EPSILON, 3),
    };
  }
  throw new TypeError(`${path}.model 不受支持：${render.model}`);
}

function validateActorArchetype(raw, filename) {
  const definition = requireObject(raw, filename);
  if (definition.schemaVersion !== 1) throw new TypeError(`${filename}.schemaVersion 必须是 1`);
  const components = requireObject(definition.components, `${filename}.components`);
  const knownComponents = new Set([
    'playerMovement',
    'playerJump',
    'slimeSurfaceDrag',
    'softBodyDeformation',
    'bite',
    'buoyancy',
    'vesselMotor',
    'interactable',
    'cargo',
    'elasticTether',
    'elasticDetach',
    'pickupDrop',
    'hazard',
    'temperature',
    'combustible',
    'heatEmitter',
    'inventory',
    'container',
    'itemStack',
    'actorResidency',
    'dropMotion',
    'lifetime',
    'replicationPolicy',
    'generatedProp',
    'guidePath',
    'patrolPath',
    'render',
  ]);
  for (const componentName of Object.keys(components)) {
    if (!knownComponents.has(componentName)) {
      throw new TypeError(`${filename}.components 包含未知 Component：${componentName}`);
    }
  }
  const render = components.render ? validateRender(components.render, filename) : undefined;
  const generatedProp = components.generatedProp
    ? validateGeneratedProp(components.generatedProp, filename)
    : undefined;
  const guidePath = components.guidePath
    ? validateGuidePath(components.guidePath, filename)
    : undefined;
  const patrolPath = components.patrolPath
    ? validatePatrolPath(components.patrolPath, filename)
    : undefined;
  if (!render && !generatedProp && !guidePath) {
    throw new TypeError(`${filename}.components 至少需要 render、generatedProp 或 guidePath`);
  }
  const playerMovement = components.playerMovement
    ? validatePlayerMovement(components.playerMovement, filename)
    : undefined;
  const playerJump = components.playerJump
    ? validatePlayerJump(components.playerJump, filename)
    : undefined;
  const slimeSurfaceDrag = components.slimeSurfaceDrag
    ? validateSlimeSurfaceDrag(components.slimeSurfaceDrag, filename)
    : undefined;
  const softBodyDeformation = components.softBodyDeformation
    ? validateSoftBodyDeformation(components.softBodyDeformation, filename)
    : undefined;
  const bite = components.bite ? validateBite(components.bite, filename) : undefined;
  const interactable = components.interactable
    ? validateInteractable(components.interactable, filename)
    : undefined;
  const elasticTether = components.elasticTether
    ? validateElasticTether(components.elasticTether, filename)
    : undefined;
  const elasticDetach = components.elasticDetach
    ? validateElasticDetach(components.elasticDetach, filename)
    : undefined;
  const pickupDrop = components.pickupDrop
    ? validatePickupDrop(components.pickupDrop, filename)
    : undefined;
  if (elasticTether && interactable?.action !== 'mushroom-bite') {
    throw new TypeError(`${filename}.components.elasticTether 需要 mushroom-bite interactable`);
  }
  if (interactable?.action === 'mushroom-bite' && !elasticTether) {
    throw new TypeError(`${filename}.components.interactable mushroom-bite 需要 elasticTether`);
  }
  if (elasticTether && render?.model !== 'line-art-elastic-mushroom') {
    throw new TypeError(`${filename}.components.elasticTether 需要 line-art-elastic-mushroom render`);
  }
  if (elasticDetach && (!elasticTether || !components.dropMotion)) {
    throw new TypeError(`${filename}.components.elasticDetach 需要 elasticTether 和 dropMotion`);
  }
  if (playerMovement && !PLAYER_RENDER_MODELS.has(render?.model)) {
    throw new TypeError(`${filename}.components.playerMovement 需要玩家史莱姆 render`);
  }
  if (pickupDrop && !playerMovement) {
    throw new TypeError(`${filename}.components.pickupDrop 需要 playerMovement`);
  }
  if (playerJump && (!playerMovement || !PLAYER_RENDER_MODELS.has(render?.model))) {
    throw new TypeError(`${filename}.components.playerJump 需要玩家移动与玩家史莱姆 render`);
  }
  if (render?.model === 'line-art-player-slime' && !playerMovement) {
    throw new TypeError(`${filename}.components.render line-art-player-slime 需要 playerMovement`);
  }
  // line-art-legged-slime 两头都能用：带 playerMovement 是玩家外壳，不带就是
  // 服务端推着走的生物（见 patrolPath）。所以这里**不**强制要 playerMovement。
  if (patrolPath && playerMovement) {
    throw new TypeError(`${filename}.components.patrolPath 不能与 playerMovement 并存`);
  }
  if (slimeSurfaceDrag && render?.model !== 'line-art-pbf-slime') {
    throw new TypeError(`${filename}.components.slimeSurfaceDrag 需要 line-art-pbf-slime render`);
  }
  const temperature = components.temperature
    ? validateTemperature(components.temperature, filename)
    : undefined;
  const combustible = components.combustible
    ? validateCombustible(components.combustible, filename)
    : undefined;
  const heatEmitter = components.heatEmitter
    ? validateHeatEmitter(components.heatEmitter, filename)
    : undefined;
  const inventory = components.inventory ? validateInventory(components.inventory, filename) : undefined;
  const container = components.container ? validateContainer(components.container, filename) : undefined;
  const itemStack = components.itemStack ? validateItemStack(components.itemStack, filename) : undefined;
  const actorResidency = components.actorResidency
    ? validateActorResidency(components.actorResidency, filename)
    : undefined;
  const dropMotion = components.dropMotion ? validateDropMotion(components.dropMotion, filename) : undefined;
  const lifetime = components.lifetime ? validateLifetime(components.lifetime, filename) : undefined;
  const replicationPolicy = components.replicationPolicy
    ? validateReplicationPolicy(components.replicationPolicy, filename)
    : undefined;
  if (combustible && !temperature) {
    throw new TypeError(`${filename}.components.combustible 需要 temperature`);
  }
  if (render?.model === 'line-art-campfire' && !heatEmitter) {
    throw new TypeError(`${filename}.components.render line-art-campfire 需要 heatEmitter`);
  }
  if (render?.model === 'line-art-dry-hay' && (!temperature || !combustible)) {
    throw new TypeError(`${filename}.components.render line-art-dry-hay 需要 temperature 和 combustible`);
  }
  if (interactable?.action === 'pickup-stack' && !itemStack) {
    throw new TypeError(`${filename}.components.interactable pickup-stack 需要 itemStack`);
  }
  // 一个开不了的箱子和一个没有内容的「打开」提示都是死配置，两边互为前提。
  if ((interactable?.action === 'container-open') !== Boolean(container)) {
    throw new TypeError(`${filename}.components.container 与 container-open interactable 必须成对出现`);
  }
  if (itemStack && (!actorResidency || !dropMotion || !lifetime || !replicationPolicy)) {
    throw new TypeError(`${filename}.components.itemStack 需要 actorResidency、dropMotion、lifetime 和 replicationPolicy`);
  }
  if (itemStack && interactable?.action !== 'pickup-stack') {
    throw new TypeError(`${filename}.components.itemStack 需要 pickup-stack interactable`);
  }
  // 掉落物必须是物品目录里登记过的东西，否则捡起来时背包查不到堆叠上限和货位占用。
  if (itemStack && !itemCatalog.has(itemStack.itemType)) {
    throw new TypeError(
      `${filename}.components.itemStack.itemType 没有登记进物品目录：${itemStack.itemType}`,
    );
  }
  // 堆叠模型由 HighCountActorBatchSystem 合批绘制，没有 itemStack 就没有东西可画。
  if (PILE_RENDER_MODELS.has(render?.model) && !itemStack) {
    throw new TypeError(`${filename}.components.render ${render.model} 需要 itemStack`);
  }
  if (generatedProp && interactable?.action !== 'harvest-prop') {
    throw new TypeError(`${filename}.components.generatedProp 需要 harvest-prop interactable`);
  }
  if (interactable?.action === 'harvest-prop' && !generatedProp) {
    throw new TypeError(`${filename}.components.interactable harvest-prop 需要 generatedProp`);
  }
  if (generatedProp && !replicationPolicy) {
    throw new TypeError(`${filename}.components.generatedProp 需要 replicationPolicy`);
  }
  return {
    schemaVersion: 1,
    id: requireId(definition.id, `${filename}.id`),
    components: {
      ...(playerMovement ? { playerMovement } : {}),
      ...(playerJump ? { playerJump } : {}),
      ...(slimeSurfaceDrag ? { slimeSurfaceDrag } : {}),
      ...(softBodyDeformation ? { softBodyDeformation } : {}),
      ...(bite ? { bite } : {}),
      ...(components.buoyancy ? { buoyancy: validateBuoyancy(components.buoyancy, filename) } : {}),
      ...(components.vesselMotor ? { vesselMotor: validateVesselMotor(components.vesselMotor, filename) } : {}),
      ...(interactable ? { interactable } : {}),
      ...(components.cargo ? { cargo: validateCargo(components.cargo, filename) } : {}),
      ...(elasticTether ? { elasticTether } : {}),
      ...(elasticDetach ? { elasticDetach } : {}),
      ...(pickupDrop ? { pickupDrop } : {}),
      ...(components.hazard ? { hazard: validateHazard(components.hazard, filename) } : {}),
      ...(temperature ? { temperature } : {}),
      ...(combustible ? { combustible } : {}),
      ...(heatEmitter ? { heatEmitter } : {}),
      ...(inventory ? { inventory } : {}),
      ...(container ? { container } : {}),
      ...(itemStack ? { itemStack } : {}),
      ...(actorResidency ? { actorResidency } : {}),
      ...(dropMotion ? { dropMotion } : {}),
      ...(lifetime ? { lifetime } : {}),
      ...(replicationPolicy ? { replicationPolicy } : {}),
      ...(generatedProp ? { generatedProp } : {}),
      ...(guidePath ? { guidePath } : {}),
      ...(patrolPath ? { patrolPath } : {}),
      ...(render ? { render } : {}),
    },
  };
}

export class ActorCatalog {
  static async load(directory = DEFAULT_ACTOR_DIRECTORY) {
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.actor.json')).sort();
    if (filenames.length === 0) throw new Error(`没有找到 Actor 原型配置：${directory}`);
    const definitions = [];
    for (const filename of filenames) {
      definitions.push(validateActorArchetype(
        JSON.parse(await readFile(join(directory, filename), 'utf8')),
        filename,
      ));
    }
    return new ActorCatalog(definitions);
  }

  constructor(definitions) {
    this.definitions = new Map();
    for (const definition of definitions) {
      if (this.definitions.has(definition.id)) throw new Error(`Actor 原型 id 重复：${definition.id}`);
      this.definitions.set(definition.id, definition);
    }
  }

  require(archetypeId) {
    const definition = this.definitions.get(String(archetypeId ?? ''));
    if (!definition) throw new Error(`未知 Actor 原型：${archetypeId}`);
    return definition;
  }
}
