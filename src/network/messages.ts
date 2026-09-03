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
  /** 界面里点一下某件物品：放上快捷栏并立刻握在手上。 */
  | { kind: 'hold'; itemType: string }
  /** 切到快捷栏第 N 格；再发一次同一格就是收手。 */
  | { kind: 'select'; slotIndex: number }
  /** 前后循环一格（手柄 LB / RB）。 */
  | { kind: 'cycle'; direction: 1 | -1 }
  /** 把某件物品配置到某一格；itemType 为 null 时清空该格。 */
  | { kind: 'assign'; slotIndex: number; itemType: string | null }
  /** 按下使用键：开始蓄力。蓄力时长由服务端自己计时，客户端只报起止。 */
  | { kind: 'use:begin' }
  /** 松开使用键：结算。 */
  | { kind: 'use:release' }
  /** 蓄力被打断（界面盖上来、切走手持物）。 */
  | { kind: 'use:cancel' }
  /** 丢下手上那件。 */
  | { kind: 'drop' }
  /**
   * 交互键按下/松开。短按放下、长按收回背包，分界由服务端按自己的计时判定，
   * 客户端那圈转盘只负责让玩家看见还要按多久。
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
