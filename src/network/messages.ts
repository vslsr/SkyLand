import type { PlayerInputStep, RoomSnapshot } from './protocol';
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

export type ClientMessage =
  | { type: 'room:join'; roomId: string; name: string }
  | { type: 'room:leave' }
  | { type: 'weather:set'; weather: WeatherType }
  | {
      type: 'player:input';
      inputs: PlayerInputStep[];
    }
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
