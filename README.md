# SkyLand

基于 Vite、TypeScript、Three.js、Node.js 与 WebSocket 的低多边形联机场景原型。

当前包含：

- Three.js 淡色填充与 `EdgesGeometry` 线稿场景
- 512 × 512 米的大世界：地形与物件由世界种子确定性生成，按 chunk 流式加载
- Rust 编译的 WebAssembly 生成后端，附行为一致的纯 JS 降级实现
- `Scene` / `SceneManager` 场景生命周期
- 每个 Scene 独立的 `CommonUIManager` 栈
- 房间大厅、Grid 房间卡片和通用弹出窗体
- 游戏内低存在感菜单，可主动退出当前房间并返回空场景大厅
- 空房间 60 秒后自动回收，房间卡片显示服务端回收倒计时
- Node.js 单端口 Web/API/WebSocket 组合服务器和每房间独立 DS 子进程
- 参考项目风格的透明软体史莱姆玩家
- Fly / TopDown 双控制器自动切换
- 大厅空场景、JSON 地图目录与创建房间时的地图选择
- 服务端权威的移动同步：输入上行、快照广播、客户端预测与和解

## 运行与联机测试

环境要求：Node.js 20 或更高版本、npm。

### 生产模式：一个 Node.js 同时提供 Web 与游戏 DS

构建客户端并启动组合服务器：

```powershell
cd E:\h5\SkyLand
npm run start:prod
```

`start:prod` 会先执行 TypeScript 检查和 Vite 生产构建，再启动 Node.js。已经存在
最新 `dist/` 时，可以跳过重复构建：

```powershell
npm start
```

浏览器访问 `http://127.0.0.1:3090/`。同一个 Node.js HTTP Server 会同时提供：

- `dist/` 下的 Web 客户端静态文件
- `/api/*` 房间大厅接口
- `/ws` WebSocket 游戏连接
- 每个房间对应的独立 Node.js DS 子进程

如果直接执行 `npm start` 但没有 `dist/index.html`，大厅 API 和 DS 仍会启动，Web
页面返回 `503` 并提示先执行 `npm run build`。

组合服务器默认监听 `0.0.0.0:3090`，局域网设备可直接使用服务器电脑的 IPv4
地址访问。可以通过环境变量覆盖监听地址、端口和 Web 根目录：

```powershell
$env:SKYLAND_SERVER_HOST = '127.0.0.1'
$env:SKYLAND_SERVER_PORT = '3090'
$env:SKYLAND_WEB_ROOT = 'E:\h5\SkyLand\dist'
npm start
```

组合服务入口：

| 地址 | 用途 |
| --- | --- |
| `/` | Vite 构建后的 Web 客户端；无扩展名的客户端路由回退到 `index.html` |
| `/api/health` | 服务角色、房间数量和 Web 构建状态 |
| `/api/rooms` | 查询或创建房间 |
| `/api/rooms/:id` | 删除指定房间 |
| `/api/scenes` | 查询所有可选择地图的摘要 |
| `/api/scenes/:id` | 查询服务器校验后的完整场景 JSON |
| `/ws` | WebSocket 游戏会话、输入上行和快照广播 |

健康检查示例：

```json
{
  "ok": true,
  "role": "web-and-dedicated-server",
  "roomCount": 0,
  "webReady": true
}
```

### 开发模式：Vite 热更新 + Node.js DS

当前项目不需要额外开启“联机模式”。开发时同时启动 Node.js 服务器和 Vite
客户端，创建或加入房间即可开始联机。

打开两个终端，并都进入项目目录：

```powershell
cd E:\h5\SkyLand
```

第一个终端启动 Node.js 组合服务器。开发模式下它负责 API、WebSocket 和 DS，静态
页面由 Vite 提供：

```powershell
npm run server
```

看到下面的信息表示服务器已经就绪：

```text
SkyLand web + DS server listening on http://0.0.0.0:3090
```

第二个终端启动网页客户端：

```powershell
npm run dev
```

本机浏览器访问 `http://127.0.0.1:5180/`。第一个客户端填写临时名称并创建房间，
然后使用另一个浏览器、无痕窗口或另一台设备打开相同地址，选择刚创建的房间加入。

### 局域网设备加入

