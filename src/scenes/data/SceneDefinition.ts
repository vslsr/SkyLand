import type { WeatherType } from '../../weather/WeatherTypes';

export interface SceneBounds {
  minimumX: number;
  maximumX: number;
  minimumZ: number;
  maximumZ: number;
}

export interface SceneSummary {
  id: string;
  displayName: string;
  description: string;
  capacity: number;
}

export interface ActorBuoyancyPartDefinition {
  id: string;
  mass: number;
  buoyancy: number;
  integrity: number;
  localX: number;
  localZ: number;
}

interface InteractiveParticleSceneComponentBaseDefinition {
  type: 'interactive-particle-effect';
  id: string;
  preset: 'line-art-leaves';
  particleCount: number;
  /** 每个生成点覆盖的圆形落叶团半径；不会缩放单片落叶。 */
  clusterRadius: number;
  seed: number;
  fillColor: string;
  accentColor: string;
  lineColor: string;
  interactionRadius: number;
  impulseStrength: number;
}

export type InteractiveParticleSceneComponentDefinition =
  InteractiveParticleSceneComponentBaseDefinition & (
    | {
        /** 固定场景中的单个落叶团中心。 */
        position: [number, number, number];
        worldGeneration?: never;
      }
    | {
        position?: never;
        /** 流式世界中每个 chunk 的确定性候选点配置。 */
        worldGeneration: { spawnChance: number };
      }
  );

export type SceneComponentDefinition =
  | { type: 'mouse-grass-interaction' }
  | { type: 'ability-lab'; targetActorId: string }
  | InteractiveParticleSceneComponentDefinition;

export type ActorRenderDefinition =
  | {
      model: 'line-art-player-slime';
      radius: number;
      membraneColor: string;
      middleColor: string;
      coreColor: string;
      bubbleColor: string;
      inkColor: string;
      shadowColor: string;
    }
  | {
      model: 'line-art-pbf-slime';
      radius: number;
      /** 位于可变形蒙皮内部的权威圆柱半径。 */
      collisionRadius: number;
      collisionHeight: number;
      particleCount: number;
      constraintIterations: number;
      gravity: number;
      centerForce: number;
      viscosity: number;
      bubbleCount: number;
      bubbleSpeed: number;
      surfaceColor: string;
      innerColor: string;
      highlightColor: string;
      bubbleColor: string;
      inkColor: string;
      shadowColor: string;
    }
  | {
      model: 'line-art-raft';
      foamColor: string;
      length: number;
      width: number;
    }
  | {
      model: 'line-art-cargo-crate';
      color: string;
      accentColor: string;
      length: number;
      width: number;
      height: number;
    }
  | {
      model: 'line-art-reef';
      color: string;
      accentColor: string;
      radius: number;
      height: number;
    }
  | {
      model: 'line-art-elastic-mushroom';
      capColor: string;
      stemColor: string;
      spotColor: string;
      radius: number;
      height: number;
    }
  | {
      model: 'line-art-training-dummy';
      woodColor: string;
      accentColor: string;
      radius: number;
      height: number;
    }
  | {
      model: 'line-art-focus-obelisk';
      stoneColor: string;
      crystalColor: string;
      radius: number;
      height: number;
    }
  | {
      model: 'line-art-floor-plaque';
      color: string;
      accentColor: string;
      width: number;
      length: number;
      height: number;
    }
  | {
      model: 'line-art-campfire';
      stoneColor: string;
      woodColor: string;
      emberColor: string;
      radius: number;
      height: number;
    }
  | {
      model: 'line-art-dry-hay';
      color: string;
      accentColor: string;
      radius: number;
      height: number;
    }
  | {
      model: 'line-art-wood-pile';
      woodColor: string;
      cutColor: string;
      inkColor: string;
      radius: number;
      height: number;
    }
  | {
      model: 'line-art-wood-log';
      woodColor: string;
      cutColor: string;
      inkColor: string;
      radius: number;
      length: number;
    }
  | {
      model: 'line-art-stone-pile';
      stoneColor: string;
      accentColor: string;
      inkColor: string;
      radius: number;
      height: number;
    }
  | {
      model: 'line-art-fruit-pile';
      fruitColor: string;
      accentColor: string;
      inkColor: string;
      radius: number;
      height: number;
    };

