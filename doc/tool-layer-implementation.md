# ToolLayer 落地形态：H5 编辑器 + C++ 运行时

> 上下文见 `engine-migration-roadmap.md`（§7 分层架构 · ToolLayer）
> 结论：**H5 编辑器 + 本地 web 服务器，不内嵌 webview；游戏视图用页面里的 WASM 运行时，不另开原生窗口**
> 依赖：无。ToolLayer 不在关键路径上，可与路线图第 0／1／2 步并行推进

问题：ToolLayer 用 H5 实现、Core 用 C++ 实现，两者怎么接？是本地起一个 web 服务器，还是把 Tool 层内嵌进 C++ 进程？

---

## 1. 「本地起一个 web 服务器」不是要新建的东西

这个服务器已经在仓库里，而且就是游戏现在的启动方式（`npm start` → `node server/index.mjs`）：

| 文件 | 职责 |
| --- | --- |
| `server/http/ApiRouter.mjs` | `/api/health` · `/api/rooms` · `/api/scenes`（GET + POST） |
| `server/http/StaticWebServer.mjs` | 静态站点；`/ws` 与 `/api/` 之外的路径都归它 |
| `server/network/WebSocketGateway.mjs` | `/ws` |

单端口同时提供 Web + API + WebSocket。**编辑器不是新架构，是给已有的 `ApiRouter` 加几个路由**（`/api/scenes/:id` 的 PUT、`/api/actors/*` 之类）。

所以这个方案的启动成本接近零，而内嵌 webview 要从头引入一个新的大依赖。

---

## 2. 真正的难点：游戏画面和编辑器 UI 怎么合起来

「服务器还是内嵌」表面上是进程结构问题，实质是**画面和 UI 的合成问题**。三种做法：

| | 做法 | 评价 |
| --- | --- | --- |
| A1 | 编辑器在浏览器，游戏在原生窗口 | 实现简单，但两个窗口体验割裂 |
| A2 | 运行时把画面编码成视频流推给浏览器 | 延迟高、编码开销大，只适合远程编辑场景 |
| **A3** | **编辑器页面里跑 WASM 版运行时，游戏视图就是页面里的 `<canvas>`** | **零 IPC、零协议、零窗口割裂 —— 推荐** |

推荐 A3，理由很直接：**Web 目标本来就在，运行时本来就有 WASM 版，编辑器直接用它就行。** 这是 Cocos Creator / PlayCanvas / Laya 的模型——编辑器天然是 Web 的，因为运行时本来就有 Web 版。

```text
推荐形态（A3）

  浏览器（一个标签页）
  ┌──────────────────────────────────────────────────┐
  │   编辑器 UI (H5/DOM)      │      游戏视图          │
  │   层级树 / 属性面板        │      <canvas>         │
  │   地形笔刷 / Actor 列表    │      WASM 运行时       │
  │   ↑ 主线程                │      ↑ Sim/Render Worker│
  └──────────────┬───────────────────────┬───────────┘
                 │ /api/*                │ /ws
                 ▼                       ▼
       ┌────────────────────────────────────────┐
       │      已有的 Node 单端口服务器            │ ← 不是新东西
       │  ApiRouter · StaticWebServer · WS       │
       └──────────────────┬─────────────────────┘
                          │ fork
                    房间进程（权威世界）

  native 构建 = 同一份 C++ 的另一个编译目标，不带编辑器
```

**这和路线图 §3 的线程布局是同一张图。** 编辑器 UI 是 DOM，天然住主线程；运行时住 Sim / Render worker。编辑器不需要额外的线程设计——它就是主线程上多出来的那部分 UI，而主线程在那套布局里本来就只剩 UI 和输入。

---

## 3. 内嵌 webview 的代价

| 方案 | 问题 |
| --- | --- |
| CEF | 分发体积 ~100–200 MB |
| Ultralight / Sciter | 体积小，但**商业授权**，且 HTML/CSS 只是子集 |
| 系统 webview（WebView2 / WKWebView / WebKitGTK） | 体积小，但**三个平台三套行为**，CSS 兼容性坑多 |

