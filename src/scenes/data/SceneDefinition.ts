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

export interface InteractiveParticleSceneComponentDefinition {
  type: 'interactive-particle-effect';
  id: string;
  preset: 'line-art-leaves';
  position: [number, number, number];
  particleCount: number;
  radius: number;
  seed: number;
  fillColor: string;
  accentColor: string;
  lineColor: string;
  interactionRadius: number;
  impulseStrength: number;
}

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
    };

export interface ActorArchetypeDefinition {
  schemaVersion: 1;
  id: string;
  components: {
    playerMovement?: {
      walkSpeed: number;
      sprintMultiplier: number;
      maximumStepHeight: number;
    };
    buoyancy?: {
      minimumBeam: number;
      minimumLength: number;
      maximumTrimRadians: number;
      minimumDraft: number;
      maximumDraft: number;
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
      action: 'cargo-toggle' | 'mushroom-bite' | 'pickup-stack';
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
      mouthHeight: number;
      mouthForwardOffset: number;
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
      settleSpeed: number;
    };
    lifetime?: { lifetimeSeconds: number };
    replicationPolicy?: { mode: 'always' | 'aoi'; radiusChunks: number };
    render: ActorRenderDefinition;
  };
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

export interface SceneDefinition extends SceneSummary {
  schemaVersion: 1;
  sceneComponents: SceneComponentDefinition[];
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
