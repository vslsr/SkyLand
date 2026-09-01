import type { SceneSummary } from '../scenes/data/SceneDefinition';
import { JsonMessageCodec, type MessageCodec } from './MessageCodec';
import type {
  ActorGameplayEvent,
  ClientMessage,
  JoinedRoom,
  RoomSummary,
  VesselInputFrame,
} from './messages';
import type { PlayerInputFrame, RoomSnapshot } from './protocol';
import type { WeatherType } from '../weather/index';
import { HttpRoomDirectory, type RoomDirectory } from './RoomDirectory';
import {
  WebSocketTransport,
  type GameTransport,
  type TransportChannel,
} from './transport/index';

export type {
  ActorGameplayEvent,
  JoinedRoom,
  RoomSummary,
  VesselInputFrame,
} from './messages';
export type { PlayerInputFrame, RoomSnapshot } from './protocol';

type RoomUpdateListener = (room: RoomSummary) => void;
type SnapshotListener = (snapshot: RoomSnapshot) => void;
type DisconnectListener = () => void;

export interface RoomClientOptions {
  transport?: GameTransport;
  codec?: MessageCodec;
  roomDirectory?: RoomDirectory;
  endpoint?: string | (() => string);
}

function defaultWebSocketEndpoint(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * 房间会话层：只处理房间语义、消息序号和事件分发。
 * 具体使用 WebSocket、UDP 或混合通道由注入的 GameTransport 决定。
 */
export class RoomClient {
  private readonly transport: GameTransport;
  private readonly codec: MessageCodec;
  private readonly roomDirectory: RoomDirectory;
  private readonly resolveEndpoint: () => string;
  private readonly roomListeners = new Set<RoomUpdateListener>();
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private inputSequence = 0;
  private readonly actorInputSequences = new Map<string, number>();
  private readonly actorEventSequences = new Map<string, number>();
  private actorInteractionSequence = 0;

  public constructor(options: RoomClientOptions = {}) {
    this.transport = options.transport ?? new WebSocketTransport();
    this.codec = options.codec ?? new JsonMessageCodec();
    this.roomDirectory = options.roomDirectory ?? new HttpRoomDirectory();
    const endpoint = options.endpoint;
    this.resolveEndpoint = typeof endpoint === 'function'
      ? endpoint
      : () => endpoint ?? defaultWebSocketEndpoint();

    this.transport.onPacket((payload) => this.handlePacket(payload));
    this.transport.onDisconnect(() => {
      for (const listener of this.disconnectListeners) listener();
    });
  }

  public listRooms(): Promise<RoomSummary[]> {
    return this.roomDirectory.listRooms();
  }

  public listScenes(): Promise<SceneSummary[]> {
    return this.roomDirectory.listScenes();
  }

  public createRoom(name: string, sceneId: string): Promise<RoomSummary> {
    return this.roomDirectory.createRoom(name, sceneId);
  }

  public async joinRoom(roomId: string, temporaryName: string): Promise<JoinedRoom> {
    await this.ensureTransport();

    return new Promise<JoinedRoom>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        cleanup();
        reject(new Error('加入房间超时'));
      }, 6000);

      const stopPacket = this.transport.onPacket((payload) => {
        const message = this.codec.decode(payload);
        if (!message) return;
        if (message.type === 'room:joined' && message.room && message.player && message.scene) {
          this.resetSequences();
          cleanup();
          resolve({ room: message.room, player: message.player, scene: message.scene });
        } else if (message.type === 'error') {
          cleanup();
          reject(new Error(message.message ?? '加入房间失败'));
        }
      });

      const stopDisconnect = this.transport.onDisconnect(() => {
        cleanup();
        reject(new Error('房间连接已断开'));
      });

      const cleanup = (): void => {
        globalThis.clearTimeout(timeout);
        stopPacket();
        stopDisconnect();
      };

      if (!this.send({ type: 'room:join', roomId, name: temporaryName }, 'control')) {
        cleanup();
        reject(new Error('房间连接尚未就绪'));
      }
    });
  }

  public leaveRoom(): void {
    this.resetSequences();
    this.send({ type: 'room:leave' }, 'control');
  }

  public setWeather(weather: WeatherType): void {
    this.send({ type: 'weather:set', weather }, 'control');
  }

  /**
   * 上报一帧输入。deltaSeconds 是这条输入覆盖的真实时间，
   * 服务端会用自己的时钟核对，客户端谎报也换不来额外的位移。
   * 返回本条输入的序号，调用方据此记录预测位置。
   */
  public sendPlayerInput(input: PlayerInputFrame, deltaSeconds: number): number | undefined {
    const sequence = this.inputSequence + 1;
    const sent = this.send({
      type: 'player:input',
      sequence,
      deltaSeconds,
      move: input.move,
      sprint: input.sprint,
      jump: input.jump,
      yaw: input.yaw,
    }, 'realtime');
    if (!sent) return undefined;
    this.inputSequence = sequence;
    return sequence;
  }

  public requestActorControl(actorId: string): void {
    this.send({ type: 'actor:claim', actorId }, 'control');
  }

  public releaseActorControl(actorId: string): void {
    this.send({ type: 'actor:release', actorId }, 'control');
  }

  public sendVesselInput(actorId: string, input: VesselInputFrame): number | undefined {
    const sequence = (this.actorInputSequences.get(actorId) ?? 0) + 1;
    const sent = this.send({ type: 'actor:input', actorId, sequence, ...input }, 'realtime');
    if (!sent) return undefined;
    this.actorInputSequences.set(actorId, sequence);
    return sequence;
  }

  public sendActorCargoAdd(
    actorId: string,
    cargo: { cargoId: string; mass: number; localX?: number; localZ?: number },
  ): number | undefined {
    return this.sendActorEvent(actorId, {
      type: 'cargo:add',
      cargoId: cargo.cargoId,
      mass: cargo.mass,
      localX: cargo.localX ?? 0,
      localZ: cargo.localZ ?? 0,
    });
  }

  public sendActorCargoRemove(actorId: string, cargoId: string): number | undefined {
    return this.sendActorEvent(actorId, { type: 'cargo:remove', cargoId });
  }

  public sendActorDamage(actorId: string, partId: string, amount: number): number | undefined {
    return this.sendActorEvent(actorId, { type: 'damage', partId, amount });
  }

  public interactWithActor(actorId: string): number | undefined {
    const sequence = this.actorInteractionSequence + 1;
    const sent = this.send({ type: 'actor:interact', actorId, sequence }, 'control');
    if (!sent) return undefined;
    this.actorInteractionSequence = sequence;
    return sequence;
  }

  public onRoomUpdate(listener: RoomUpdateListener): () => void {
    this.roomListeners.add(listener);
    return () => this.roomListeners.delete(listener);
  }

  public onSnapshot(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  public onDisconnect(listener: DisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private async ensureTransport(): Promise<void> {
    if (this.transport.state === 'connected') return;
    await this.transport.connect({ endpoint: this.resolveEndpoint() });
  }

  private handlePacket(payload: string | Uint8Array): void {
    const message = this.codec.decode(payload);
    if (message?.type === 'room:summary' && message.room) {
      for (const listener of this.roomListeners) listener(message.room);
    } else if (message?.type === 'room:snapshot' && message.snapshot) {
      for (const listener of this.snapshotListeners) listener(message.snapshot);
    } else if (message?.type === 'room:closed') {
      this.transport.close();
    }
  }

  private sendActorEvent(actorId: string, event: ActorGameplayEvent): number | undefined {
    const sequence = (this.actorEventSequences.get(actorId) ?? 0) + 1;
    const sent = this.send({ type: 'actor:event', actorId, sequence, event }, 'control');
    if (!sent) return undefined;
    this.actorEventSequences.set(actorId, sequence);
    return sequence;
  }

  private send(message: ClientMessage, channel: TransportChannel): boolean {
    if (this.transport.state !== 'connected') return false;
    return this.transport.send(this.codec.encode(message), channel);
  }

  private resetSequences(): void {
    this.inputSequence = 0;
    this.actorInputSequences.clear();
    this.actorEventSequences.clear();
    this.actorInteractionSequence = 0;
  }
}
