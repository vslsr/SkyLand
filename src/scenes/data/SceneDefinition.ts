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