Vite 开发服务器监听 `0.0.0.0:5180`。在服务器电脑运行 `ipconfig` 找到局域网
IPv4 地址，例如 `192.168.1.20`，同一局域网中的手机或电脑即可访问：

```text
http://192.168.1.20:5180/
```

客户端的 `/api` 和 `/ws` 请求会由 Vite 代理到本机 `127.0.0.1:3090`，因此房间
服务器端口不需要直接暴露到局域网。如果其他设备无法访问，应检查 Windows 防火墙
是否允许 Node.js 使用专用网络。

如果 `5180` 端口已被占用，可以先停止该端口上的旧进程再重新启动：

```powershell
npm run kill-port
npm run dev
```

- 生产组合服务：`http://127.0.0.1:3090`
- 开发客户端：`http://127.0.0.1:5180`
- 开发房间服务端：`http://127.0.0.1:3090`
- 生产预览：`http://127.0.0.1:4180`

测试与构建：

```bash
npm test          # 服务端与客户端纯逻辑测试
npm run build
npm run build:wasm  # 只有改了 native/ 下的 Rust 源码才需要
```

`chunkgen.wasm` 是签入仓库的，日常开发不需要安装 Rust 工具链。

`tests/` 下的客户端测试通过项目内的轻量 TypeScript 测试加载器运行，只覆盖不依赖
DOM 与 Three.js 的纯逻辑（标签、和解、快照插值），因此不参与 `tsc` 构建。

## 大世界与 Chunk 系统

场景配置里出现 `renderer.world` 就表示这张地图是流式大世界：地面与物件不再是
摆好的固定内容，而是由世界种子确定性生成、按 chunk 加载。`config/scenes/open-world.scene.json`
是内置的这样一张地图，`grassland` 与 `open-meadow` 保持原来的固定场景。

世界是 16 × 16 个 chunk，每个 chunk 32 米见方，合计 512 × 512 米。世界尺寸是
生成算法的固有属性，写在 `shared/world/worldConfig.mjs` 里，对所有流式场景都一样；
场景配置只决定加载半径、保留半径和岩石配色。

玩家的活动范围比生成范围向内收两个 chunk（384 × 384 米），因此永远走不到没有
内容的世界边缘旁边。`SceneCatalog` 在启动时校验这两条约束：

- `gameplay.bounds` 必须落在这个安全区内；
- `renderer.fog.far` 必须不大于 `loadRadius × 32`，否则视野会越过最近的未加载
  chunk，玩家会直接看到地块凭空出现。

配错了服务器起不来，并会指出是哪一个场景文件的哪一项。

### 静态物件永远不走网络

树、草、岩石不是数据，而是一个函数的输出：

```text
(世界种子, chunk 坐标) ──确定性算法──▶ 物件列表
```

房间进程在创建房间时分配一个 32 位世界种子，随房间摘要下发。客户端拿到种子后
自己算出每个 chunk 里有哪些物件，服务端算出的是同一批。网络上因此只需要传活动
实体，静态内容一个字节都不用同步——这也是后续做范围同步（AOI）的前提。

跨端一致靠的是**整数域运算**：`shared/world/hash.mjs` 与 `chunkContent.mjs` 全程
只用 32 位整数，坐标用毫米、朝向用毫弧度、缩放用千分数，最后才统一除以 1000。
JS 的 `Math.imul` 与 Rust 的 `wrapping_mul` 在位级等价，所以浏览器、房间进程和
WASM 算出的世界必然逐位相同。一旦这里引入浮点，就可能出现「你看得见那棵树、
我看不见」的分裂。`server/tests/chunkGenerator.test.mjs` 守着这条不变量。

### 流式加载

`ChunkStreamer` 是一个 `SceneVisualSystem`，随场景创建、随场景销毁。它以焦点
（有玩家时是玩家，没有玩家时是相机）所在的 chunk 为中心加载周围 `loadRadius` 圈，
走出 `keepRadius` 圈之外才卸载。两个半径不同是刻意的：相等的话，站在 chunk 边界上
来回走会让同一批 chunk 反复构建又销毁，`SceneCatalog` 因此拒绝相等的配置。

