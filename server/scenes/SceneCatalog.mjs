import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ActorCatalog, isPlayerRenderModel } from '../actors/ActorCatalog.mjs';
import { itemCatalog } from '../../shared/items/index.mjs';
import { CHUNK_SIZE, WORLD_PLAY_AREA } from '../../shared/world/worldConfig.mjs';
import { PROP_KIND_BY_NAME } from '../../shared/world/generatedProp.mjs';
import {
  WORLD_PROP_VARIANT_MAXIMUM_COUNT,
  WORLD_PROP_VARIANT_WEIGHT_MAXIMUM,
} from '../../shared/world/worldPropVariants.mjs';
import { DEFAULT_WEATHER, WEATHER_TYPES, isWeatherType } from '../../shared/weather.mjs';
import {
  DEFAULT_DAY_LENGTH_SECONDS,
  DEFAULT_START_HOUR,
  HOURS_PER_DAY,
  MAXIMUM_DAY_LENGTH_SECONDS,
  MINIMUM_DAY_LENGTH_SECONDS,
} from '../../shared/dayNight.mjs';

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

/**
 * 成片密草的参数。
 *
 * 半径上限同时是草丛在自己 chunk 内的留白，所以必须明显小于半个 chunk，
 * 否则草丛会越过 chunk 边界、在卸载时被切掉半丛。
 */
function parseGrassPatches(value, path) {
  if (value === undefined) return undefined;
  const raw = requireObject(value, path);
  const patches = {
    maxPerChunk: requireInteger(raw.maxPerChunk, `${path}.maxPerChunk`, 0, 8),
    spawnChance: requireNumber(raw.spawnChance, `${path}.spawnChance`),
    minRadius: requireNumber(raw.minRadius, `${path}.minRadius`),
    maxRadius: requireNumber(raw.maxRadius, `${path}.maxRadius`),
    bladeDensity: requireNumber(raw.bladeDensity, `${path}.bladeDensity`),
  };
  if (patches.spawnChance < 0 || patches.spawnChance > 1) {
    throw new TypeError(`${path}.spawnChance 必须在 0-1 之间`);
  }
  if (patches.minRadius <= 0 || patches.minRadius > patches.maxRadius) {
    throw new TypeError(`${path}.minRadius 必须为正且不大于 maxRadius`);
  }
  if (patches.maxRadius > CHUNK_SIZE / 4) {
    throw new TypeError(`${path}.maxRadius 必须不大于 ${CHUNK_SIZE / 4}，否则草丛会越过 chunk 边界`);
  }
  if (patches.bladeDensity <= 0 || patches.bladeDensity > 80) {
    throw new TypeError(`${path}.bladeDensity 必须在 0-80 之间`);
  }
  return patches;
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
    if (archetype.components.playerMovement) {
      throw new TypeError(
        `${path}.archetype 是玩家原型；玩家由 gameplay.playerActor 按连接动态创建`,
      );
    }
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
          'worldGeneration',
          'particleCount',
          'clusterRadius',
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
      const hasPosition = component.position !== undefined;
      const hasWorldGeneration = component.worldGeneration !== undefined;
      if (hasPosition === hasWorldGeneration) {
        throw new TypeError(`${path} 必须且只能配置 position 或 worldGeneration`);
      }
      let position;
      let worldGeneration;
      if (hasPosition) {
        if (!Array.isArray(component.position) || component.position.length !== 3) {
          throw new TypeError(`${path}.position 必须包含 3 个数字`);
        }
        position = component.position.map((value, axis) => (
          requireNumber(value, `${path}.position[${axis}]`)
        ));
      } else {
        const generation = requireObject(component.worldGeneration, `${path}.worldGeneration`);
        const generationUnknownKeys = Object.keys(generation)
          .filter((key) => key !== 'spawnChance');
        if (generationUnknownKeys.length > 0) {
          throw new TypeError(
            `${path}.worldGeneration 包含未知字段：${generationUnknownKeys.join(', ')}`,
          );
        }
        const spawnChance = requireNumber(
          generation.spawnChance,
          `${path}.worldGeneration.spawnChance`,
        );
        if (spawnChance <= 0 || spawnChance > 1) {
          throw new TypeError(`${path}.worldGeneration.spawnChance 必须大于 0 且不超过 1`);
        }
        worldGeneration = { spawnChance };
      }
      const particleCount = requireInteger(
        component.particleCount,
        `${path}.particleCount`,
        16,
        512,
      );
      const clusterRadius = requireNumber(component.clusterRadius, `${path}.clusterRadius`);
      if (clusterRadius < 1 || clusterRadius > 12) {
        throw new TypeError(`${path}.clusterRadius 必须是 1-12`);
      }
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
        ...(position ? { position } : { worldGeneration }),
        particleCount,
        clusterRadius,
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

/** 只有 tree 与 grass 有静态渲染开关；岩石永远出现，蘑菇则由 Actor 自己渲染。 */
const PROP_KIND_CONTENT_KEY = { tree: 'trees', grass: 'grass' };

/**
 * 流式世界里每种物件可以由哪些原型承载。
 *
 * 变体表放在场景而不是原型里：同一片林子可以同时有普通树与果树，服务端和
 * 客户端再用房间种子 + 放置记录地址选择同一项。原型仍只描述「它是什么」。
 */
/**
 * `gameplay.startingInventory`：新玩家进房间时直接发到背包里的物品。
 * 只在没有可采集材料的地图上用（纯海域图上扩建船体的木头）；条目必须是目录里的物品。
 */
function validateStartingInventory(raw, filename) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 8) {
    throw new TypeError(`${filename}.gameplay.startingInventory 必须是最多 8 项的数组`);
  }
  return raw.map((entry, index) => {
    const path = `${filename}.gameplay.startingInventory[${index}]`;
    const record = requireObject(entry, path);
    const itemType = requireString(record.itemType, `${path}.itemType`, 48);
    if (!itemCatalog.has(itemType)) throw new TypeError(`${path}.itemType 不是目录里的物品：${itemType}`);
    return { itemType, quantity: requireInteger(record.quantity, `${path}.quantity`, 1, 999) };
  });
}

