import type { PlayerInputFrame, RoomSnapshot } from './protocol';
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
      sequence: number;
      deltaSeconds: number;
      move: PlayerInputFrame['move'];
      sprint: boolean;
      jump?: boolean;
      yaw: number;
    }
  | { type: 'actor:claim'; actorId: string }
  | { type: 'actor:release'; actorId: string }
  | { type: 'actor:input'; actorId: string; sequence: number; throttle: number; steering: number }
  | { type: 'actor:event'; actorId: string; sequence: number; event: ActorGameplayEvent }
  | { type: 'actor:interact'; actorId: string; sequence: number };

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
}