计划本身是纯函数（`shared/world/chunkStream.mjs`），只在跨过 chunk 边界时重算一次；
每帧最多构建一个 chunk，玩家高速穿越时补齐会晚几帧，但这段延迟被雾效盖住了。

### 每个 chunk 三次 draw call

一个 chunk 的地面、树、草、岩石被合批成**一份**填充几何体和**一份**轮廓线几何体，
颜色随顶点走（`createFillMaterial` 的 `vertexTint`），所以树干与树冠仍是各自的配色，
但整块地只用一种材质。加上同场景全部 chunk 共用的地面网格线，一个 chunk 固定三次
draw call，视野内 25 个 chunk 合计 75 次。

`renderer.content` 的 `ground` / `trees` / `grass` 开关在流式场景里改为决定 chunk
里放什么：关掉某一类就注册一个空模板。放置结果本身不受影响——放置算法在 WASM 与
JS 两个后端之间必须逐位一致，所以它不接受任何逐场景的开关。

顶点已经是世界坐标，承载它们的对象留在原点，Three.js 自动算出的包围球就落在
正确位置上，视锥剔除按 chunk 生效。

### WASM 生成后端

`native/chunkgen` 是一个 `no_std` 的 Rust crate，编译到 `wasm32-unknown-unknown`，
产物 3.4 KB。它做两件事：放置算法，以及把模板几何体按每个物件的位置、朝向、
缩放变换后写进一整块连续的顶点缓冲。模板几何体仍由 Three.js 在 JS 侧生成后
一次性上传，所以线稿模型的定义只有 `src/models/` 一处，Rust 不重复实现三角化。

`shared/world/chunkGenerator.mjs` 里有一份行为完全一致的 JS 实现。WASM 加载失败
时自动降级，世界照样是同一个；用 `?chunkgen=js` 打开页面可以强制走 JS 后端做对照。

模板是注册进实例线性内存的，而每个场景的配色不同，所以 wasm 模块只编译一次、
每个流式场景实例化一份。

实测在当前密度（约 4700 顶点／chunk）下，两条路径的差距并不大：

| 路径 | 单个 chunk |
| --- | --- |
| WASM 生成 + 合批（不含拷贝） | 45 µs |
| WASM 全流程（含切片拷贝） | 74 µs |
| JS 全流程 | 82 µs |

V8 对这种紧凑的 TypedArray 循环优化得很好，所以端到端只快约 10%。WASM 的价值
更多在于把逐顶点的工作彻底移出 JS 堆——没有 JIT 预热和 GC 抖动，帧时间更平——
以及为之后调大视距、加大物件密度、引入地形高度留出余量。剩下 39% 的开销是两条
路径都要付的切片拷贝，真要继续压缩，下一步是把位置、法线、颜色交错进同一份
`InterleavedBuffer`，把三次拷贝并成一次。

## CommonUI 事件栈

`CommonUIManager` 按压栈顺序管理页面。默认情况下，栈顶页面独占输入，下面的 CommonUI 和游戏交互层会被阻断。

页面可以启用未处理事件向下传递：

```ts
const page: CommonUIPage = {
  id: 'floating-panel',
  element,
  passUnhandledEvents: true,
  handleInputEvent(event) {
    return event.type === 'contextmenu';
  },
};
```

事件从栈顶依次调用 `handleInputEvent`。当前页面返回 `false` 且 `passUnhandledEvents` 为 `true` 时，事件继续传给下一层；全部 CommonUI 都未处理时，最后交给 `GameInteractionLayer`。按钮、输入框等真实 DOM 控件会直接视为所属页面已经接收。

切换 Scene 时，`Scene.leave()` 会停用并清空该 Scene 的全部 CommonUI。

## 数据化场景

大厅阶段只创建一个带纸张色背景的空 Three.js Scene，不加载地面、树木、草丛、玩家
或远端玩家模型。创建或加入房间并收到服务器的 `room:joined` 后，客户端才按照响应中
的场景 JSON 构建地图；断开房间后会释放地图资源并恢复空场景。

可选择地图位于 `config/scenes/*.scene.json`，每个文件定义一张独立地图。当前示例：

- `grassland.scene.json`：完整线稿草地、树林和草丛
- `open-meadow.scene.json`：移除树林的暖色开阔原野

