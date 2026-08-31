import type { SceneSummary } from '../scenes/data/SceneDefinition';
import type { RoomSummary } from './messages';

export interface RoomDirectory {
  listRooms(): Promise<RoomSummary[]>;
  listScenes(): Promise<SceneSummary[]>;
  createRoom(name: string, sceneId: string): Promise<RoomSummary>;
}

/** 大厅和建房继续走 HTTP，不与高频游戏传输绑定。 */
export class HttpRoomDirectory implements RoomDirectory {
  public constructor(
    // 原生 window.fetch 依赖正确的 Window 接收者；用包装函数调用，避免作为成员函数
    // this.fetcher() 执行时把 HttpRoomDirectory 错当成接收者而触发 Illegal invocation。
    private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}

  public async listRooms(): Promise<RoomSummary[]> {
    const response = await this.fetcher('/api/rooms');
    if (!response.ok) throw new Error('房间服务暂时不可用');
    const payload = (await response.json()) as { rooms: RoomSummary[] };
    return payload.rooms;
  }

  public async listScenes(): Promise<SceneSummary[]> {
    const response = await this.fetcher('/api/scenes');
    if (!response.ok) throw new Error('地图配置暂时不可用');
    const payload = (await response.json()) as { scenes: SceneSummary[] };
    return payload.scenes;
  }

  public async createRoom(name: string, sceneId: string): Promise<RoomSummary> {
    const response = await this.fetcher('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, sceneId }),
    });
    const payload = (await response.json()) as { room?: RoomSummary; error?: string };
    if (!response.ok || !payload.room) throw new Error(payload.error ?? '创建房间失败');
    return payload.room;
  }
}
