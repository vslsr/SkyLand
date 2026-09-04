import type { WeatherType } from '../weather/index';

/**
 * 鼠标拖拽史莱姆的复制状态，坐标全部在 Actor 本地空间。
 * 服务端不模拟它，只净化、超时并转发，供其他客户端复现同一次形变。
 */
export interface SlimeDragState {
  /** 命中点，Actor 本地坐标。 */
  contactX: number;
  contactY: number;
  contactZ: number;
  /** 命中点到指针目标的位移，Actor 本地坐标。 */
  pullX: number;
  pullY: number;
  pullZ: number;
}

/** 快照里的形变状态：revision 变化表示重新抓取，接收端需要重建影响权重。 */
export interface SnapshotSlimeDrag extends SlimeDragState {
  revision: number;
  /**
   * 这一次抓取有多「尖」。0 是外壳主人自己的鼠标拖拽，整团跟着走；
   * 1 是被牙齿之类的外力咬住，只在命中处拔出一个尖。由施力方决定。
   */
}

/**
 * 被外力拴住时的缰绳，世界坐标。
 *
 * 它必须过网而不是只在服务端加力：客户端预测跑的是同一份 `stepCharacter`，
 * 只有权威一侧收着，客户端就会一路走出去再被快照拽回来，变成持续的橡皮筋。
 */
export interface SnapshotLeash {
  anchorX: number;
  anchorZ: number;
  /** 绳长。以内完全自由，出了这个半径每多走一米就多拽回一分。 */
  slack: number;
  stiffness: number;
  /** 径向阻尼。没有它人会在绳长附近来回荡，而不是停在绳边上。 */
  damping: number;
  /**
   * 拖带强度。绳绷紧时被拖者的速度按它收敛到锚点速度上，所以拖拽赢过被拖者
   * 自己的驱动。不动的外力（地上的倒刺）锚点速度是 0，只拴不拖。
   */
  carry: number;
  anchorVelocityX: number;
  anchorVelocityZ: number;
}

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
  /** 背包只发给本人：别人包里有什么不是这名玩家该知道的。 */
  inventory?: Array<{ itemType: string; quantity: number }>;
  inventoryRevision?: number;
  /**
   * 物品栏内容与选中格；同样只发给本人。
   *
   * 每格带数量，因为物品栏自己持有那一摞——它是一条特殊的背包，装配是转移不是
   * 引用，所以数量在背包那份快照里已经查不到了。
   */
  hotbar?: {
    slots: Array<{ itemType: string; quantity: number } | null>;
    activeIndex: number;
  };
  /** PickupDrop Component 的运行态；口部挂点来自玩家 Actor 原型。 */
  heldActorId?: string | null;
  pickupDropRevision?: number;
  /** 正在进行的形变：自己的鼠标拖拽，或被别人咬住那一处。没有就不下发。 */
  slimeDrag?: SnapshotSlimeDrag;
  /** 正被这名玩家咬着。只有咬人的一方带，用来让交互键知道该松口了。 */
  bitingPlayerId?: string;
  /** 正被外力拴着；客户端预测必须用同一份，否则会持续橡皮筋。 */
  leash?: SnapshotLeash;
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
    action: 'cargo-toggle' | 'mushroom-bite' | 'pickup-stack' | 'harvest-prop' | 'container-open';
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
  /**
   * 容器的公开状态。`entries` 只发给正开着它的人——没开箱子的玩家不需要知道里面
   * 有什么，一屋子箱子也不会每帧把全部库存推给所有人。开着的人每帧都收到，所以
   * 别人存进去的东西会立刻出现在自己的界面上。
   */
  container?: {
    label: string;
    slotCapacity: number;
    usedSlots: number;
    viewerCount: number;
    open: boolean;
    entries?: Array<{ itemType: string; quantity: number }>;
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
  slimeDrag?: SnapshotSlimeDrag;
  bitingPlayerId?: string;
  leash?: SnapshotLeash;
}