function validateWorldProps(gameplay, filename, actorCatalog, world, content) {
  const path = `${filename}.gameplay.worldProps`;
  if (gameplay.worldProps === undefined) return {};
  if (!world) throw new TypeError(`${path} 只能用在带 renderer.world 的流式场景上`);
  const definition = requireObject(gameplay.worldProps, path);
  const bindings = {};
  for (const [kind, rawVariants] of Object.entries(definition)) {
    if (PROP_KIND_BY_NAME[kind] === undefined) {
      throw new TypeError(
        `${path} 的 ${kind} 不是已知物件种类：${Object.keys(PROP_KIND_BY_NAME).join(' / ')}`,
      );
    }
    const contentKey = PROP_KIND_CONTENT_KEY[kind];
    // 内容关掉了还绑玩法，会得到一片撞得到、采得到、但看不见的东西。
    if (contentKey && !content[contentKey]) {
      throw new TypeError(`${path}.${kind} 需要开启 renderer.content.${contentKey}`);
    }
    if (
      !Array.isArray(rawVariants)
      || rawVariants.length === 0
      || rawVariants.length > WORLD_PROP_VARIANT_MAXIMUM_COUNT
    ) {
      throw new TypeError(
        `${path}.${kind} 必须是 1-${WORLD_PROP_VARIANT_MAXIMUM_COUNT} 项的原型变体数组`,
      );
    }
    const seenArchetypes = new Set();
    bindings[kind] = rawVariants.map((rawVariant, index) => {
      const variantPath = `${path}.${kind}[${index}]`;
      const variant = requireObject(rawVariant, variantPath);
      const knownKeys = new Set(['archetype', 'weight']);
      for (const key of Object.keys(variant)) {
        if (!knownKeys.has(key)) throw new TypeError(`${variantPath}.${key} 不受支持`);
      }
      const archetypeId = requireString(variant.archetype, `${variantPath}.archetype`, 48);
      if (!SCENE_ID_PATTERN.test(archetypeId)) {
        throw new TypeError(`${variantPath}.archetype 格式无效`);
      }
      if (seenArchetypes.has(archetypeId)) {
        throw new TypeError(`${path}.${kind} 不能重复引用原型：${archetypeId}`);
      }
      seenArchetypes.add(archetypeId);
      const weight = requireInteger(
        variant.weight,
        `${variantPath}.weight`,
        1,
        WORLD_PROP_VARIANT_WEIGHT_MAXIMUM,
      );
      const archetype = actorCatalog.require(archetypeId);
      if (!archetype.components.generatedProp && !archetype.components.elasticTether) {
        throw new TypeError(
          `${variantPath} 的 ${archetypeId} 不是可采集生成物或可拖拽弹性 Actor`,
        );
      }
      if (!archetype.components.replicationPolicy) {
        throw new TypeError(`${variantPath} 的 ${archetypeId} 缺少 replicationPolicy`);
      }
      return { archetypeId, weight };
    });
  }
  return bindings;
}

