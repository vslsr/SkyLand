import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ACTOR_DIRECTORY = fileURLToPath(new URL('../../config/actors/', import.meta.url));

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 走高数量合批绘制的堆叠模型。新增一种堆叠物就在这里登记。 */
const PILE_RENDER_MODELS = new Set([
  'line-art-wood-pile',
  'line-art-stone-pile',
  'line-art-fruit-pile',
]);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

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
  if (!['cargo-toggle', 'mushroom-bite', 'pickup-stack', 'harvest-prop'].includes(definition.action)) {
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
    mouthHeight: requireNumber(definition.mouthHeight, `${path}.mouthHeight`, 0, 3),
    mouthForwardOffset: requireNumber(
      definition.mouthForwardOffset,
      `${path}.mouthForwardOffset`,
      0,
      2,
    ),
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
    settleSpeed: requireNumber(definition.settleSpeed, `${path}.settleSpeed`, Number.EPSILON, 10),
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

function validateGeneratedProp(raw, filename) {
  const path = `${filename}.components.generatedProp`;
  const definition = requireObject(raw, path);
  const dropPath = `${path}.drop`;
  const drop = requireObject(definition.drop, dropPath);
  const quantity = requireNumber(drop.quantity, `${dropPath}.quantity`, 1, 1000);
  if (!Number.isInteger(quantity)) throw new TypeError(`${dropPath}.quantity 必须是整数`);
  const validatedDrop = {
    archetypeId: requireId(drop.archetypeId, `${dropPath}.archetypeId`),
    quantity,
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
    'buoyancy',
    'vesselMotor',
    'interactable',
    'cargo',
    'elasticTether',
    'hazard',
    'temperature',
    'combustible',
    'heatEmitter',
    'itemStack',
    'actorResidency',
    'dropMotion',
    'lifetime',
    'replicationPolicy',
    'generatedProp',
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
  if (!render && !generatedProp) {
    throw new TypeError(`${filename}.components 至少需要 render 或 generatedProp`);
  }
  const playerMovement = components.playerMovement
    ? validatePlayerMovement(components.playerMovement, filename)
    : undefined;
  const interactable = components.interactable
    ? validateInteractable(components.interactable, filename)
    : undefined;
  const elasticTether = components.elasticTether
    ? validateElasticTether(components.elasticTether, filename)
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
  if (playerMovement && render?.model !== 'line-art-player-slime') {
    throw new TypeError(`${filename}.components.playerMovement 需要 line-art-player-slime render`);
  }
  if (render?.model === 'line-art-player-slime' && !playerMovement) {
    throw new TypeError(`${filename}.components.render line-art-player-slime 需要 playerMovement`);
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
  if (itemStack && (!actorResidency || !dropMotion || !lifetime || !replicationPolicy)) {
    throw new TypeError(`${filename}.components.itemStack 需要 actorResidency、dropMotion、lifetime 和 replicationPolicy`);
  }
  if (itemStack && interactable?.action !== 'pickup-stack') {
    throw new TypeError(`${filename}.components.itemStack 需要 pickup-stack interactable`);
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
      ...(components.buoyancy ? { buoyancy: validateBuoyancy(components.buoyancy, filename) } : {}),
      ...(components.vesselMotor ? { vesselMotor: validateVesselMotor(components.vesselMotor, filename) } : {}),
      ...(interactable ? { interactable } : {}),
      ...(components.cargo ? { cargo: validateCargo(components.cargo, filename) } : {}),
      ...(elasticTether ? { elasticTether } : {}),
      ...(components.hazard ? { hazard: validateHazard(components.hazard, filename) } : {}),
      ...(temperature ? { temperature } : {}),
      ...(combustible ? { combustible } : {}),
      ...(heatEmitter ? { heatEmitter } : {}),
      ...(itemStack ? { itemStack } : {}),
      ...(actorResidency ? { actorResidency } : {}),
      ...(dropMotion ? { dropMotion } : {}),
      ...(lifetime ? { lifetime } : {}),
      ...(replicationPolicy ? { replicationPolicy } : {}),
      ...(generatedProp ? { generatedProp } : {}),
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
