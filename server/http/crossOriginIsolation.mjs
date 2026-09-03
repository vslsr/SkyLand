/**
 * 跨源隔离响应头（引擎迁移路线图 第 0 步）。
 *
 * `SharedArrayBuffer` 与 Emscripten pthreads 只在 `crossOriginIsolated === true`
 * 的文档里可用，而这需要文档同时带上 COOP `same-origin` 与 COEP `require-corp`。
 * 这一层是后续「Sim / Render Worker 之间靠 SAB 交换字节」的唯一前置条件，
 * 与渲染架构无关，可以独立上线。
 *
 * COEP `require-corp` 会拦住没有 CORP 头的**跨源**子资源。本仓库目前零外部
 * 资源（全部几何与材质都是程序化生成的），所以打开它不会挡掉任何东西；
 * 之后若引入 CDN 字体或图片，必须让对方带上 `Cross-Origin-Resource-Policy`，
 * 否则会静默加载失败。
 */

export const CROSS_ORIGIN_ISOLATION_HEADERS = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  // 同源资源在 require-corp 下本来就放行，显式标注是为了让「这份响应属于哪个源」
  // 成为可读的契约，而不是依赖 fetch 规范的默认值。
  'Cross-Origin-Resource-Policy': 'same-origin',
});

/**
 * 在路由之前调用一次即可：`setHeader` 写入的头会与之后 `writeHead(status, headers)`
 * 传入的对象合并，所以静态文件、API 与错误响应共用同一份隔离策略。
 */
export function applyCrossOriginIsolation(response) {
  for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
    response.setHeader(name, value);
  }
}