export interface ActorArchetypeDefinition {
  schemaVersion: 1;
  id: string;
  components: {
    guidePath?: {
      points: Array<[number, number, number]>;
      curve: 'linear' | 'catmull-rom';
      lineColor: string;
      markerColor: string;
      lineWidth: number;
      dashLength: number;
      gapLength: number;
      dashSpeed: number;
      markerSize: number;
      hitRadius: number;
      autoAdvance: boolean;
      loop: boolean;
      enabled: boolean;
      currentPointIndex: number;
    };
    playerMovement?: {
      walkSpeed: number;
      sprintMultiplier: number;
      maximumStepHeight: number;
      acceleration?: number;
      deceleration?: number;
      airAcceleration?: number;
      airDrag?: number;
    };
    playerJump?: {
      impulse: number;
      gravity: number;
      maximumFallSpeed: number;
      airControl: number;
    };
    /** 仅客户端使用：鼠标拖拽混合史莱姆蒙皮时的局部软体参数。 */
    slimeSurfaceDrag?: {
      maximumDistance: number;
      pullForce: number;
      falloffExponent: number;
      influenceRadius: number;
    };
    buoyancy?: {
      minimumBeam: number;
      minimumLength: number;
      maximumTrimRadians: number;
      minimumDraft: number;
      maximumDraft: number;
      bobAmplitude?: number;
      bobFrequency?: number;
      parts: ActorBuoyancyPartDefinition[];
    };
    vesselMotor?: {
      maximumForwardSpeed: number;
      maximumReverseSpeed: number;
      acceleration: number;
      deceleration: number;
      drag: number;
      turnSpeed: number;
      inputTimeoutMs: number;
    };
    interactable?: {
      action: 'cargo-toggle' | 'mushroom-bite' | 'pickup-stack' | 'harvest-prop';
      label: string;
      maximumDistance: number;
    };
    cargo?: {
      mass: number;
      mountLocalX: number;
      mountLocalY: number;
      mountLocalZ: number;
    };
    elasticTether?: {
      restLength: number;
      breakLength: number;
      /** 叼住之后还要再拉出多远才拔断；缺省则沿用 breakLength 的绝对判定。 */
      pullDistance?: number;
    };
    elasticDetach?: {
    };
    pickupDrop?: {
      mouthLocalX: number;
      mouthLocalY: number;
      mouthLocalZ: number;
      mouthLocalYaw: number;
    };
    hazard?: {
      radius: number;
      damage: number;
      cooldownMs: number;
      partId: string;
    };
    temperature?: {
      initialTemperature: number;
      ambientTemperature: number;
      heatCapacity: number;
      coolingRate: number;
    };
    combustible?: {
      ignitionTemperature: number;
      extinguishTemperature: number;
      fuel: number;
      burnRate: number;
      heatOutput: number;
      heatRadius: number;
    };
    heatEmitter?: {
      power: number;
      radius: number;
      enabled: boolean;
    };
    itemStack?: {
      itemType: string;
      displayName: string;
      defaultQuantity: number;
      maximumQuantity: number;
      compatibilityKey: string;
    };
    actorResidency?: {
      sleepDelaySeconds: number;
      dormantDelaySeconds: number;
      dormantEligible: boolean;
    };
    dropMotion?: {
      gravity: number;
      drag: number;
      groundDrag?: number;
      restitution?: number;
      radius?: number;
      /** 掉落刚体的角阻尼：越小翻得越久。 */
      angularDamping?: number;
      settleSpeed: number;
    };
    lifetime?: { lifetimeSeconds: number };
    replicationPolicy?: { mode: 'always' | 'aoi'; radiusChunks: number };
    generatedProp?: {
      /** 掉血形态：采到 0 就永久消失。与 regrow 互斥。 */
      maximumHealth?: number;
      harvestDamage?: number;
      /** 冷却形态：没有血量，采一次之后过这么多秒自己长回来。与血量互斥。 */
      regrow?: { seconds: number };
      drop: {
        archetypeId: string;
        quantity: number;
        spawnPattern?: 'center' | 'center-scatter' | 'fruit-anchors';
      };
    };
    render?: ActorRenderDefinition;
  };
}

/**
 * 房间权威的天气轮换配置。服务端按它切换离散天气；客户端只按同步到的
 * 结果渲染云、雨雪与光照。
 */
