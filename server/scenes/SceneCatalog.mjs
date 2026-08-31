import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ActorCatalog } from '../actors/ActorCatalog.mjs';
import { CHUNK_SIZE, WORLD_PLAY_AREA } from '../../shared/world/worldConfig.mjs';

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

function validateActorPlacements(rawActors, filename, actorCatalog) {
  if (!Array.isArray(rawActors) || rawActors.length > 256) {
    throw new TypeError(`${filename}.actors 必须是最多包含 256 项的数组`);
  }
  const actorIds = new Set();
  const archetypes = new Map();
  const actors = rawActors.map((rawActor, index) => {
    const path = `${filename}.actors[${index}]`;
    const actor = requireObject(rawActor, path);
    const id = requireString(actor.id, `${path}.id`, 48);
    const archetypeId = requireString(actor.archetype, `${path}.archetype`, 48);
    const parentActorId = actor.parentActorId === undefined
      ? null
      : requireString(actor.parentActorId, `${path}.parentActorId`, 48);
    if (!SCENE_ID_PATTERN.test(id)) throw new TypeError(`${path}.id 格式无效`);
    if (!SCENE_ID_PATTERN.test(archetypeId)) throw new TypeError(`${path}.archetype 格式无效`);
    if (parentActorId && !SCENE_ID_PATTERN.test(parentActorId)) {
      throw new TypeError(`${path}.parentActorId 格式无效`);
    }
    if (actorIds.has(id)) throw new TypeError(`${filename} Actor id 重复：${id}`);
    actorIds.add(id);
    const archetype = actorCatalog.require(archetypeId);
    archetypes.set(archetype.id, archetype);
    const localTransform = requireObject(actor.localTransform, `${path}.localTransform`);
    if (!Array.isArray(localTransform.position) || localTransform.position.length !== 3) {
      throw new TypeError(`${path}.localTransform.position 必须包含 3 个数字`);
    }
    const position = localTransform.position.map((value, axis) => (
      requireNumber(value, `${path}.localTransform.position[${axis}]`)
    ));
    return {
      id,
      archetypeId,
      parentActorId,
      localTransform: {
        position,
        yaw: requireNumber(localTransform.yaw, `${path}.localTransform.yaw`),
      },
    };
  });

  const actorsById = new Map(actors.map((actor) => [actor.id, actor]));
  for (const actor of actors) {
    if (actor.parentActorId === actor.id) {
      throw new TypeError(`${filename} Actor ${actor.id} 不能将自己设为父节点`);
    }
    if (actor.parentActorId && !actorsById.has(actor.parentActorId)) {
      throw new TypeError(`${filename} Actor ${actor.id} 引用了不存在的父节点：${actor.parentActorId}`);
    }
    const visited = new Set([actor.id]);
    let ancestorId = actor.parentActorId;
    while (ancestorId) {
      if (visited.has(ancestorId)) {
        throw new TypeError(`${filename} Actor 层级存在循环：${actor.id}`);
      }
      visited.add(ancestorId);
      ancestorId = actorsById.get(ancestorId)?.parentActorId ?? null;
    }
  }
  return { actors, actorArchetypes: Array.from(archetypes.values()) };
}

