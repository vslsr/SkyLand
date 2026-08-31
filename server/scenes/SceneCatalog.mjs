import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const DEFAULT_SCENE_DIRECTORY = fileURLToPath(new URL('../../config/scenes/', import.meta.url));

const SCENE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function requireObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} 必须是对象`);
  }
  return value;
}

function requireString(value, path, maximumLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw new TypeError(`${path} 必须是 1-${maximumLength} 个字符的字符串`);
  }
  return value;
}

function requireNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${path} 必须是有限数字`);
  return value;
}

function requireInteger(value, path, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return value;
}

function requireColor(value, path) {
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
    throw new TypeError(`${path} 必须是 #RRGGBB 颜色`);
  }
  return value;
}

function validateSceneDefinition(raw, filename) {
  const scene = requireObject(raw, filename);
  if (scene.schemaVersion !== 1) throw new TypeError(`${filename}.schemaVersion 必须是 1`);
  const id = requireString(scene.id, `${filename}.id`, 48);
  if (!SCENE_ID_PATTERN.test(id)) throw new TypeError(`${filename}.id 格式无效`);

  const renderer = requireObject(scene.renderer, `${filename}.renderer`);
  if (renderer.type !== 'line-art') throw new TypeError(`${filename}.renderer.type 暂只支持 line-art`);
  const fog = requireObject(renderer.fog, `${filename}.renderer.fog`);
  const content = requireObject(renderer.content, `${filename}.renderer.content`);
  const palette = requireObject(renderer.palette, `${filename}.renderer.palette`);
  const fogNear = requireNumber(fog.near, `${filename}.renderer.fog.near`);
  const fogFar = requireNumber(fog.far, `${filename}.renderer.fog.far`);
  if (fogNear < 0 || fogFar <= fogNear) throw new TypeError(`${filename}.renderer.fog 范围无效`);
  for (const key of ['ground', 'trees', 'grass']) {
    if (typeof content[key] !== 'boolean') throw new TypeError(`${filename}.renderer.content.${key} 必须是布尔值`);
  }

  const gameplay = requireObject(scene.gameplay, `${filename}.gameplay`);
  const bounds = requireObject(gameplay.bounds, `${filename}.gameplay.bounds`);
  const spawn = requireObject(gameplay.spawn, `${filename}.gameplay.spawn`);
  const minimumX = requireNumber(bounds.minimumX, `${filename}.gameplay.bounds.minimumX`);
  const maximumX = requireNumber(bounds.maximumX, `${filename}.gameplay.bounds.maximumX`);
  const minimumZ = requireNumber(bounds.minimumZ, `${filename}.gameplay.bounds.minimumZ`);
  const maximumZ = requireNumber(bounds.maximumZ, `${filename}.gameplay.bounds.maximumZ`);
  if (minimumX >= maximumX || minimumZ >= maximumZ) throw new TypeError(`${filename}.gameplay.bounds 范围无效`);

  const centerX = requireNumber(spawn.centerX, `${filename}.gameplay.spawn.centerX`);
  const centerZ = requireNumber(spawn.centerZ, `${filename}.gameplay.spawn.centerZ`);
  const radius = requireNumber(spawn.radius, `${filename}.gameplay.spawn.radius`);
  if (radius < 0 || centerX < minimumX || centerX > maximumX || centerZ < minimumZ || centerZ > maximumZ) {
    throw new TypeError(`${filename}.gameplay.spawn 必须位于玩法边界内`);
  }

  const camera = requireObject(scene.camera, `${filename}.camera`);
  if (!Array.isArray(camera.position) || camera.position.length !== 3) {
    throw new TypeError(`${filename}.camera.position 必须包含 3 个数字`);
  }
  camera.position.forEach((value, index) => requireNumber(value, `${filename}.camera.position[${index}]`));
  requireNumber(camera.yaw, `${filename}.camera.yaw`);
  requireNumber(camera.pitch, `${filename}.camera.pitch`);

  return {
    schemaVersion: 1,
    id,
    displayName: requireString(scene.displayName, `${filename}.displayName`, 32),
    description: requireString(scene.description, `${filename}.description`, 120),
    capacity: requireInteger(scene.capacity, `${filename}.capacity`, 1, 64),
    renderer: {
      type: 'line-art',
      background: requireColor(renderer.background, `${filename}.renderer.background`),
      fog: { color: requireColor(fog.color, `${filename}.renderer.fog.color`), near: fogNear, far: fogFar },
      content: { ground: content.ground, trees: content.trees, grass: content.grass },
      palette: {
        ground: requireColor(palette.ground, `${filename}.renderer.palette.ground`),
        grass: requireColor(palette.grass, `${filename}.renderer.palette.grass`),
        treeTrunk: requireColor(palette.treeTrunk, `${filename}.renderer.palette.treeTrunk`),
        treeNeedles: requireColor(palette.treeNeedles, `${filename}.renderer.palette.treeNeedles`),
      },
    },
    gameplay: {
      bounds: { minimumX, maximumX, minimumZ, maximumZ },
      spawn: {
        centerX,
        centerZ,
        radius,
        slots: requireInteger(spawn.slots, `${filename}.gameplay.spawn.slots`, 1, 64),
      },
    },
    camera: { position: [...camera.position], yaw: camera.yaw, pitch: camera.pitch },
  };
}

export class SceneCatalog {
  static async load(directory = DEFAULT_SCENE_DIRECTORY) {
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.scene.json')).sort();
    if (filenames.length === 0) throw new Error(`没有找到场景配置：${directory}`);

    const definitions = [];
    for (const filename of filenames) {
      const raw = JSON.parse(await readFile(join(directory, filename), 'utf8'));
      definitions.push(validateSceneDefinition(raw, filename));
    }
    return new SceneCatalog(definitions);
  }

  constructor(definitions) {
    this.definitions = new Map();
    for (const definition of definitions) {
      if (this.definitions.has(definition.id)) throw new Error(`场景 id 重复：${definition.id}`);
      this.definitions.set(definition.id, definition);
    }
  }

  list() {
    return Array.from(this.definitions.values(), (scene) => this.toSummary(scene));
  }

  get(sceneId) {
    return this.definitions.get(String(sceneId ?? ''));
  }

  require(sceneId) {
    const scene = this.get(sceneId);
    if (!scene) throw new Error('请选择有效的地图');
    return scene;
  }

  toSummary(scene) {
    return {
      id: scene.id,
      displayName: scene.displayName,
      description: scene.description,
      capacity: scene.capacity,
    };
  }
}
