import type {
  PlayerTransformLogClientEvent,
  PlayerTransformLogStatus,
} from '../network/messages';

export type PlayerTransformLogState = 'inactive' | 'starting' | 'recording' | 'stopping';

export interface PlayerTransformLogRecorderTransport {
  start(): boolean;
  append(sessionId: string, events: readonly PlayerTransformLogClientEvent[]): boolean;
  stop(sessionId: string, events: readonly PlayerTransformLogClientEvent[]): boolean;
}

export interface PlayerTransformLogRecorderOptions {
  now?: () => number;
  monotonicNow?: () => number;
  maximumEvents?: number;
  batchSize?: number;
  onStateChange?: (state: PlayerTransformLogState, message?: string) => void;
}

const DEFAULT_MAXIMUM_EVENTS = 20_000;
const DEFAULT_BATCH_SIZE = 6;

/**
 * 浏览器侧玩家 Transform 诊断缓冲。
 *
 * 事件按小批次经现有可靠控制通道交给服务器，单次消息保持在 WebSocket
 * 载荷上限之下；总事件数固定封顶，长时间录制不会随世界或运行时长无限增长。
 */
export class PlayerTransformLogRecorder {
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly maximumEvents: number;
  private readonly batchSize: number;
  private readonly onStateChange?: PlayerTransformLogRecorderOptions['onStateChange'];
  private readonly pendingEvents: PlayerTransformLogClientEvent[] = [];
  private stateValue: PlayerTransformLogState = 'inactive';
  private sessionId?: string;
  private startContext?: Record<string, unknown>;
  private eventCount = 0;
  private droppedEvents = 0;

  public constructor(
    private readonly transport: PlayerTransformLogRecorderTransport,
    options: PlayerTransformLogRecorderOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.maximumEvents = Math.max(1, options.maximumEvents ?? DEFAULT_MAXIMUM_EVENTS);
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.onStateChange = options.onStateChange;
  }

  public get state(): PlayerTransformLogState {
    return this.stateValue;
  }

  public begin(context: Record<string, unknown>): boolean {
    if (this.stateValue !== 'inactive') return false;
    this.startContext = context;
    this.eventCount = 0;
    this.droppedEvents = 0;
    this.pendingEvents.length = 0;
    this.setState('starting');
    if (this.transport.start()) return true;
    this.reset('日志开启失败：房间连接尚未就绪');
    return false;
  }

  public stop(): boolean {
    const sessionId = this.sessionId;
    if (this.stateValue !== 'recording' || !sessionId) return false;
    this.record('client.recording_stopped', {
      capturedEvents: this.eventCount,
      droppedEvents: this.droppedEvents,
    });
    this.setState('stopping');
    const finalEvents = this.pendingEvents.splice(0);
    if (this.transport.stop(sessionId, finalEvents)) return true;
    this.reset('日志保存失败：房间连接已经断开');
    return false;
  }

  public record(event: string, data: Record<string, unknown>): void {
    if (this.stateValue !== 'recording') return;
    if (this.eventCount >= this.maximumEvents) {
      this.droppedEvents += 1;
      return;
    }
    this.eventCount += 1;
    const timestamp = this.now();
    this.pendingEvents.push({
      event,
      clientTime: timestamp,
      clientTimeIso: new Date(timestamp).toISOString(),
      monotonicMs: this.monotonicNow(),
      data,
    });
    if (this.pendingEvents.length >= this.batchSize) this.flush();
  }

  public handleStatus(status: PlayerTransformLogStatus): void {
    if (status.status === 'started') {
      if (this.stateValue !== 'starting' || !status.sessionId) return;
      this.sessionId = status.sessionId;
      this.setState('recording');
      this.record('client.recording_started', this.startContext ?? {});
      this.startContext = undefined;
      return;
    }

    if (status.status === 'saved') {
      if (status.sessionId !== this.sessionId) return;
      const paths = [status.clientFile, status.serverFile].filter(Boolean).join('、');
      this.reset(paths ? `日志已保存：${paths}` : '日志已保存到 logs 目录');
      return;
    }

    if (status.sessionId && this.sessionId && status.sessionId !== this.sessionId) return;
    this.reset(status.message ?? 'Transform 日志录制失败');
  }

  public handleDisconnect(): void {
    if (this.stateValue === 'inactive') return;
    this.reset('连接已断开；服务端将保存已收到的日志');
  }

  private flush(): void {
    const sessionId = this.sessionId;
    if (!sessionId || this.pendingEvents.length === 0) return;
    const events = this.pendingEvents.slice();
    if (this.transport.append(sessionId, events)) this.pendingEvents.splice(0, events.length);
  }

  private reset(message?: string): void {
    this.pendingEvents.length = 0;
    this.sessionId = undefined;
    this.startContext = undefined;
    this.setState('inactive', message);
  }

  private setState(state: PlayerTransformLogState, message?: string): void {
    this.stateValue = state;
    this.onStateChange?.(state, message);
  }
}
