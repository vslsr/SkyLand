import type { PlayerInputStep, RoomSnapshot, SlimeDragState } from './protocol';
import type { SceneDefinition } from '../scenes/data/SceneDefinition';
import type { WeatherType } from '../weather/index';

export interface RoomSummary {
  id: string;
  name: string;
  playerCount: number;
  capacity: number;
  sceneId: string;
  sceneName: string;
  /** 房间的世界种子，客户端据此生成与服务端一致的地形与物件。 */
  worldSeed: number;
  createdAt: string;
  idleExpiresAt: string | null;
}

export interface JoinedRoom {
  room: RoomSummary;
  scene: SceneDefinition;
  player: {
    id: string;
    name: string;
    slot: number;
    spawn: { x: number; z: number };
  };
}

export interface VesselInputFrame {
  throttle: number;
  steering: number;
}

export interface PlayerTransformLogClientEvent {
  event: string;
  clientTime: number;
  clientTimeIso: string;
  monotonicMs: number;
  data: Record<string, unknown>;
}

export interface PlayerTransformLogStatus {
  status: 'started' | 'saved' | 'error';
  sessionId?: string;
  clientFile?: string;
  serverFile?: string;
  message?: string;
}

export type ActorGameplayEvent =
  | { type: 'cargo:add'; cargoId: string; mass: number; localX: number; localZ: number }
  | { type: 'cargo:remove'; cargoId: string }
  | { type: 'damage'; partId: string; amount: number };

/**
 * 背包、快捷栏与容器的全部上行意图。
 *
 * 合成一条消息而不是六七条，是因为它们共享同一套前置校验（玩家在不在、序号有没有
 * 回退），并且都以「改完权威 Component、让下一帧快照去确认」收尾。传输层因此只需要
 * 认识一个 case，服务端只需要一个入口。
 */
export type InventoryCommand =
  /** 切到物品栏第 N 格；再发一次同一格就是收手。 */
  | { kind: 'select'; slotIndex: number }
  /** 前后循环一格（手柄 LB / RB）。 */
  | { kind: 'cycle'; direction: 1 | -1 }
  /**
   * 装配：把背包里那一摞搬进物品栏某格。
   *
   * 这是一次**转移**而不是配置一个引用——物品栏是一条特殊的背包，装配之后那一摞
   * 就归它了，背包里不再有。`itemType` 为 null 时反过来，把那一格收回背包。
   */
  | { kind: 'assign'; slotIndex: number; itemType: string | null }
  /** 物品栏两格对调（在物品栏条上把一格拖到另一格）。 */
  | { kind: 'hotbar:swap'; fromIndex: number; slotIndex: number }
  /** 把物品栏某格整摞收回背包（从物品栏条往背包格子里拖）。 */
  | { kind: 'hotbar:stow'; slotIndex: number }
  /**
   * 背包菜单里点「使用」：授予这件东西的能力，等着按使用键激活。
   *
   * 「使用」不再是「拿到手上」：物品的用法是一条临时授予玩家的 Ability，点按或
   * 长按激活，完成后收回，全程不经过手。
   */
  | { kind: 'use:arm'; itemType: string }
  /** 按下使用键。长按倒计时的起点由服务端记，客户端只报起止。 */
  | { kind: 'use:begin' }
  /** 松开使用键。点按的那一下在这里激活；长按没走完倒计时则是取消。 */
  | { kind: 'use:release' }
  /** 这次按下被打断（界面盖上来、切走手持物）。 */
  | { kind: 'use:cancel' }
  /** 丢下手上那件。 */
  | { kind: 'drop' }
  /**
   * 从背包里直接丢一个到身前，不经过手。
   *
   * 和 `drop` 分开是因为它们说的不是同一件东西：`drop` 丢的是手上那件，
   * 背包菜单里的「丢弃」丢的是被点中的那一堆。
   */
  | { kind: 'drop:stack'; itemType: string }
  /**
   * 从物品栏某格丢一个到身前。
   *
   * 物品栏里那一格点「丢弃」说的是**那一格**，不是背包里同名的那一摞——两本账
   * 各记各的，按 itemType 丢会丢错一本。手上正握着的那一格也走这条，落点、扣账
   * 和别的格子完全一样。
   */
  | { kind: 'drop:hotbar'; slotIndex: number }
  /**
   * 交互键按下/松开。短按放下、长按收回背包，分界由服务端按自己的计时判定，
   * 客户端那圈圆形倒计时只负责让玩家看见还要按多久。
   */
  | { kind: 'stow:begin' }
  | { kind: 'stow:release' }
  | { kind: 'stow:cancel' }
  | { kind: 'container:open'; actorId: string }
  | { kind: 'container:close'; actorId: string }
  | {
      kind: 'container:transfer';
      actorId: string;
      itemType: string;
      quantity: number;
      direction: 'store' | 'withdraw';
    };

