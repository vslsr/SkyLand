import type { ClientMessage, ServerMessage } from './messages';
import type { TransportPayload } from './transport/index';

export interface MessageCodec {
  encode(message: ClientMessage): TransportPayload;
  decode(payload: TransportPayload): ServerMessage | undefined;
}

/** 当前线协议继续使用 JSON；编解码与具体 Socket 类型互不依赖。 */
export class JsonMessageCodec implements MessageCodec {
  private readonly decoder = new TextDecoder();

  public encode(message: ClientMessage): TransportPayload {
    return JSON.stringify(message);
  }

  public decode(payload: TransportPayload): ServerMessage | undefined {
    try {
      const text = typeof payload === 'string' ? payload : this.decoder.decode(payload);
      const message = JSON.parse(text) as unknown;
      if (!message || typeof message !== 'object' || !('type' in message)) return undefined;
      if (typeof message.type !== 'string') return undefined;
      return message as ServerMessage;
    } catch {
      return undefined;
    }
  }
}
