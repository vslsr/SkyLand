export interface RoomSummary {
  id: string;
  name: string;
  playerCount: number;
  capacity: number;
  sceneId: string;
  createdAt: string;
}

export interface JoinedRoom {
  room: RoomSummary;
  player: {
    id: string;
    name: string;
  };
}

interface ServerMessage {
  type: string;
  room?: RoomSummary;
  player?: JoinedRoom['player'];
  message?: string;
}

type RoomUpdateListener = (room: RoomSummary) => void;
type DisconnectListener = () => void;

export interface PlayerInputFrame {
  move: { x: number; y: number; z: number };
  look: { yaw: number; pitch: number };
}

export class RoomClient {
  private socket?: WebSocket;
  private socketReady?: Promise<WebSocket>;
  private readonly roomListeners = new Set<RoomUpdateListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private inputSequence = 0;

  public async listRooms(): Promise<RoomSummary[]> {
    const response = await fetch('/api/rooms');
    if (!response.ok) throw new Error('房间服务暂时不可用');
    const payload = (await response.json()) as { rooms: RoomSummary[] };
    return payload.rooms;
  }

  public async createRoom(name: string): Promise<RoomSummary> {
    const response = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const payload = (await response.json()) as { room?: RoomSummary; error?: string };
    if (!response.ok || !payload.room) throw new Error(payload.error ?? '创建房间失败');
    return payload.room;
  }

  public async joinRoom(roomId: string, temporaryName: string): Promise<JoinedRoom> {
    const socket = await this.ensureSocket();

    return new Promise<JoinedRoom>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('加入房间超时'));
      }, 6000);

      const handleMessage = (event: MessageEvent<string>): void => {
        const message = this.parseMessage(event.data);
        if (!message) return;
        if (message.type === 'room:joined' && message.room && message.player) {
          this.inputSequence = 0;
          cleanup();
          resolve({ room: message.room, player: message.player });
        } else if (message.type === 'error') {
          cleanup();
          reject(new Error(message.message ?? '加入房间失败'));
        }
      };

      const handleClose = (): void => {
        cleanup();
        reject(new Error('房间连接已断开'));
      };

      const cleanup = (): void => {
        window.clearTimeout(timeout);
        socket.removeEventListener('message', handleMessage);
        socket.removeEventListener('close', handleClose);
      };

      socket.addEventListener('message', handleMessage);
      socket.addEventListener('close', handleClose);
      socket.send(JSON.stringify({ type: 'room:join', roomId, name: temporaryName }));
    });
  }

  public leaveRoom(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'room:leave' }));
    }
  }

  public sendPlayerInput(input: PlayerInputFrame): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.inputSequence += 1;
    this.socket.send(
      JSON.stringify({
        type: 'player:input',
        sequence: this.inputSequence,
        move: input.move,
        look: input.look,
      }),
    );
  }

  public onRoomUpdate(listener: RoomUpdateListener): () => void {
    this.roomListeners.add(listener);
    return () => this.roomListeners.delete(listener);
  }

  public onDisconnect(listener: DisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private ensureSocket(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    if (this.socketReady) return this.socketReady;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;
    this.socketReady = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.addEventListener('open', () => resolve(socket), { once: true });
      socket.addEventListener('error', () => reject(new Error('无法连接房间服务器')), { once: true });
      socket.addEventListener('message', (event: MessageEvent<string>) => this.handleMessage(event));
      socket.addEventListener('close', () => {
        this.socket = undefined;
        this.socketReady = undefined;
        for (const listener of this.disconnectListeners) listener();
      });
    }).catch((error: unknown) => {
      this.socketReady = undefined;
      throw error;
    });
    return this.socketReady;
  }

  private handleMessage(event: MessageEvent<string>): void {
    const message = this.parseMessage(event.data);
    if (message?.type === 'room:summary' && message.room) {
      for (const listener of this.roomListeners) listener(message.room);
    } else if (message?.type === 'room:closed') {
      this.socket?.close();
    }
  }

  private parseMessage(data: string): ServerMessage | undefined {
    try {
      return JSON.parse(data) as ServerMessage;
    } catch {
      return undefined;
    }
  }
}
