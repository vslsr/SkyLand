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

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') throw new TypeError(`${path} 必须是布尔值`);
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
  for (const key of ['ground', 'trees', 'grass', 'ocean']) {
    requireBoolean(content[key], `${filename}.renderer.content.${key}`);
  }

  let ocean;
  if (content.ocean) {
    const rawOcean = requireObject(renderer.ocean, `${filename}.renderer.ocean`);
    ocean = {
      size: requireNumber(rawOcean.size, `${filename}.renderer.ocean.size`),
      segments: requireInteger(rawOcean.segments, `${filename}.renderer.ocean.segments`, 8, 128),
      waveHeight: requireNumber(rawOcean.waveHeight, `${filename}.renderer.ocean.waveHeight`),
      waveSpeed: requireNumber(rawOcean.waveSpeed, `${filename}.renderer.ocean.waveSpeed`),
      noiseScale: requireNumber(rawOcean.noiseScale, `${filename}.renderer.ocean.noiseScale`),
      noiseStrength: requireNumber(rawOcean.noiseStrength, `${filename}.renderer.ocean.noiseStrength`),
      interlaceStrength: requireNumber(rawOcean.interlaceStrength, `${filename}.renderer.ocean.interlaceStrength`),
      surfaceColor: requireColor(rawOcean.surfaceColor, `${filename}.renderer.ocean.surfaceColor`),
      secondaryColor: requireColor(rawOcean.secondaryColor, `${filename}.renderer.ocean.secondaryColor`),
      gridLineColor: requireColor(rawOcean.gridLineColor, `${filename}.renderer.ocean.gridLineColor`),
      gridLineOpacity: requireNumber(rawOcean.gridLineOpacity, `${filename}.renderer.ocean.gridLineOpacity`),
      foamColor: requireColor(rawOcean.foamColor, `${filename}.renderer.ocean.foamColor`),
      demoRaft: requireBoolean(rawOcean.demoRaft, `${filename}.renderer.ocean.demoRaft`),
    };
    if (ocean.size < 16 || ocean.size > 1024) throw new TypeError(`${filename}.renderer.ocean.size 范围无效`);
    if (ocean.waveHeight < 0 || ocean.waveHeight > 1) throw new TypeError(`${filename}.renderer.ocean.waveHeight 范围无效`);
    if (ocean.waveSpeed < 0 || ocean.waveSpeed > 4) throw new TypeError(`${filename}.renderer.ocean.waveSpeed 范围无效`);
    if (ocean.noiseScale <= 0 || ocean.noiseScale > 1) throw new TypeError(`${filename}.renderer.ocean.noiseScale 范围无效`);
    if (ocean.noiseStrength < 0 || ocean.noiseStrength > 3) throw new TypeError(`${filename}.renderer.ocean.noiseStrength 范围无效`);
    if (ocean.interlaceStrength < 0 || ocean.interlaceStrength > 0.75) throw new TypeError(`${filename}.renderer.ocean.interlaceStrength 范围无效`);
    if (ocean.gridLineOpacity < 0 || ocean.gridLineOpacity > 1) throw new TypeError(`${filename}.renderer.ocean.gridLineOpacity 范围无效`);
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

  let water;
  if (content.ocean) {
    const rawWater = requireObject(gameplay.water, `${filename}.gameplay.water`);
    water = { seaLevel: requireNumber(rawWater.seaLevel, `${filename}.gameplay.water.seaLevel`) };
  }

  const camera = requireObject(scene.camera, `${filename}.camera`);
  if (camera.mode !== 'topdown' && camera.mode !== 'fly') {
    throw new TypeError(`${filename}.camera.mode 必须是 topdown 或 fly`);
  }
  if (!Array.isArray(camera.position) || camera.position.length !== 3) {
    throw new TypeError(`${filename}.camera.position 必须包含 3 个数字`);
  }
  camera.position.forEach((value, index) => requireNumber(value, `${filename}.camera.position[${index}]`));
  const yaw = requireNumber(camera.yaw, `${filename}.camera.yaw`);
  const pitch = requireNumber(camera.pitch, `${filename}.camera.pitch`);
  const moveSpeed = requireNumber(camera.moveSpeed, `${filename}.camera.moveSpeed`);
  if (pitch < -1.5 || pitch > 1.5) throw new TypeError(`${filename}.camera.pitch 范围无效`);
  if (moveSpeed <= 0 || moveSpeed > 100) throw new TypeError(`${filename}.camera.moveSpeed 范围无效`);

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
      content: {
        ground: content.ground,
        trees: content.trees,
        grass: content.grass,
        ocean: content.ocean,
      },
      palette: {
        ground: requireColor(palette.ground, `${filename}.renderer.palette.ground`),
        grass: requireColor(palette.grass, `${filename}.renderer.palette.grass`),
        treeTrunk: requireColor(palette.treeTrunk, `${filename}.renderer.palette.treeTrunk`),
        treeNeedles: requireColor(palette.treeNeedles, `${filename}.renderer.palette.treeNeedles`),
      },
      ...(ocean ? { ocean } : {}),
    },
    gameplay: {
      bounds: { minimumX, maximumX, minimumZ, maximumZ },
      spawn: {
        centerX,
        centerZ,
        radius,
        slots: requireInteger(spawn.slots, `${filename}.gameplay.spawn.slots`, 1, 64),
      },
      ...(water ? { water } : {}),
    },
    camera: {
      mode: camera.mode,
      position: [...camera.position],
      yaw,
      pitch,
      moveSpeed,
    },
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
