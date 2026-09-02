import type { WeatherType } from '../weather/index';

/** 房间快照里的单名玩家，坐标由服务端权威计算。 */
export interface SnapshotPlayer {
  id: string;
  name: string;
  x: number;
  /** 服务端权威浮力/地形高度；旧快照缺省时客户端仍可回退本地地形采样。 */
  y?: number;
  z: number;
  yaw: number;
  speed: number;
  /** 服务端已经逐步执行到的客户端输入 tick。 */
  ackTick: number;
  /** @deprecated 过渡期快照别名；新代码只读取 ackTick。 */
  sequence: number;
  verticalVelocity?: number;
  velocityX?: number;
  velocityZ?: number;
  grounded?: boolean;
  inventory?: Array<{ itemType: string; quantity: number }>;
  inventoryRevision?: number;
}

export type ActorFloatState = 'afloat' | 'overloaded' | 'flooding' | 'sinking';
export type ActorEventType = 'cargo:add' | 'cargo:remove' | 'damage';

export interface SnapshotActor {
  id: string;
  /** 生成物件由自描述 id 里的种类查表得到原型；普通网络 Actor 必填。 */
  archetypeId?: string;
  /** 离散复制状态；切换父节点时不做插值。 */
  parentActorId?: string | null;
  revision: number;
  transform?: {
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
    action: 'cargo-toggle' | 'mushroom-bite' | 'pickup-stack' | 'harvest-prop';
    label: string;
    enabled: boolean;
    revision: number;
  };
  cargo?: {
    mass: number;
    carrierActorId: string | null;
    revision: number;
  };
  elasticTether?: {
    holderPlayerId: string | null;
    targetX: number;
    targetY: number;
    targetZ: number;
    /** 叼住那一刻的弹性长度；拔断阈值以它为起点。 */
    grabLength?: number;
    releaseRevision: number;
    revision: number;
  };
  hazard?: {
    radius: number;
  };
  thermal?: {
    temperature: number;
    burning: boolean;
    fuelRatio: number;
    revision: number;
  };
  itemStack?: {
    itemType: string;
    displayName: string;
    quantity: number;
    maximumQuantity: number;
    revision: number;
  };
  residency?: {
    state: 'active' | 'sleeping';
    revision: number;
  };
  elasticDetach?: {
    detached: boolean;
    revision: number;
    /** 脱落后由刚体解算的朝向四元数 [x, y, z, w]；未脱落时不下发。 */
    rotation?: readonly [number, number, number, number];
  };
  guidePath?: {
    points: Array<[number, number, number]>;
    curve: 'linear' | 'catmull-rom';
    enabled: boolean;
    currentPointIndex: number;
    pathRevision: number;
    revision: number;
  };
  propState?: {
    /** 掉血形态才有；可再生物件没有血量。 */
    health?: number;
    maximumHealth?: number;
    removed: boolean;
    /** 可再生物件下一次可采的绝对服务端秒数；两端各自判断有没有长回来。 */
    readyAt?: number;
    revision?: number;
  };
}

export interface RoomSnapshot {
  sceneId: string;
  tick: number;
  serverTime: number;
  weather: WeatherType;
  /** 房间权威时刻，单位小时，落在 [0, 24)。 */
  timeOfDay: number;
  /** 一整天走多少真实秒；时钟被冻结或关闭时是 0，客户端据此停止本地推进。 */
  dayLength: number;
  actors: SnapshotActor[];
  players: SnapshotPlayer[];
}

/** 上行的一帧输入：只有方向、加速开关和朝向，不含坐标。 */
export interface PlayerInputFrame {
  move: { x: number; z: number };
  sprint: boolean;
  jump?: boolean;
  yaw: number;
}

/** 客户端实际执行过的一次 60Hz 预测步；服务端按 tick 原样重放。 */
export interface PlayerInputStep extends PlayerInputFrame {
  tick: number;
}

/** 插值之后可以直接用于渲染的远端玩家状态。 */
export interface InterpolatedPlayerState {
  id: string;
  name: string;
  x: number;
  y?: number;
  z: number;
  yaw: number;
  speed: number;
  verticalVelocity?: number;
  velocityX?: number;
  velocityZ?: number;
  grounded?: boolean;
}
