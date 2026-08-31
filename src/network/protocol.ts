/** 房间快照里的单名玩家，坐标由服务端权威计算。 */
export interface SnapshotPlayer {
  id: string;
  name: string;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  sequence: number;
}

export type ActorFloatState = 'afloat' | 'overloaded' | 'flooding' | 'sinking';

export interface SnapshotActor {
  id: string;
  archetypeId: string;
  revision: number;
  transform: {
    x: number;
    y: number;
    z: number;
    yaw: number;
  };
  buoyancy?: {
    state: ActorFloatState;
    draft: number;
    staticRoll: number;
    staticPitch: number;
    speedFactor: number;
  };
}

export interface RoomSnapshot {
  sceneId: string;
  tick: number;
  serverTime: number;
  actors: SnapshotActor[];
  players: SnapshotPlayer[];
}

/** 上行的一帧输入：只有方向、加速开关和朝向，不含坐标。 */
export interface PlayerInputFrame {
  move: { x: number; z: number };
  sprint: boolean;
  yaw: number;
}

/** 插值之后可以直接用于渲染的远端玩家状态。 */
export interface InterpolatedPlayerState {
  id: string;
  name: string;
  x: number;
  z: number;
  yaw: number;
  speed: number;
}