function validateSceneComponents(rawComponents, filename) {
  if (!Array.isArray(rawComponents) || rawComponents.length > 16) {
    throw new TypeError(`${filename}.sceneComponents 必须是最多包含 16 项的数组`);
  }
  const supportedTypes = new Set([
    'mouse-grass-interaction',
    'ability-lab',
    'interactive-particle-effect',
  ]);
  const seenTypes = new Set();
  return rawComponents.map((rawComponent, index) => {
    const path = `${filename}.sceneComponents[${index}]`;
    const component = requireObject(rawComponent, path);
    const type = requireString(component.type, `${path}.type`, 48);
    if (!supportedTypes.has(type)) throw new TypeError(`${path}.type 不受支持：${type}`);
    if (seenTypes.has(type)) throw new TypeError(`${filename}.sceneComponents 重复加载：${type}`);
    const knownKeys = type === 'ability-lab'
      ? new Set(['type', 'targetActorId'])
      : type === 'interactive-particle-effect'
        ? new Set([
          'type',
          'id',
          'preset',
          'position',
          'particleCount',
          'radius',
          'seed',
          'fillColor',
          'accentColor',
          'lineColor',
          'interactionRadius',
          'impulseStrength',
        ])
        : new Set(['type']);
    const unknownKeys = Object.keys(component).filter((key) => !knownKeys.has(key));
    if (unknownKeys.length > 0) {
      throw new TypeError(`${path} 包含未知字段：${unknownKeys.join(', ')}`);
    }
    seenTypes.add(type);
    if (type === 'ability-lab') {
      const targetActorId = requireString(component.targetActorId, `${path}.targetActorId`, 48);
      if (!SCENE_ID_PATTERN.test(targetActorId)) {
        throw new TypeError(`${path}.targetActorId 格式无效`);
      }
      return { type, targetActorId };
    }
    if (type === 'interactive-particle-effect') {
      const id = requireString(component.id, `${path}.id`, 48);
      if (!SCENE_ID_PATTERN.test(id)) throw new TypeError(`${path}.id 格式无效`);
      if (component.preset !== 'line-art-leaves') {
        throw new TypeError(`${path}.preset 暂只支持 line-art-leaves`);
      }
      if (!Array.isArray(component.position) || component.position.length !== 3) {
        throw new TypeError(`${path}.position 必须包含 3 个数字`);
      }
      const position = component.position.map((value, axis) => (
        requireNumber(value, `${path}.position[${axis}]`)
      ));
      const particleCount = requireInteger(
        component.particleCount,
        `${path}.particleCount`,
        16,
        512,
      );
      const radius = requireNumber(component.radius, `${path}.radius`);
      if (radius < 1 || radius > 32) throw new TypeError(`${path}.radius 必须是 1-32`);
      const seed = requireInteger(component.seed, `${path}.seed`, 0, 0xffffffff);
      const interactionRadius = requireNumber(
        component.interactionRadius,
        `${path}.interactionRadius`,
      );
      if (interactionRadius < 0.1 || interactionRadius > 4) {
        throw new TypeError(`${path}.interactionRadius 必须是 0.1-4`);
      }
      const impulseStrength = requireNumber(
        component.impulseStrength,
        `${path}.impulseStrength`,
      );
      if (impulseStrength < 0.1 || impulseStrength > 12) {
        throw new TypeError(`${path}.impulseStrength 必须是 0.1-12`);
      }
      return {
        type,
        id,
        preset: component.preset,
        position,
        particleCount,
        radius,
        seed,
        fillColor: requireColor(component.fillColor, `${path}.fillColor`),
        accentColor: requireColor(component.accentColor, `${path}.accentColor`),
        lineColor: requireColor(component.lineColor, `${path}.lineColor`),
        interactionRadius,
        impulseStrength,
      };
    }
    return { type };
  });
}