export interface SceneWeatherDefinition {
  initial: WeatherType;
  /** 关闭后调试菜单的天气请求会被服务端忽略。 */
  allowPlayerControl: boolean;
  cycle?: {
    enabled: boolean;
    minimumSeconds: number;
    maximumSeconds: number;
    candidates: WeatherType[];
  };
}

/** 房间权威的昼夜配置。时刻本身随快照同步，这里描述它怎么走。 */
export interface SceneDayNightDefinition {
  /** 关闭时场景恒定停在 startHour。 */
  enabled: boolean;
  /** 启用昼夜但冻结时间，用于固定黄昏、夜景这类静态氛围。 */
  paused: boolean;
  startHour: number;
  /** 一整天（24 小时）走多少真实秒。 */
  dayLengthSeconds: number;
  allowPlayerControl: boolean;
}

export interface SceneEnvironmentDefinition {
  weather: SceneWeatherDefinition;
  dayNight: SceneDayNightDefinition;
}

export interface SceneActorDefinition {
  id: string;
  archetypeId: string;
  parentActorId?: string | null;
  /** 根 Actor 的局部坐标即世界坐标；子 Actor 的局部坐标相对父 Actor。 */
  localTransform: {
    position: [number, number, number];
    yaw: number;
  };
}

export interface OceanVisualDefinition {
  size: number;
  segments: number;
  waveHeight: number;
  waveSpeed: number;
  noiseScale: number;
  noiseStrength: number;
  interlaceStrength: number;
  surfaceColor: string;
  secondaryColor: string;
  /** 流式地形水体按海床深度混合到该颜色；固定平面海域可以省略。 */
  deepColor?: string;
  /** 达到最深颜色所需的水深（米）。 */
  depthColorRange?: number;
  gridLineColor: string;
  gridLineOpacity: number;
}

/**
 * 流式大世界的渲染参数。
 *
 * 出现这个块就表示场景的地面与物件不再是固定摆好的，而是由世界种子确定性
 * 生成、按 chunk 流式加载。世界本身的尺寸是生成算法的固有属性，写在
 * shared/world/worldConfig.mjs 里，对所有流式场景都一样；这里只配置
 * 每个场景可以自己决定的部分。
 */
export interface WorldStreamingDefinition {
  /** 以焦点所在 chunk 为中心，向外加载几圈。 */
  loadRadius: number;
  /** 走出几圈之外才卸载。必须大于 loadRadius，否则会在边界上反复建了拆。 */
  keepRadius: number;
  /** 岩石的填充色。地面、草、树的颜色沿用 palette。 */
  rockColor: string;
}

export interface WorldPropVariantDefinition {
  /** ActorCatalog 净化后的原型 id。 */
  archetypeId: string;
  /** 正整数相对权重；同一 kind 的所有项共同划分哈希区间。 */
  weight: number;
}

export interface SceneDefinition extends SceneSummary {
  schemaVersion: 1;
  sceneComponents: SceneComponentDefinition[];
  /** 房间权威的天气与昼夜推进配置；服务端净化后随 room:joined 下发。 */
  environment: SceneEnvironmentDefinition;
  actors: SceneActorDefinition[];
  actorArchetypes: ActorArchetypeDefinition[];
  renderer: {
    type: 'line-art';
    background: string;
    fog: { color: string; near: number; far: number };
    content: { ground: boolean; trees: boolean; grass: boolean; ocean: boolean };
    palette: {
      ground: string;
      grass: string;
      treeTrunk: string;
      treeNeedles: string;
    };
    ocean?: OceanVisualDefinition;
    world?: WorldStreamingDefinition;
  };
  gameplay: {
    playerActor: { archetypeId: string };
    runtimeActorArchetypes?: string[];
    /** 流式世界每种物件的带权原型变体；实例选择由世界种子确定。 */
    worldProps?: Partial<Record<
      'tree' | 'grass' | 'rock' | 'mushroom',
      WorldPropVariantDefinition[]
    >>;
    bounds: SceneBounds;
    spawn: { centerX: number; centerZ: number; radius: number; slots: number };
    water?: { seaLevel: number };
  };
  camera: {
    mode: 'topdown' | 'fly';
    position: [number, number, number];
    yaw: number;
    pitch: number;
    moveSpeed: number;
  };
}
