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
      model: 'line-art-legged-slime';
      /** 软体身体的半径；身体本身沿用 `line-art-player-slime` 的那套外壳。 */
      radius: number;
      /** 静止站立时髋点离地高度。腿把身体撑到这里，软体不再贴地。 */
      hipHeight: number;
      /** 两条腿髋点的半间距。 */
      legSpread: number;
      legCount: number;
      thighLength: number;
      shinLength: number;
      /** 粗线的半径——腿是圆柱，不是 LineSegments：WebGL 忽略 linewidth。 */
      legThickness: number;
      /** 脚那一小段折角的长度。膝盖不单画节点，两节骨头的夹角就是关节。 */
      footLength: number;
      /** 落脚点离理想位置多远就迈一步。 */
      stepLength: number;
      /** 迈步时脚抬起的弧高。 */
      stepHeight: number;
      /** 一次迈步的时长，秒。 */
      stepDuration: number;
      membraneColor: string;
      middleColor: string;
      coreColor: string;
      bubbleColor: string;
      inkColor: string;
      shadowColor: string;
      legColor: string;
      /** 落脚点那枚灰色贴地椭圆。它是画出来的接触提示，不是光照阴影。 */
      footShadowColor: string;
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
      /** 储物箱：箱体加一块绕后沿翻起的盖子，开合由 container Component 决定。 */
      model: 'line-art-storage-chest';
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
    }
  | {
      model: 'line-art-slingshot-pile';
      frameColor: string;
      bandColor: string;
      inkColor: string;
      radius: number;
      height: number;
    }
  | {
      model: 'line-art-mushroom-pile';
      capColor: string;
      stemColor: string;
      inkColor: string;
      radius: number;
      height: number;
    }
  | {
      /** 地基（静态 / 水上）：原点在底面中心，从 y=0 长到 thickness；边长必须等于建造格宽。 */
      model: 'line-art-build-foundation';
      size: number;
      thickness: number;
      plankColor: string;
      accentColor: string;
      inkColor: string;
    }
  | {
      /** 墙 / 舷墙：沿本地 X 展开，原点在墙脚中心；宽度必须等于所在网格的格宽。 */
      model: 'line-art-build-wall';
      width: number;
      height: number;
      thickness: number;
      color: string;
      accentColor: string;
      inkColor: string;
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
    /**
     * 服务端权威的固定巡逻路线；路点在 Actor 局部空间。客户端不读它——位置整段
     * 由快照插值而来——列在这里是为了让原型的形状在两侧对得上。
     */
    patrolPath?: {
      waypoints: Array<[number, number, number]>;
      speed: number;
      waitSeconds: number;
      mode: 'ping-pong' | 'loop';
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
    /** 可被外力捏变形的软体外壳；形变本身不改玩法状态。 */
    softBodyDeformation?: {
      breakDistance: number;
      selfReportTimeoutMs?: number;
    };
    /** 能咬住别的软体的一张嘴；挂点复用 pickupDrop 的口部。 */
    bite?: {
      range: number;
      facingDot?: number;
      /** 牙齿捏起来的那块皮有多深（米）：贴身咬时尖的保底长度，客户端算突起向量要用。 */
      gripDepth?: number;
      leashSlack?: number;
      leashStiffness?: number;
      leashDamping?: number;
      leashCarry?: number;
    };
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
    /** 角色能带走的货位数；不写按 DEFAULT_SLOT_CAPACITY。 */
    inventory?: {
      slotCapacity: number;
      hotbarCapacity?: number;
    };
    /** 可存取的容器：箱子、船舱。和背包共用同一套堆叠与货位规则。 */
    container?: {
      slotCapacity: number;
      label: string;
      /** 离开这个距离服务端替玩家关掉界面。 */
      reach: number;
    };
    pickupDrop?: {
      mouthLocalX: number;
      mouthLocalY: number;
      mouthLocalZ: number;
      mouthLocalYaw: number;
    };
    /**
     * 建造件：地基、墙或物件。放在哪种表面、占一格 / 一条边 / 一个槽、花多少材料。
     * 放在哪一格是运行态，随快照复制，不在原型里。
     */
    buildPiece?: {
      kind: 'foundation' | 'wall' | 'fixture';
      /** 物件可以是 any：两种表面都能放。 */
      surface: 'floating' | 'static' | 'any';
      label: string;
      reach: number;
      cost: Array<{ itemType: string; quantity: number }>;
      mass: number;
      buoyancy: number;
      /** 物件占格中心的哪个槽：同槽互斥，异槽共存。 */
      slot?: string;
      /** 水上地基放在开阔水面上时立起来的船体根节点原型。 */
      hull?: string;
    };
    /** 载具身上的建造网格：船体自带几格甲板、格多宽、甲板面多高、最多往外扩几格。 */
    buildGrid?: {
      cellSize: number;
      columns: number;
      rows: number;
      deckHeight: number;
      extentCells: number;
      maxPieces: number;
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
    /**
     * 点亮周围的一盏灯（篝火、提灯）。**纯表现**：不进温度结算，也不复制——
     * 服务端只负责把这份配置发下来，亮不亮由客户端按火焰状态或 `enabled` 决定。
     *
     * 半径与热源的 `heatEmitter.radius` 是两回事：光比热走得远。
     */
    pointLight?: {
      /** 光源附近的颜色。 */
      color: string;
      /** 光晕边缘的颜色。不写就和 `color` 相同。 */
      edgeColor?: string;
      /** 照明半径（米）。 */
      radius: number;
      /** 强度倍率。1 是参考项目壁炉那一档。 */
      intensity: number;
      /** 光心相对 Actor 原点抬高多少米。不写按 0。 */
      heightOffset?: number;
      /** 闪烁幅度 [0, 1]。不写按 0（稳定的灯）。 */
      flicker?: number;
      /** 没有火焰状态可跟随时的静态开关。 */
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
  /**
   * 成片密草的生成参数。
   *
   * 不写这一块时，草地只有生成器放置的稀疏草簇；写了则在此之上按 chunk
   * 确定性地叠一层不规则凸多边形草丛，数量与半径都有上界。
   */
  grassPatches?: WorldGrassPatchDefinition;
}

export interface WorldGrassPatchDefinition {
  /** 每个 chunk 至多几丛。 */
  maxPerChunk: number;
  /** 每一丛独立出现的概率。 */
  spawnChance: number;
  /** 外接半径的下限与上限（米）。 */
  minRadius: number;
  maxRadius: number;
  /** 每平方米的叶片数。 */
  bladeDensity: number;
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
    /** 新玩家进房间时发到背包里的物品；给没有可采集材料的地图用。 */
    startingInventory?: { itemType: string; quantity: number }[];
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
