export interface RuntimeLocation {
  readonly hostname: string;
}

const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

/**
 * Vite 开发客户端和本机组合服务器都属于开发运行时。
 * 生产构建部署到非回环地址时保持关闭，避免把调试入口暴露给正式玩家。
 */
export function isDevelopmentRuntime(
  runtimeLocation: RuntimeLocation | undefined = typeof location === 'undefined' ? undefined : location,
): boolean {
  if (import.meta.env?.DEV === true) return true;
  return LOOPBACK_HOSTNAMES.has(runtimeLocation?.hostname.toLowerCase() ?? '');
}
