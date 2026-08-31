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

export interface ActorArchetypeDefinition {
  schemaVersion: 1;
  id: string;
  components: {
    buoyancy: {
      minimumBeam: number;
      minimumLength: number;
      maximumTrimRadians: number;
      minimumDraft: number;
      maximumDraft: number;
      parts: ActorBuoyancyPartDefinition[];
    };
    render: {
      model: 'line-art-raft';
      foamColor: string;
      length: number;
      width: number;
    };
  };
}

export interface SceneActorDefinition {
  id: string;
  archetypeId: string;
  position: [number, number, number];
  yaw: number;
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