/**
 * 建造的上行意图。
 *
 * 发的是**格坐标**而不是世界坐标：服务端按自己手里的载具位姿把它还原成世界位姿，
 * 再跑和客户端同一份放置规则。世界坐标过网只会让两端各自取整一次。
 */
export type BuildCommand =
  | {
      kind: 'place';
      /** 建造件原型 id；它的 buildPiece 说明是地基、墙还是物件，放水上还是静态。 */
      archetypeId: string;
      surface: 'floating' | 'static';
      /** 水上件吸附到哪艘船；水上地基不带它就是在这一格立一艘新船；静态件不带。 */
      hullActorId?: string;
      cellX: number;
      cellZ: number;
      /** 墙占的那条格边：north 是格子 +Z 侧，east 是 +X 侧；地基与物件不带。 */
      edge?: 'north' | 'east';
    }
  | { kind: 'remove'; actorId: string };

export type ClientMessage =
  | { type: 'room:join'; roomId: string; name: string }
  | { type: 'room:leave' }
  | { type: 'weather:set'; weather: WeatherType }
  | { type: 'daynight:set'; timeOfDay: number }
  | {
      type: 'player:input';
      inputs: PlayerInputStep[];
    }
  | { type: 'player:slime-drag'; drag: SlimeDragState | null }
  | { type: 'player:bite' }
  | { type: 'debug:transform-log:start' }
  | {
      type: 'debug:transform-log:events';
      sessionId: string;
      events: PlayerTransformLogClientEvent[];
    }
  | {
      type: 'debug:transform-log:stop';
      sessionId: string;
      events: PlayerTransformLogClientEvent[];
    }
  | { type: 'actor:claim'; actorId: string }
  | { type: 'actor:release'; actorId: string }
  | { type: 'actor:input'; actorId: string; sequence: number; throttle: number; steering: number }
  | { type: 'actor:event'; actorId: string; sequence: number; event: ActorGameplayEvent }
  | { type: 'actor:interact'; actorId: string; sequence: number }
  | { type: 'inventory:command'; sequence: number; command: InventoryCommand }
  | { type: 'build:command'; sequence: number; command: BuildCommand }
  | {
      type: 'terrain:edit';
      sequence: number;
      cellX: number;
      cellZ: number;
      operation: TerrainEditOperation;
    };

/** 地形编辑操作。服务端有同名分支，改这里就要同步改 ServerScene.applyTerrainOperation。 */
export type TerrainEditOperation =
  | 'raise'
  | 'lower'
  | 'flatten'
  | 'water'
  | 'ground'
  | 'reset';

/**
 * 服务端消息会随功能继续扩展；公共信封只约束现有客户端真正读取的字段，
 * 具体消息仍由 type 判别，避免传输适配器认识房间业务。
 */
export interface ServerMessage {
  type: string;
  room?: RoomSummary;
  player?: JoinedRoom['player'];
  snapshot?: RoomSnapshot;
  scene?: SceneDefinition;
  message?: string;
  /** room:terrain 携带的地形覆盖格；只有服务端确认过的编辑会出现在这里。 */
  cells?: Array<{ cellX: number; cellZ: number; code: number }>;
  transformLog?: PlayerTransformLogStatus;
}
