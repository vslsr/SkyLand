import type { SceneSummary } from '../scenes/data/SceneDefinition';
import { JsonMessageCodec, type MessageCodec } from './MessageCodec';
import type {
  ActorGameplayEvent,
  ClientMessage,
  JoinedRoom,
  PlayerTransformLogClientEvent,
  PlayerTransformLogStatus,
  RoomSummary,
  VesselInputFrame,
} from './messages';
import type { TerrainEditOperation } from './messages';
import type { PlayerInputStep, RoomSnapshot, SlimeDragState } from './protocol';
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
  PlayerTransformLogClientEvent,
  PlayerTransformLogStatus,
  RoomSummary,
  VesselInputFrame,
} from './messages';
export type { PlayerInputFrame, PlayerInputStep, RoomSnapshot } from './protocol';

type RoomUpdateListener = (room: RoomSummary) => void;
type SnapshotListener = (snapshot: RoomSnapshot) => void;
type DisconnectListener = () => void;
type PlayerTransformLogListener = (status: PlayerTransformLogStatus) => void;

/** 服务端确认过的一格地形覆盖。code 的打包格式见 terrainConfig.mjs。 */
export interface TerrainPatchCell {
  cellX: number;
  cellZ: number;
  code: number;
}
type TerrainPatchListener = (cells: readonly TerrainPatchCell[]) => void;

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
  private readonly playerTransformLogListeners = new Set<PlayerTransformLogListener>();
  private readonly terrainListeners = new Set<TerrainPatchListener>();
  private readonly actorInputSequences = new Map<string, number>();
  private readonly actorEventSequences = new Map<string, number>();
  private actorInteractionSequence = 0;
  private terrainEditSequence = 0;

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

  /** 请求房间跳到某个时刻；服务端按场景配置决定接不接受。 */
  public setTimeOfDay(timeOfDay: number): void {
    this.send({ type: 'daynight:set', timeOfDay }, 'control');
  }

  /** 上报仍未被服务端确认的固定模拟步；丢包时下一包会自然重带旧步。 */
  public sendPlayerInput(inputs: readonly PlayerInputStep[]): number | undefined {
    if (inputs.length === 0) return undefined;
    const payload = inputs.map((input) => ({
      tick: input.tick,
      move: { x: input.move.x, z: input.move.z },
      sprint: input.sprint,
      jump: input.jump,
      yaw: input.yaw,
    }));
    if (!this.send({ type: 'player:input', inputs: payload }, 'realtime')) return undefined;
    return payload.at(-1)?.tick;
  }

  /**
   * 上报鼠标拖拽形变。它不参与预测与和解，服务端也不重放，只是转发给其他玩家，
   * 所以走独立消息而不是挤进按 tick 重放的输入流。
   */
  public sendSlimeDrag(drag: SlimeDragState | null): boolean {
    return this.send({ type: 'player:slime-drag', drag }, 'realtime');
  }

  /**
   * 咬住 / 松口。一次按键一条消息，不带目标：由谁被咬完全由服务端按权威位姿判定。
   */
  public toggleBite(): boolean {
    return this.send({ type: 'player:bite' }, 'control');
  }

  public startPlayerTransformLog(): boolean {
    return this.send({ type: 'debug:transform-log:start' }, 'control');
  }

  public appendPlayerTransformLog(
    sessionId: string,
    events: readonly PlayerTransformLogClientEvent[],
  ): boolean {
    if (events.length === 0) return true;
    return this.send({
      type: 'debug:transform-log:events',
      sessionId,
      events: [...events],
    }, 'control');
  }

  public stopPlayerTransformLog(
    sessionId: string,
    events: readonly PlayerTransformLogClientEvent[],
  ): boolean {
    return this.send({
      type: 'debug:transform-log:stop',
      sessionId,
      events: [...events],
    }, 'control');
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

  public onTerrainPatch(listener: TerrainPatchListener): () => void {
    this.terrainListeners.add(listener);
    return () => this.terrainListeners.delete(listener);
  }

  /**
   * 请求修改一格地形。**不做本地预测**：服务端校验通过后会广播回来，
   * 那时才真正写进本地覆盖层。地形直接决定站在哪里，抢跑一帧再被拉回去
   * 比晚一个 RTT 难受得多。
   */
  public editTerrain(
    cellX: number,
    cellZ: number,
    operation: TerrainEditOperation,
  ): number | undefined {
    const sequence = this.terrainEditSequence + 1;
    const sent = this.send({ type: 'terrain:edit', sequence, cellX, cellZ, operation }, 'control');
    if (!sent) return undefined;
    this.terrainEditSequence = sequence;
    return sequence;
  }

  public onDisconnect(listener: DisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public onPlayerTransformLogStatus(listener: PlayerTransformLogListener): () => void {
    this.playerTransformLogListeners.add(listener);
    return () => this.playerTransformLogListeners.delete(listener);
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
    } else if (message?.type === 'room:terrain' && Array.isArray(message.cells)) {
      for (const listener of this.terrainListeners) listener(message.cells as TerrainPatchCell[]);
    } else if (message?.type === 'debug:transform-log:status' && message.transformLog) {
      for (const listener of this.playerTransformLogListeners) listener(message.transformLog);
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
    this.actorInputSequences.clear();
    this.actorEventSequences.clear();
    this.actorInteractionSequence = 0;
    this.terrainEditSequence = 0;
  }
}