function validateSceneDefinition(raw, filename, actorCatalog) {
  const scene = requireObject(raw, filename);
  if (scene.schemaVersion !== 1) throw new TypeError(`${filename}.schemaVersion 必须是 1`);
  const id = requireString(scene.id, `${filename}.id`, 48);
  if (!SCENE_ID_PATTERN.test(id)) throw new TypeError(`${filename}.id 格式无效`);
  const sceneComponents = validateSceneComponents(scene.sceneComponents, filename);

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
  if (
    sceneComponents.some((component) => component.type === 'mouse-grass-interaction')
    && !content.grass
  ) {
    throw new TypeError(
      `${filename}.sceneComponents 的 mouse-grass-interaction 需要开启 renderer.content.grass`,
    );
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
    };
    if (ocean.size < 16 || ocean.size > 1024) throw new TypeError(`${filename}.renderer.ocean.size 范围无效`);
    if (ocean.waveHeight < 0 || ocean.waveHeight > 1) throw new TypeError(`${filename}.renderer.ocean.waveHeight 范围无效`);
    if (ocean.waveSpeed < 0 || ocean.waveSpeed > 4) throw new TypeError(`${filename}.renderer.ocean.waveSpeed 范围无效`);
    if (ocean.noiseScale <= 0 || ocean.noiseScale > 1) throw new TypeError(`${filename}.renderer.ocean.noiseScale 范围无效`);
    if (ocean.noiseStrength < 0 || ocean.noiseStrength > 3) throw new TypeError(`${filename}.renderer.ocean.noiseStrength 范围无效`);
    if (ocean.interlaceStrength < 0 || ocean.interlaceStrength > 0.75) throw new TypeError(`${filename}.renderer.ocean.interlaceStrength 范围无效`);
    if (ocean.gridLineOpacity < 0 || ocean.gridLineOpacity > 1) throw new TypeError(`${filename}.renderer.ocean.gridLineOpacity 范围无效`);
  }

  let world;
  if (renderer.world !== undefined) {
    const rawWorld = requireObject(renderer.world, `${filename}.renderer.world`);
    world = {
      loadRadius: requireInteger(rawWorld.loadRadius, `${filename}.renderer.world.loadRadius`, 1, 6),
      keepRadius: requireInteger(rawWorld.keepRadius, `${filename}.renderer.world.keepRadius`, 2, 8),
      rockColor: requireColor(rawWorld.rockColor, `${filename}.renderer.world.rockColor`),
    };
    // 加载半径与保留半径相等时，站在 chunk 边界上来回走会让同一批 chunk
    // 反复构建又销毁，比不做流式加载还糟。
    if (world.keepRadius <= world.loadRadius) {
      throw new TypeError(`${filename}.renderer.world.keepRadius 必须大于 loadRadius`);
    }
    // 玩家站在自己 chunk 的边缘时，最近的未加载内容就在这么远的地方。
    // 雾必须在那之前收拢，否则 chunk 的出现与消失会被直接看见。
    if (fogFar > world.loadRadius * CHUNK_SIZE) {
      throw new TypeError(
        `${filename}.renderer.fog.far 必须不大于 ${world.loadRadius * CHUNK_SIZE}，` +
          '否则视野会越过最近的未加载 chunk',
      );
    }
  }

  const gameplay = requireObject(scene.gameplay, `${filename}.gameplay`);
  const bounds = requireObject(gameplay.bounds, `${filename}.gameplay.bounds`);
  const spawn = requireObject(gameplay.spawn, `${filename}.gameplay.spawn`);
  const minimumX = requireNumber(bounds.minimumX, `${filename}.gameplay.bounds.minimumX`);
  const maximumX = requireNumber(bounds.maximumX, `${filename}.gameplay.bounds.maximumX`);
  const minimumZ = requireNumber(bounds.minimumZ, `${filename}.gameplay.bounds.minimumZ`);
  const maximumZ = requireNumber(bounds.maximumZ, `${filename}.gameplay.bounds.maximumZ`);
  if (minimumX >= maximumX || minimumZ >= maximumZ) throw new TypeError(`${filename}.gameplay.bounds 范围无效`);
  // 流式场景的活动范围必须落在生成范围向内收过的安全区里，
  // 否则玩家能走到还没有内容的世界边缘旁边。
  if (
    world &&
    (minimumX < WORLD_PLAY_AREA.minimumX ||
      maximumX > WORLD_PLAY_AREA.maximumX ||
      minimumZ < WORLD_PLAY_AREA.minimumZ ||
      maximumZ > WORLD_PLAY_AREA.maximumZ)
  ) {
    throw new TypeError(
      `${filename}.gameplay.bounds 超出了流式世界的活动范围 ` +
        `[${WORLD_PLAY_AREA.minimumX}, ${WORLD_PLAY_AREA.maximumX}]`,
    );
  }

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
  if (
    sceneComponents.some((component) => component.type === 'ability-lab')
    && camera.mode !== 'topdown'
  ) {
    throw new TypeError(`${filename}.sceneComponents 的 ability-lab 需要 topdown 相机模式`);
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
  const actorComposition = validateActorPlacements(scene.actors, filename, actorCatalog);
  for (const component of sceneComponents) {
    if (component.type !== 'ability-lab') continue;
    const target = actorComposition.actors.find((actor) => actor.id === component.targetActorId);
    if (!target) {
      throw new TypeError(
        `${filename}.sceneComponents 的 ability-lab 引用了不存在的目标 Actor：${component.targetActorId}`,
      );
    }
    const archetype = actorComposition.actorArchetypes.find(
      (definition) => definition.id === target.archetypeId,
    );
    if (archetype?.components.render.model !== 'line-art-training-dummy') {
      throw new TypeError(
        `${filename}.sceneComponents 的 ability-lab 目标需要 line-art-training-dummy render`,
      );
    }
  }

  return {
    schemaVersion: 1,
    id,
    displayName: requireString(scene.displayName, `${filename}.displayName`, 32),
    description: requireString(scene.description, `${filename}.description`, 120),
    capacity: requireInteger(scene.capacity, `${filename}.capacity`, 1, 64),
    sceneComponents,
    ...actorComposition,
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
      ...(world ? { world } : {}),
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
  static async load(directory = DEFAULT_SCENE_DIRECTORY, actorCatalog) {
    const resolvedActorCatalog = actorCatalog ?? await ActorCatalog.load();
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.scene.json')).sort();
    if (filenames.length === 0) throw new Error(`没有找到场景配置：${directory}`);

    const definitions = [];
    for (const filename of filenames) {
      const raw = JSON.parse(await readFile(join(directory, filename), 'utf8'));
      definitions.push(validateSceneDefinition(raw, filename, resolvedActorCatalog));
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
