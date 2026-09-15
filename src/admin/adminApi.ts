export interface AdminSessionState {
  enabled: boolean;
  authenticated: boolean;
  passwordMinimumLength: number;
}

export interface AdminOverview {
  rooms: number;
  maxRooms: number;
  players: number;
  capacity: number;
  idleRooms: number;
  scenes: number;
  uptimeSeconds: number;
  residentMemoryMB: number;
  heapUsedMB: number;
  nodeVersion: string;
  settingsPath: string;
  settingsPersisted: boolean;
}

export interface AdminRoomPlayer {
  id: string;
  name: string;
  slot: number;
}

export interface AdminRoom {
  id: string;
  name: string;
  playerCount: number;
  capacity: number;
  sceneId: string;
  sceneName: string;
  worldSeed: number;
  createdAt: string;
  idleExpiresAt: string | null;
  players: AdminRoomPlayer[];
}

export interface AdminScene {
  id: string;
  displayName: string;
  description: string;
  capacity: number;
  roomCount: number;
  playerCount: number;
}

export type AdminLogLevel = 'info' | 'warn' | 'error';

export interface AdminLogEntry {
  id: number;
  level: AdminLogLevel;
  time: string;
  message: string;
}

export interface AdminSettings {
  maxRooms: number;
  emptyRoomTtlSeconds: number;
  passwordUpdatedAt: string | null;
}

export interface AdminSettingsLimits {
  unlimitedRooms: number;
  maximumRooms: number;
  minimumEmptyRoomTtlSeconds: number;
  maximumEmptyRoomTtlSeconds: number;
  passwordMinimumLength: number;
}

export interface AdminSettingsResponse {
  settings: AdminSettings;
  limits: AdminSettingsLimits;
  settingsPath: string;
  settingsPersisted: boolean;
  currentRooms: number;
}

/** 后台会话失效（401）。控制台据此退回登录页，而不是把「请先登录」当成普通报错弹出来。 */
export class AdminUnauthorizedError extends Error {
  public constructor(message = '后台登录已过期，请重新登录。') {
    super(message);
    this.name = 'AdminUnauthorizedError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    credentials: 'same-origin',
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...init,
  });

  let payload: unknown = undefined;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (response.status === 401) throw new AdminUnauthorizedError();
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

/**
 * 后台 REST 客户端。
 *
 * 登录态走 HttpOnly cookie，页面脚本读不到也删不掉它；这里只负责把 401 翻译成
 * AdminUnauthorizedError，让上层统一退回登录页。
 */
export const adminApi = {
  session: () => request<AdminSessionState>('/session'),
  login: (password: string) => request<{ ok: true }>('/session', {
    method: 'POST',
    body: JSON.stringify({ password }),
  }),
  logout: () => request<{ ok: true }>('/session', { method: 'DELETE' }),
  changePassword: (current: string, next: string) => request<{ ok: true; message: string; persisted: boolean }>(
    '/password',
    { method: 'POST', body: JSON.stringify({ current, next }) },
  ),
  overview: () => request<{ overview: AdminOverview }>('/overview'),
  rooms: () => request<{ rooms: AdminRoom[]; maxRooms: number }>('/rooms'),
  closeRoom: (roomId: string) => request<{ ok: true }>(`/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' }),
  scenes: () => request<{ scenes: AdminScene[] }>('/scenes'),
  logs: (level: AdminLogLevel | 'all', query: string) => {
    const search = new URLSearchParams({ level, limit: '200' });
    if (query) search.set('q', query);
    return request<{ entries: AdminLogEntry[]; total: number; capacity: number }>(`/logs?${search.toString()}`);
  },
  settings: () => request<AdminSettingsResponse>('/settings'),
  saveSettings: (maxRooms: number, emptyRoomTtlSeconds: number) => request<{
    settings: AdminSettings;
    persisted: boolean;
  }>('/settings', { method: 'PUT', body: JSON.stringify({ maxRooms, emptyRoomTtlSeconds }) }),
};
