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

function validateActorArchetype(raw, filename) {
  const definition = requireObject(raw, filename);
  if (definition.schemaVersion !== 1) throw new TypeError(`${filename}.schemaVersion 必须是 1`);
  const components = requireObject(definition.components, `${filename}.components`);
  const render = requireObject(components.render, `${filename}.components.render`);
  if (render.model !== 'line-art-raft') {
    throw new TypeError(`${filename}.components.render.model 暂只支持 line-art-raft`);
  }
  return {
    schemaVersion: 1,
    id: requireId(definition.id, `${filename}.id`),
    components: {
      buoyancy: validateBuoyancy(components.buoyancy, filename),
      render: {
        model: render.model,
        foamColor: requireColor(render.foamColor, `${filename}.components.render.foamColor`),
        length: requireNumber(render.length, `${filename}.components.render.length`, Number.EPSILON),
        width: requireNumber(render.width, `${filename}.components.render.width`, Number.EPSILON),
      },
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
