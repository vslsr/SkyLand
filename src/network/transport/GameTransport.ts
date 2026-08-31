export type TransportPayload = string | Uint8Array;
export type TransportChannel = 'control' | 'realtime';
export type DeliveryGuarantee = 'reliable-ordered' | 'unreliable-sequenced';
export type TransportState = 'disconnected' | 'connecting' | 'connected' | 'closing';

export interface TransportCapabilities {
  /** 控制消息必须可靠有序，加入房间和玩法事件依赖这一保证。 */
  control: 'reliable-ordered';
  /** 实时消息可以由 WebSocket 保证可靠，也可以由 UDP 只保留最新序列。 */
  realtime: DeliveryGuarantee;
  binary: boolean;
}

export interface TransportConnectOptions {
  endpoint: string;
}

export interface TransportDisconnect {
  code?: number;
  reason?: string;
}

export type TransportPacketListener = (payload: TransportPayload) => void;
export type TransportDisconnectListener = (disconnect: TransportDisconnect) => void;

/**
 * 游戏客户端依赖的传输能力边界。
 * channel 表达消息用途；由实现决定 realtime 最终走 WebSocket、UDP 或其他通道。
 */
export interface GameTransport {
  readonly capabilities: TransportCapabilities;
  readonly state: TransportState;

  connect(options: TransportConnectOptions): Promise<void>;
  send(payload: TransportPayload, channel: TransportChannel): boolean;
  onPacket(listener: TransportPacketListener): () => void;
  onDisconnect(listener: TransportDisconnectListener): () => void;
  close(): void;
}
