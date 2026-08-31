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
export type ActorEventType = 'cargo:add' | 'cargo:remove' | 'damage';

export interface SnapshotActor {
  id: string;
  archetypeId: string;
  /** 离散复制状态；切换父节点时不做插值。 */
  parentActorId?: string | null;
  revision: number;
  transform: {
    x: number;
    y: number;
    z: number;
    yaw: number;
  };
  localTransform?: {
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
    cargoMass: number;
    damagedPartCount: number;
    eventRevision: number;
    lastEvent: { type: ActorEventType; targetId: string } | null;
  };
  vessel?: {
    speed: number;
    throttle: number;
    steering: number;
  };
  control?: {
    ownerPlayerId: string | null;
    revision: number;
  };
  interactable?: {
    action: 'cargo-toggle';
    label: string;
    enabled: boolean;
    revision: number;
  };
  cargo?: {
    mass: number;
    carrierActorId: string | null;
    revision: number;
  };
  hazard?: {
    radius: number;
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
