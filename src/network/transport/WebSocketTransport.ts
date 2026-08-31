import type {
  GameTransport,
  TransportCapabilities,
  TransportChannel,
  TransportConnectOptions,
  TransportDisconnect,
  TransportDisconnectListener,
  TransportPacketListener,
  TransportPayload,
  TransportState,
} from './GameTransport';

const WEB_SOCKET_OPEN = 1;

export type WebSocketFactory = (endpoint: string) => WebSocket;

/** WebSocket 实现：control 与 realtime 都复用同一条可靠有序连接。 */
export class WebSocketTransport implements GameTransport {
  public readonly capabilities: TransportCapabilities = {
    control: 'reliable-ordered',
    realtime: 'reliable-ordered',
    binary: true,
  };

  private socket?: WebSocket;
  private connectPromise?: Promise<void>;
  private currentState: TransportState = 'disconnected';
  private readonly packetListeners = new Set<TransportPacketListener>();
  private readonly disconnectListeners = new Set<TransportDisconnectListener>();

  public constructor(
    private readonly socketFactory: WebSocketFactory = (endpoint) => new WebSocket(endpoint),
  ) {}

  public get state(): TransportState {
    return this.currentState;
  }

  public async connect(options: TransportConnectOptions): Promise<void> {
    if (this.currentState === 'connected') return;
    if (this.connectPromise) return this.connectPromise;

    const socket = this.socketFactory(options.endpoint);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.currentState = 'connecting';

    const promise = new Promise<void>((resolve, reject) => {
      const removeConnectListeners = (): void => {
        socket.removeEventListener('open', handleOpen);
        socket.removeEventListener('error', handleConnectError);
        socket.removeEventListener('close', handleConnectClose);
      };
      const handleOpen = (): void => {
        removeConnectListeners();
        if (this.socket !== socket) return;
        this.currentState = 'connected';
        resolve();
      };
      const handleConnectError = (): void => {
        removeConnectListeners();
        reject(new Error('无法连接房间服务器'));
      };
      const handleConnectClose = (): void => {
        removeConnectListeners();
        reject(new Error('房间连接在建立前已断开'));
      };

      socket.addEventListener('open', handleOpen, { once: true });
      socket.addEventListener('error', handleConnectError, { once: true });
      socket.addEventListener('close', handleConnectClose, { once: true });
      socket.addEventListener('message', (event) => this.handleMessage(socket, event));
      socket.addEventListener('close', (event) => this.handleClose(socket, event));
    });

    this.connectPromise = promise;
    try {
      await promise;
    } catch (error) {
      if (this.socket === socket) {
        this.socket = undefined;
        this.currentState = 'disconnected';
        socket.close();
      }
      throw error;
    } finally {
      if (this.connectPromise === promise) this.connectPromise = undefined;
    }
  }

  public send(payload: TransportPayload, _channel: TransportChannel): boolean {
    const socket = this.socket;
    if (this.currentState !== 'connected' || socket?.readyState !== WEB_SOCKET_OPEN) return false;

    try {
      socket.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  public onPacket(listener: TransportPacketListener): () => void {
    this.packetListeners.add(listener);
    return () => this.packetListeners.delete(listener);
  }

  public onDisconnect(listener: TransportDisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  public close(): void {
    if (!this.socket || this.currentState === 'disconnected') return;
    this.currentState = 'closing';
    this.socket.close();
  }

  private handleMessage(socket: WebSocket, event: MessageEvent<unknown>): void {
    if (this.socket !== socket) return;
    const payload = this.toPayload(event.data);
    if (payload === undefined) return;
    for (const listener of this.packetListeners) listener(payload);
  }

  private handleClose(socket: WebSocket, event: CloseEvent): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.currentState = 'disconnected';
    this.connectPromise = undefined;

    const disconnect: TransportDisconnect = {
      code: event.code,
      reason: event.reason || undefined,
    };
    for (const listener of this.disconnectListeners) listener(disconnect);
  }

  private toPayload(data: unknown): TransportPayload | undefined {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return undefined;
  }
}