const WEATHER_CYCLE_MINIMUM_SECONDS = 5;
const WEATHER_CYCLE_MAXIMUM_SECONDS = 7200;

/**
 * 天气与昼夜的房间权威配置。
 *
 * 这一块决定服务端「怎么切」：初始状态、是否自动轮换、一整天走多少真实秒，
 * 以及客户端能不能提出切换请求。表现参数一律不在这里——客户端只按同步到的
 * 离散天气和时刻渲染。
 */
function validateEnvironment(raw, filename) {
  const path = `${filename}.environment`;
  const environment = raw === undefined ? {} : requireObject(raw, path);
  for (const key of Object.keys(environment)) {
    if (key !== 'weather' && key !== 'dayNight') {
      throw new TypeError(`${path}.${key} 不受支持`);
    }
  }

  const rawWeather = environment.weather === undefined
    ? {}
    : requireObject(environment.weather, `${path}.weather`);
  for (const key of Object.keys(rawWeather)) {
    if (key !== 'initial' && key !== 'allowPlayerControl' && key !== 'cycle') {
      throw new TypeError(`${path}.weather.${key} 不受支持`);
    }
  }
  const initial = rawWeather.initial ?? DEFAULT_WEATHER;
  if (!isWeatherType(initial)) {
    throw new TypeError(`${path}.weather.initial 必须是 ${WEATHER_TYPES.join(' / ')}`);
  }
  const allowWeatherControl = rawWeather.allowPlayerControl === undefined
    ? true
    : requireBoolean(rawWeather.allowPlayerControl, `${path}.weather.allowPlayerControl`);

  let cycle;
  if (rawWeather.cycle !== undefined) {
    const cyclePath = `${path}.weather.cycle`;
    const rawCycle = requireObject(rawWeather.cycle, cyclePath);
    for (const key of Object.keys(rawCycle)) {
      if (
        key !== 'enabled'
        && key !== 'minimumSeconds'
        && key !== 'maximumSeconds'
        && key !== 'candidates'
      ) {
        throw new TypeError(`${cyclePath}.${key} 不受支持`);
      }
    }
    const minimumSeconds = requireNumber(rawCycle.minimumSeconds, `${cyclePath}.minimumSeconds`);
    const maximumSeconds = requireNumber(rawCycle.maximumSeconds, `${cyclePath}.maximumSeconds`);
    if (
      minimumSeconds < WEATHER_CYCLE_MINIMUM_SECONDS
      || maximumSeconds > WEATHER_CYCLE_MAXIMUM_SECONDS
      || maximumSeconds < minimumSeconds
    ) {
      throw new TypeError(
        `${cyclePath} 的间隔必须落在 ${WEATHER_CYCLE_MINIMUM_SECONDS}-${WEATHER_CYCLE_MAXIMUM_SECONDS} 秒且 maximumSeconds 不小于 minimumSeconds`,
      );
    }
    if (!Array.isArray(rawCycle.candidates) || rawCycle.candidates.length === 0) {
      throw new TypeError(`${cyclePath}.candidates 必须是至少 1 项的天气数组`);
    }
    const candidates = [];
    for (const [index, candidate] of rawCycle.candidates.entries()) {
      if (!isWeatherType(candidate)) {
        throw new TypeError(`${cyclePath}.candidates[${index}] 不是已知天气`);
      }
      if (candidates.includes(candidate)) {
        throw new TypeError(`${cyclePath}.candidates 不能重复：${candidate}`);
      }
      candidates.push(candidate);
    }
    const enabled = rawCycle.enabled === undefined
      ? true
      : requireBoolean(rawCycle.enabled, `${cyclePath}.enabled`);
    // 只有一项候选时轮换永远切不出新天气，等于配置写错了。
    if (enabled && candidates.length < 2) {
      throw new TypeError(`${cyclePath}.candidates 启用轮换时至少需要 2 种天气`);
    }
    cycle = { enabled, minimumSeconds, maximumSeconds, candidates };
  }

  const rawDayNight = environment.dayNight === undefined
    ? {}
    : requireObject(environment.dayNight, `${path}.dayNight`);
  for (const key of Object.keys(rawDayNight)) {
    if (
      key !== 'enabled'
      && key !== 'paused'
      && key !== 'startHour'
      && key !== 'dayLengthSeconds'
      && key !== 'allowPlayerControl'
    ) {
      throw new TypeError(`${path}.dayNight.${key} 不受支持`);
    }
  }
  const dayNightEnabled = rawDayNight.enabled === undefined
    ? false
    : requireBoolean(rawDayNight.enabled, `${path}.dayNight.enabled`);
  const paused = rawDayNight.paused === undefined
    ? false
    : requireBoolean(rawDayNight.paused, `${path}.dayNight.paused`);
  const startHour = rawDayNight.startHour === undefined
    ? DEFAULT_START_HOUR
    : requireNumber(rawDayNight.startHour, `${path}.dayNight.startHour`);
  if (startHour < 0 || startHour >= HOURS_PER_DAY) {
    throw new TypeError(`${path}.dayNight.startHour 必须落在 [0, ${HOURS_PER_DAY})`);
  }
  const dayLengthSeconds = rawDayNight.dayLengthSeconds === undefined
    ? DEFAULT_DAY_LENGTH_SECONDS
    : requireNumber(rawDayNight.dayLengthSeconds, `${path}.dayNight.dayLengthSeconds`);
  if (
    dayLengthSeconds < MINIMUM_DAY_LENGTH_SECONDS
    || dayLengthSeconds > MAXIMUM_DAY_LENGTH_SECONDS
  ) {
    throw new TypeError(
      `${path}.dayNight.dayLengthSeconds 必须落在 ${MINIMUM_DAY_LENGTH_SECONDS}-${MAXIMUM_DAY_LENGTH_SECONDS} 秒`,
    );
  }
  const allowDayNightControl = rawDayNight.allowPlayerControl === undefined
    ? true
    : requireBoolean(rawDayNight.allowPlayerControl, `${path}.dayNight.allowPlayerControl`);

  return {
    weather: {
      initial,
      allowPlayerControl: allowWeatherControl,
      ...(cycle ? { cycle } : {}),
    },
    dayNight: {
      enabled: dayNightEnabled,
      paused,
      startHour,
      dayLengthSeconds,
      allowPlayerControl: allowDayNightControl,
    },
  };
}

