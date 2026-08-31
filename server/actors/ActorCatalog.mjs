import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ACTOR_DIRECTORY = fileURLToPath(new URL('../../config/actors/', import.meta.url));

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

function validateInteractable(raw, filename) {
  const path = `${filename}.components.interactable`;
  const definition = requireObject(raw, path);
  if (definition.action !== 'cargo-toggle') {
    throw new TypeError(`${path}.action 暂只支持 cargo-toggle`);
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

function validateRender(raw, filename) {
  const path = `${filename}.components.render`;
  const render = requireObject(raw, path);
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
  throw new TypeError(`${path}.model 不受支持：${render.model}`);
}

function validateActorArchetype(raw, filename) {
  const definition = requireObject(raw, filename);
  if (definition.schemaVersion !== 1) throw new TypeError(`${filename}.schemaVersion 必须是 1`);
  const components = requireObject(definition.components, `${filename}.components`);
  const knownComponents = new Set(['buoyancy', 'vesselMotor', 'interactable', 'cargo', 'hazard', 'render']);
  for (const componentName of Object.keys(components)) {
    if (!knownComponents.has(componentName)) {
      throw new TypeError(`${filename}.components 包含未知 Component：${componentName}`);
    }
  }
  const render = validateRender(components.render, filename);
  return {
    schemaVersion: 1,
    id: requireId(definition.id, `${filename}.id`),
    components: {
      ...(components.buoyancy ? { buoyancy: validateBuoyancy(components.buoyancy, filename) } : {}),
      ...(components.vesselMotor ? { vesselMotor: validateVesselMotor(components.vesselMotor, filename) } : {}),
      ...(components.interactable ? { interactable: validateInteractable(components.interactable, filename) } : {}),
      ...(components.cargo ? { cargo: validateCargo(components.cargo, filename) } : {}),
      ...(components.hazard ? { hazard: validateHazard(components.hazard, filename) } : {}),
      render,
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