外加一个所有方案共有的硬骨头：**webview 与原生 GL 窗口的透明合成**，每个平台都是不同的坑。调试体验也全面弱于浏览器。

而它买到的只有**「单窗口」这一个体验优势**。

这正是路线图里建议把 DOM 从 CoreLayer 砍掉时说的那笔成本——**嵌 webview 只是把「自研 DOM」换成「别人的 DOM」，成本降低了但没消失**。而在编辑器这个场景里，浏览器已经免费提供了同样的东西。

---

## 4. 最大的复用：编辑器就是一个特殊的客户端

这条比架构选型更值钱。地形编辑**现在已经是**这个模型：

```text
客户端发编辑指令 → 服务端权威校验 → 广播 terrain patch → 所有客户端 applyTerrainPatches
```

而且 `SceneRenderer.applyTerrainPatches` 的注释写明「客户端不做本地预测，所以这是覆盖层唯一的写入口」。

**编辑器天然就是这个模型的一个权限更高的客户端**，不是一套平行系统。由此两条具体约定：

### 4.1 协议不要新发明

复用 `src/network/transport/GameTransport.ts` 的 `reliable-ordered` 通道和现有的 `JsonMessageCodec`，只增加几种消息类型。避免引入第二套网络栈——传输层已经按 `reliable-ordered | unreliable-sequenced` 抽象好，编辑器消息走可靠通道即可。

### 4.2 两条路径各司其职，不要混

| 改什么 | 走哪条 | 语义 |
| --- | --- | --- |
| `config/*.json`（场景、Actor 原型） | `/api/*`（HTTP PUT） | 落盘，带 `.schema.json` 校验，是**内容的真相** |
| 世界运行时状态（地形格、Actor 实例） | `/ws`（WebSocket） | 实时，服务端权威，是**当前这局的状态** |

混在一起会导致「编辑器改了但没落盘」或「落盘了但当前房间没更新」这类难查的不一致。

---

## 5. 必须守住的一条纪律

A3 意味着**编辑器编辑的是 WASM 版运行时里的世界**。这要求：

> **native 构建是 web 构建的超集，不是分叉。**

一旦出现 native-only 的渲染特性或 gameplay 行为，编辑器就看不到它了，编辑结果与实际运行会对不上。

这条是路线图里「Web 是 PlatformLayer 的一个后端，不是特例」那条原则的延伸，也和「Web 后端先行」的实践建议一致。

---

## 6. ToolLayer 的现有地基

`config/` 里 23 个 Actor 原型 + 6 张地图**全是 JSON，并且都带 `.schema.json`**，加上已有的 `TerrainEditorPanel` 与 `DebugMenuPage`，编辑器地基是现成的。

关键设计取向：**编辑器编辑的是那些 JSON，不是运行时对象。** 这样编辑器与运行时之间只有一份 schema 契约，不需要反射系统，也不需要运行时暴露内部结构——对小团队是巨大的省力。

---

## 7. 结论所依据的现状

| 位置 | 事实 |
| --- | --- |
| `server/http/ApiRouter.mjs` | 已有 `/api/health` · `/api/rooms` · `/api/scenes`，GET 与 POST 均在 |
| `server/http/StaticWebServer.mjs` | 已有静态站点服务；`/ws` 与 `/api/` 之外的路径归它 |
| `server/network/WebSocketGateway.mjs` | 已有 `/ws`，与 HTTP 共用单端口 |
| `src/network/transport/GameTransport.ts:3` | `reliable-ordered \| unreliable-sequenced` 双通道，编辑器消息可直接复用 |
| `src/rendering/SceneRenderer.ts` · `applyTerrainPatches` | 注释写明「客户端不做本地预测，所以这是覆盖层唯一的写入口」 |
| `config/` | 23 个 `*.actor.json` + 6 个 `*.scene.json`，两类各带一份 `.schema.json` |
| `src/ui/` | 12 个文件中 8 个使用 `document.createElement`，UI 完全是 DOM + CSS |
| 已有编辑器入口 | `src/ui/TerrainEditorPanel.ts` · `src/ui/pages/DebugMenuPage.ts` |