function validateSceneDefinition(raw, filename, actorCatalog) {
  const scene = requireObject(raw, filename);
  if (scene.schemaVersion !== 1) throw new TypeError(`${filename}.schemaVersion 必须是 1`);
  const id = requireString(scene.id, `${filename}.id`, 48);
  if (!SCENE_ID_PATTERN.test(id)) throw new TypeError(`${filename}.id 格式无效`);
  const sceneComponents = validateSceneComponents(scene.sceneComponents, filename);
  const environment = validateEnvironment(scene.environment, filename);

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
      ...(rawOcean.deepColor === undefined
        ? {}
        : { deepColor: requireColor(rawOcean.deepColor, `${filename}.renderer.ocean.deepColor`) }),
      ...(rawOcean.depthColorRange === undefined
        ? {}
        : {
            depthColorRange: requireNumber(
              rawOcean.depthColorRange,
              `${filename}.renderer.ocean.depthColorRange`,
            ),
          }),
      gridLineColor: requireColor(rawOcean.gridLineColor, `${filename}.renderer.ocean.gridLineColor`),
      gridLineOpacity: requireNumber(rawOcean.gridLineOpacity, `${filename}.renderer.ocean.gridLineOpacity`),
    };
    if (ocean.size < 16 || ocean.size > 1024) throw new TypeError(`${filename}.renderer.ocean.size 范围无效`);
    if (ocean.waveHeight < 0 || ocean.waveHeight > 1) throw new TypeError(`${filename}.renderer.ocean.waveHeight 范围无效`);
    if (ocean.waveSpeed < 0 || ocean.waveSpeed > 4) throw new TypeError(`${filename}.renderer.ocean.waveSpeed 范围无效`);
    if (ocean.noiseScale <= 0 || ocean.noiseScale > 1) throw new TypeError(`${filename}.renderer.ocean.noiseScale 范围无效`);
    if (ocean.noiseStrength < 0 || ocean.noiseStrength > 3) throw new TypeError(`${filename}.renderer.ocean.noiseStrength 范围无效`);
    if (ocean.interlaceStrength < 0 || ocean.interlaceStrength > 0.75) throw new TypeError(`${filename}.renderer.ocean.interlaceStrength 范围无效`);
    if (ocean.depthColorRange !== undefined && (ocean.depthColorRange <= 0 || ocean.depthColorRange > 32)) {
      throw new TypeError(`${filename}.renderer.ocean.depthColorRange 范围无效`);
    }
    if (ocean.gridLineOpacity < 0 || ocean.gridLineOpacity > 1) throw new TypeError(`${filename}.renderer.ocean.gridLineOpacity 范围无效`);
  }

  let world;
  if (renderer.world !== undefined) {
    const rawWorld = requireObject(renderer.world, `${filename}.renderer.world`);
    world = {
      loadRadius: requireInteger(rawWorld.loadRadius, `${filename}.renderer.world.loadRadius`, 1, 6),
      keepRadius: requireInteger(rawWorld.keepRadius, `${filename}.renderer.world.keepRadius`, 2, 8),
      rockColor: requireColor(rawWorld.rockColor, `${filename}.renderer.world.rockColor`),
      grassPatches: parseGrassPatches(rawWorld.grassPatches, `${filename}.renderer.world.grassPatches`),
    };
    if (world.grassPatches === undefined) delete world.grassPatches;
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
  const playerActor = requireObject(gameplay.playerActor, `${filename}.gameplay.playerActor`);
  const playerActorArchetypeId = requireString(
    playerActor.archetype,
    `${filename}.gameplay.playerActor.archetype`,
    48,
  );
  if (!SCENE_ID_PATTERN.test(playerActorArchetypeId)) {
    throw new TypeError(`${filename}.gameplay.playerActor.archetype 格式无效`);
  }
  const playerActorArchetype = actorCatalog.require(playerActorArchetypeId);
  const playerRenderModel = playerActorArchetype.components.render.model;
  if (
    !playerActorArchetype.components.playerMovement
    || !isPlayerRenderModel(playerRenderModel)
  ) {
    throw new TypeError(
      `${filename}.gameplay.playerActor 需要 playerMovement + 玩家史莱姆 render 原型`,
    );
  }
  const runtimeActorArchetypeIds = gameplay.runtimeActorArchetypes ?? [];
  if (!Array.isArray(runtimeActorArchetypeIds) || runtimeActorArchetypeIds.length > 32) {
    throw new TypeError(`${filename}.gameplay.runtimeActorArchetypes 必须是最多 32 项的数组`);
  }
  const runtimeActorArchetypes = runtimeActorArchetypeIds.map((archetypeId, index) => {
    const path = `${filename}.gameplay.runtimeActorArchetypes[${index}]`;
    const id = requireString(archetypeId, path, 48);
    if (!SCENE_ID_PATTERN.test(id)) throw new TypeError(`${path} 格式无效`);
    const archetype = actorCatalog.require(id);
    if (archetype.components.playerMovement) throw new TypeError(`${path} 不能引用玩家原型`);
    return archetype;
  });
  if (new Set(runtimeActorArchetypeIds).size !== runtimeActorArchetypeIds.length) {
    throw new TypeError(`${filename}.gameplay.runtimeActorArchetypes 不能重复`);
  }
  // 水上地基引用的船体根节点原型一并进场景表：立船时服务端要按它生成根节点，
  // 客户端要按它给幽灵找网格。地基的大小还得和那艘船的格宽一致。
  const hullArchetypes = runtimeActorArchetypes.flatMap((archetype, index) => {
    const hullId = archetype.components.buildPiece?.hull;
    if (!hullId) return [];
    const path = `${filename}.gameplay.runtimeActorArchetypes[${index}]`;
    let hull;
    try {
      hull = actorCatalog.require(hullId);
    } catch {
      throw new TypeError(`${path} 的 ${archetype.id} 引用了不存在的船体原型：${hullId}`);
    }
    if (!hull.components.buildGrid || !hull.components.buoyancy) {
      throw new TypeError(`${path} 的船体原型 ${hullId} 需要 buildGrid + buoyancy`);
    }
    if (Math.abs(archetype.components.render.size - hull.components.buildGrid.cellSize) > 1e-6) {
      throw new TypeError(`${path} 的 ${archetype.id} 尺寸必须等于 ${hullId} 的格宽`);
    }
    return [hull];
  });
  const startingInventory = validateStartingInventory(gameplay.startingInventory, filename);
  const worldProps = validateWorldProps(gameplay, filename, actorCatalog, world, content);
  if (
    sceneComponents.some((component) => (
      component.type === 'interactive-particle-effect' && component.worldGeneration
    ))
    && !world
  ) {
    throw new TypeError(
      `${filename}.sceneComponents 的 interactive-particle-effect.worldGeneration `
        + '需要 renderer.world',
    );
  }
  const spawn = requireObject(gameplay.spawn, `${filename}.gameplay.spawn`);
  // 流式场景可以不写 bounds：世界是按种子无边生成的，玩家想走多远走多远，
  // 活动范围直接取 WORLD_PLAY_AREA——它不是玩法边界，而是数值精度的护栏。
  // 固定尺寸的场景没有这个选项：那里的地面只有一块，边界必须由作者写死。
  if (!world && gameplay.bounds === undefined) {
    throw new TypeError(`${filename}.gameplay.bounds 必须是对象`);
  }
  const bounds = gameplay.bounds === undefined
    ? WORLD_PLAY_AREA
    : requireObject(gameplay.bounds, `${filename}.gameplay.bounds`);
  const minimumX = requireNumber(bounds.minimumX, `${filename}.gameplay.bounds.minimumX`);
  const maximumX = requireNumber(bounds.maximumX, `${filename}.gameplay.bounds.maximumX`);
  const minimumZ = requireNumber(bounds.minimumZ, `${filename}.gameplay.bounds.minimumZ`);
  const maximumZ = requireNumber(bounds.maximumZ, `${filename}.gameplay.bounds.maximumZ`);
  if (minimumX >= maximumX || minimumZ >= maximumZ) throw new TypeError(`${filename}.gameplay.bounds 范围无效`);
  // 写死的活动范围仍然必须落在生成范围向内收过的安全区里，
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
  if (!actorComposition.actorArchetypes.some((definition) => definition.id === playerActorArchetype.id)) {
    actorComposition.actorArchetypes.push(playerActorArchetype);
  }
  for (const archetype of runtimeActorArchetypes) {
    if (!actorComposition.actorArchetypes.some((definition) => definition.id === archetype.id)) {
      actorComposition.actorArchetypes.push(archetype);
    }
  }
  // worldProps 变体引用的原型，连同它们掉落的堆叠原型，一并进入场景的原型表。
  // 作者不用再把这些 id 在 runtimeActorArchetypes 里重复写一遍——那份重复正是
  // 「绑了但忘了带进来」这类错误的来源。
  const includeArchetype = (archetype) => {
    if (!actorComposition.actorArchetypes.some((definition) => definition.id === archetype.id)) {
      actorComposition.actorArchetypes.push(archetype);
    }
  };
  for (const hull of hullArchetypes) includeArchetype(hull);
  for (const [kind, variants] of Object.entries(worldProps)) {
    for (const [index, variant] of variants.entries()) {
      const archetype = actorCatalog.require(variant.archetypeId);
      includeArchetype(archetype);
      // 完整复制的场景 Actor（当前是弹性蘑菇）没有采集掉落；它的原型到这里
      // 已经完整进入场景表，后续由服务端按生成记录实例化即可。
      if (!archetype.components.generatedProp) continue;
      const dropArchetypeId = archetype.components.generatedProp.drop.archetypeId;
      // 掉落必须真的存在且可堆叠，否则要等玩家采到那一下才会炸在交互路径上。
      let dropArchetype;
      try {
        dropArchetype = actorCatalog.require(dropArchetypeId);
      } catch {
        throw new TypeError(
          `${filename}.gameplay.worldProps.${kind}[${index}] 的 ${variant.archetypeId} ` +
            `掉落引用了不存在的原型：${dropArchetypeId}`,
        );
      }
      if (!dropArchetype.components.itemStack) {
        throw new TypeError(
          `${filename}.gameplay.worldProps.${kind}[${index}] 的掉落原型 ` +
            `${dropArchetypeId} 没有 itemStack`,
        );
      }
      includeArchetype(dropArchetype);
    }
  }
  // 物品堆原型一律进表，不管这张地图长不长得出来。
  //
  // 背包里的一件东西要拿到手上、或者从包里直接丢到地上，两条路都得先按 itemType
  // 找到它掉在地上时用的那个原型；找不到就**静悄悄地什么都不做**——菜单点了没反应、
  // 手上不出模型，玩家只会以为界面坏了。而「这张地图的 worldProps 掉不掉它」根本
  // 决定不了背包里有没有它：弹弹菇是玩家自己揣进包的，储物箱里的东西可以是任何
  // 一种，换个场景带着背包过来更是常事。
  for (const archetype of actorCatalog.archetypes()) {
    if (archetype.components.itemStack) includeArchetype(archetype);
  }
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
    if (archetype?.components.render?.model !== 'line-art-training-dummy') {
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
    environment,
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
      playerActor: { archetypeId: playerActorArchetype.id },
      runtimeActorArchetypes: runtimeActorArchetypeIds.slice(),
      ...(startingInventory.length > 0 ? { startingInventory } : {}),
      worldProps: Object.fromEntries(
        Object.entries(worldProps).map(([kind, variants]) => [
          kind,
          variants.map((variant) => ({ ...variant })),
        ]),
      ),
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