`config/scenes/scene.schema.json` 描述可编辑字段。场景配置包括：

- 地图 id、显示名称、描述和人数上限
- 渲染器类型、背景、雾效、内容开关和颜色表
- 服务端权威活动边界与出生点规则
- 默认观察相机参数

新增地图时复制一个 `.scene.json` 并使用新的唯一 `id`；Node.js 组合服务器启动时会
扫描并严格校验全部配置。配置无效或 id 重复会阻止服务器启动，避免客户端与 DS 使用
不同的地图数据。修改配置后需要重启 Node.js 服务器。

创建房间与加载顺序：

```text
大厅空场景
   │ GET /api/scenes
   ↓
选择地图并 POST /api/rooms { name, sceneId }
   ↓
RoomProcessManager fork 新 room-worker
   │ IPC: room:initialize + 服务器校验后的 Scene JSON
   ↓
DS 初始化 ServerScene、边界、出生规则并回复 room:ready
   ↓
客户端连接 /ws 并加入房间
   │ room:joined { room, player, scene }
   ↓
客户端根据服务器返回的 scene JSON 构建地图并生成玩家
```

客户端不会使用本地选择结果直接加载地图；最终始终以服务器在 `room:joined` 中返回的
场景定义为准。

## 玩家控制

- 玩家实体不存在：使用原有 `FlyController` 自由飞行镜头。
- 玩家加入房间并生成实体：`SceneControlRouter` 自动切换到 `TopDownController`。
- W / A / S / D：按俯视镜头的屏幕方向移动。
- Shift：加速移动。
- 鼠标：通过透视射线投影到玩法 XY 平面，并让史莱姆面向投影点。玩法坐标的 Y 在 Three.js 世界中映射为地面的 Z 轴。
- 左上角 `•••`：打开游戏菜单；“退出房间”会发送离开消息、清理当前地图与玩家，并返回大厅空场景。WebSocket 保持可复用，之后可以直接加入其他房间。

史莱姆参考 `.cursor/demo/line-art-style-magic-cabin-main/index.html`，使用三层透明材质、内部核心、气泡、阴影、顶点波动和移动压缩回弹。`.cursor/demo/` 用于集中存放只读参考案例；该参考路径也记录在 `.cursor/rules/line-art-reference.mdc` 中，作为项目始终生效的规范。

## 房间进程

生产环境只有一个对外端口。客户端页面、HTTP API 和 WebSocket 都进入同一个 Node.js
HTTP Server；WebSocket 网关再把玩家输入路由到对应的房间 DS：

```text
浏览器 / PC WebView
        │
        ├── GET /、/assets/* ─────────→ StaticWebServer → dist/
        ├── HTTP /api/* ──────────────→ ApiRouter → RoomProcessManager
        └── WebSocket /ws ────────────→ WebSocketGateway
                                                │ IPC
                         ┌──────────────────────┼──────────────────────┐
                         ↓                      ↓                      ↓
                    room-worker A         room-worker B         room-worker C
                    ServerScene           ServerScene           ServerScene
```

大厅进程只管理静态资源、连接与路由，不直接执行房间模拟。`RoomProcessManager` 每创建
一个房间都会使用 `child_process.fork()` 启动独立的 `room-worker.mjs`。

每个房间进程拥有自己的 `ServerScene`、玩家集合、输入队列和 20 Hz 更新循环。房间异常退出不会拖垮其他房间。

创建房间时会分配一个 32 位世界种子，随房间摘要一起下发。流式场景的客户端据此
生成与服务端一致的地形与物件，换房间就是换一个世界。

房间创建后如果没有玩家，或最后一名玩家离开后，会启动 60 秒空置回收计时；期间有玩家加入会立即取消计时。大厅接口通过 `idleExpiresAt` 返回服务端截止时间，房间卡片据此显示倒计时，归零后自动刷新列表。计时到期仍为空房间时，主进程会关闭并移除对应 DS 子进程。

收到 `SIGINT` 或 `SIGTERM` 时，组合服务器会关闭 WebSocket 网关、通知所有房间 DS
退出，并在 HTTP Server 停止监听后结束主进程。

## 移动同步

服务端权威：客户端上报的是**意图**而不是坐标，位置一律由房间进程计算。

