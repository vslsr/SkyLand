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

export interface SceneDefinition extends SceneSummary {
  schemaVersion: 1;
  renderer: {
    type: 'line-art';
    background: string;
    fog: { color: string; near: number; far: number };
    content: { ground: boolean; trees: boolean; grass: boolean };
    palette: {
      ground: string;
      grass: string;
      treeTrunk: string;
      treeNeedles: string;
    };
  };
  gameplay: {
    bounds: SceneBounds;
    spawn: { centerX: number; centerZ: number; radius: number; slots: number };
  };
  camera: {
    position: [number, number, number];
    yaw: number;
    pitch: number;
  };
}