```
浏览器                                    房间进程
  每帧本地预测（立即响应输入）
  每 50 ms 上报 { sequence, deltaSeconds,
                 move, sprint, yaw }  ──→  校验 → 推进权威位置
  记录该序号对应的预测位置
                                     ←──  每 100 ms 广播全房间快照
  自己那条：与预测对账后平滑纠正
  其他人：回退 120 ms 做插值渲染
```

`shared/playerMovement.mjs` 是两端共用的移动实现，`TopDownController` 的本地预测与
`ServerScene` 的权威计算调用同一个 `applyPlayerMovement`，相同输入必然得到相同位置，
客户端预测才有对账的基础。`shared/networkTuning.mjs` 统一了频率、插值延迟与各项阈值。

### 服务端的校验

上报坐标只能做「合理性钳制」，上报输入才谈得上防作弊。当前的校验有：

| 手段 | 位置 | 作用 |
| --- | --- | --- |
| 方向向量归一化到 ≤ 1 | `sanitizeMoveInput` | 放大向量换不来速度 |
| 速度与倍率写死在服务端 | `applyPlayerMovement` | 上限恒为 3.2 × 1.65 m/s |
| 活动范围钳制 | `clampToPlayArea` | 走不出大世界的活动区 |
| 单条输入时长上限 | `ServerScene.applyInput` | 一条消息最多推进 0.1 s |
| 服务器时钟维护的时间预算 | `ServerScene.update` | 谎报时长只会提前花光预算 |
| 序号严格递增 | `ServerScene.applyInput` | 重放与乱序输入被丢弃 |
| 输入消息令牌桶 | `WebSocketGateway` | 单个连接刷不爆房间进程 |
| 非法数值过滤 | `toFiniteNumber` | NaN / Infinity 不会污染权威状态 |

客户端时间不可信是这里最容易踩的坑：`deltaSeconds` 由客户端提供，但服务端按自己的
时钟给每名玩家补充时间预算，谎报时长最多只能提前用完预算，换不到额外位移。

### 客户端的两条路径

- **自己**：本地预测保证输入零延迟。快照回来后按服务器确认到的序号取出当时的预测位置，
  误差小于容差就忽略，正常范围内指数收敛地拉回，超过 2.5 m 直接瞬移。
- **其他人**：快照只有 10 Hz，直接赋值会卡顿。`SnapshotBuffer` 把渲染时间统一回退
  120 ms，每帧都落在两份已收到的快照之间做插值；朝向沿最短弧插值，缓冲被抽干时
  停在最后一份状态而不做外推。

出生点由房间进程按座位号分配，同房间的玩家不会叠在一起。每名玩家看自己都是薄荷绿，
其他人的颜色由玩家 id 稳定派生，所有人看到的同一名玩家颜色一致。

## 模块结构

- `src/scenes/`：Scene 基类、SceneManager 与草地场景
- `src/world/`：chunk 流式加载、ChunkView 与生成后端的加载
- `src/ui/common/`：CommonUI 栈和通用窗体
- `src/ui/pages/`：房间大厅、创建房间页面
- `src/interaction/`：最底层游戏交互事件路由
- `src/controllers/`：TopDown 控制器与 Fly/TopDown 控制路由
- `src/player/`：玩家实体和史莱姆动画
- `src/network/`：浏览器房间客户端、消息协议与快照插值
- `src/scenes/data/`：客户端场景 JSON 类型
- `src/models/`：程序化地面、树木、草丛、岩石与 chunk 模板/合批
- `src/materials/`：填充 Shader 与轮廓线材质
- `server/network/`：WebSocket 网关
- `server/http/`：API 路由、HTTP 响应和生产静态站点服务
- `server/rooms/`：房间进程管理器与 worker
- `server/scene/`：服务端权威场景状态
- `server/scenes/`：JSON 场景目录加载、校验与查询
- `config/scenes/`：每张地图的独立 JSON 与 Schema
- `shared/`：前后端共用的移动模拟与同步常量
- `shared/world/`：世界配置、chunk 坐标、确定性生成与两种生成后端
- `native/chunkgen/`：编译为 WebAssembly 的 Rust 生成与合批实现
- `tests/`：不依赖浏览器的客户端逻辑测试
