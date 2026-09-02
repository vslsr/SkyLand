# SkyLand

基于 Vite、TypeScript、Three.js、Node.js 与 WebSocket 的低多边形联机场景原型。

当前包含：

- Three.js 淡色填充与 `EdgesGeometry` 线稿场景
- 512 × 512 米的大世界：2 米网格台地、四向直坡、两类四向角坡、凹地水域与物件按 chunk 流式加载
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
- 均匀网格空间划分：树、石头与 Actor 共用一张网格，碰撞查询成本与世界面积无关
- 服务端权威温度与燃烧：篝火局部加热、可燃 Actor 点燃、燃料消耗和参考线稿火焰表现
- 高数量 Actor 驻留预算：物品堆自动合并、休眠、chunk dormant、逐玩家 AOI 与客户端批次绘制
- 会被世界挡住的第三人称相机悬臂，镜头不再穿进树冠和船体

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
DOM 的纯逻辑（标签、输入配置、和解、快照插值等），因此不参与 `tsc` 构建。

### VS Code 启动与调试

打开方式有两种，行为完全一致：**「打开工作区」选 `SkyLand.code-workspace`**，或直接
「打开文件夹」选仓库根目录。设置、启动配置、任务与扩展推荐全部放在 `.vscode/` 下，
`SkyLand.code-workspace` 只做入口，不重复定义任何一项。

#### 开发模式（日常）

1. 在“运行和调试”中选择 `SkyLand: 全栈调试`，按 `F5`。
2. VS Code 会启动 Node.js 服务端（3090）、Vite 开发服务器（5180）和独立 Chrome 调试窗口。
   页面走 5180，`/api` 与 `/ws` 由 Vite 代理到 3090。
3. 客户端 TypeScript 可直接在 `src/` 中下断点；服务端可在 `server/` 中下断点。
   创建房间后产生的 `room-worker.mjs` 子进程也会自动附加，可直接调试房间 DS。
4. 停止复合调试会同时结束服务端与浏览器；Vite 后台任务由 VS Code 管理，可通过
   “终止任务”停止。

只需要运行、不需要断点时，执行任务 `SkyLand: 启动开发环境（不调试）`。

#### 生产模式（验收线上形态）

选择 `SkyLand: 生产模式全栈`。它先跑一次 `npm run build`，然后由**同一个 Node 进程**
在 3090 上提供 `dist`、`/api` 与 `/ws`——Vite 不参与，与 `Dockerfile` 的运行形态一致。
客户端断点靠 `vite build` 的 sourcemap 落回源码。

#### 其余任务

`Ctrl+Shift+B` 执行生产构建。测试分成 `SkyLand: 全部测试` / `服务端测试` / `客户端测试`
三个任务（全套要跑几分钟，改一侧时只跑那一半）。调试单个测试文件用
`SkyLand: 当前客户端测试文件`（`.ts`）或 `SkyLand: 当前服务端测试文件`（`.mjs`）。

Rust/WASM 不是日常启动的前置条件——`chunkgen.wasm` 是签入仓库的。只有修改
`native/chunkgen/` 后才需要安装 Rust、添加 `wasm32-unknown-unknown` target，
并执行 `SkyLand: 重建 Rust/WASM`。`.vscode/settings.json` 已经把这个嵌套 Cargo 工程
挂给 rust-analyzer 并指向同一个 wasm target，否则它会按宿主平台分析并报出一堆
与实际构建无关的错误。

> 跨源隔离：dev、preview 与生产服务端都会发 `COOP: same-origin` + `COEP: require-corp`，
> 所以页面里 `crossOriginIsolated === true`、`SharedArrayBuffer` 可用。引入任何跨源
> 子资源（CDN 字体、图片）时对方必须带 `Cross-Origin-Resource-Policy`，否则会静默加载失败。

## 配置驱动输入与运行时重绑定

玩家输入方案位于 `config/input/player.input.json`，并由
`config/input/input-profile.schema.json` 描述格式。Action、标签关系、Mapping Context、
设备控制名称和 HUD 操作提示都来自同一份配置：

- `inputActions`：`digital` / `axis2D`、Pressed / Hold / DoubleTap 和 Modifier。
- `inputConfig.bindings`：把 `Input.Player.Move` 这类层级标签关联到 Action。
- `inputMappingContexts`：Context 优先级及键鼠、触摸、Gamepad Mapping。
- `devicePrompts`：控制路径显示名，以及按模式、设备和状态生成的 HUD 提示。
- `virtualControls`：固定/浮动摇杆、半径、死区、灵敏度、按钮网格和横竖屏布局。

每条 Mapping 必须提供全局稳定的 `id` 和 `deviceKind`。运行时按 Mapping id 重绑定，
因此方向、Action 和 Modifier 不会随按键变化。默认冲突策略会交换同一 Context 中的
两个控制，也可使用 `reject` 拒绝冲突或 `allow` 保留重复绑定：

```ts
const bindings = scene.inputBindings;
bindings.rebind('Move.Keyboard.Up', 'Keyboard.KeyI');
bindings.rebind('Dodge.Keyboard.Primary', 'Keyboard.KeyQ', { conflict: 'reject' });
bindings.resetBinding('Move.Keyboard.Up');
bindings.resetAllBindings();
```

变化会立即替换 `InputSubsystem` 的 Context、刷新浏览器默认行为拦截列表和 HUD 提示。
浏览器默认把非默认绑定以差异形式保存到 `localStorage`；配置升级或本地数据损坏时，
无法识别的单条覆盖会被忽略，不影响默认输入方案加载。

虚拟摇杆默认使用浮动模式：在屏幕左侧触控区域按下时生成基座，拖动输出
`Virtual.MoveStick`，释放或触摸中断后归零。布局会叠加浏览器安全区，并为横屏、
竖屏分别应用缩放与边距。桌面调试时在地址后添加 `?virtual-controls=1`；进入
`topdown` 场景后即可用鼠标检查摇杆和按钮，正式桌面布局仍保持隐藏。

## 大世界与 Chunk 系统

场景配置里出现 `renderer.world` 就表示这张地图是流式大世界：地面与物件不再是
摆好的固定内容，而是由世界种子确定性生成、按 chunk 加载。`open-world` 与 `orchard`
是内置的两张流式地图，`grassland` 与 `open-meadow` 保持原来的固定场景。

世界是 16 × 16 个 chunk，每个 chunk 32 米见方，合计 512 × 512 米。世界尺寸是
生成算法的固有属性，写在 `shared/world/worldConfig.mjs` 里，对所有流式场景都一样；
场景配置只决定加载半径、保留半径和岩石配色。

玩家的活动范围比生成范围向内收两个 chunk（384 × 384 米），因此永远走不到没有
内容的世界边缘旁边。`SceneCatalog` 在启动时校验这两条约束：

- `gameplay.bounds` 必须落在这个安全区内；
- `renderer.fog.far` 必须不大于 `loadRadius × 32`，否则视野会越过最近的未加载
  chunk，玩家会直接看到地块凭空出现。

配错了服务器起不来，并会指出是哪一个场景文件的哪一项。

### 网格地形与水域

`shared/world/terrainContent.mjs` 把地形定义成 `(worldSeed, globalCellX, globalCellZ)`
的纯函数。每格 2 × 2 米，每个 chunk 固定 16 × 16 格；格记录由高度层、表面类型和
形状组成。当前表面支持普通地面与水域；形状支持平面、朝世界 ±X/±Z 的四向直坡，
以及单高角、单低角各自的东北/东南/西南/西北四向转角。一层高 1 米，因此斜坡坡度
约 26.6°。负高度层是水底，海平面保持在 0。

客户端 `TerrainChunkView` 只为已加载 chunk 建立台地顶面、断崖侧壁、网格线和水格
水面。水面继续复用海域场景的波浪 Shader，只把覆盖范围从整张大平面改成凹地中的
局部格子。服务端与客户端移动都调用 `resolveTerrainMovement`：沿本次短位移做固定上限
的脚印采样，允许沿斜坡连续升降、从断崖向下落地并穿过水块；向上跨层仍按角色的
`maximumStepHeight` 判断。没有浮力时角色沿河床移动；史莱姆原型携带通用
`BuoyancyComponent`，深水中由海平面减去吃水提供支撑，浅滩与凸起河床仍会阻挡。
玩家的基础速度写入 GAS `Movement.Speed` 属性；进入水域时服务端与本地预测都会施加
`Effect.Movement.WaterSlow`，把 CurrentValue 乘以 0.5，离水后移除并恢复 BaseValue。
地形不注册成每格碰撞盒，
所以内存与查询成本不随地图面积增长。

地形数据不随快照下发；浏览器、服务端和 Rust/WASM 都由同一种子推导。静态物件只在
平坦普通地面生成，记录末尾追加 `y_mm`，既有字段下标保持不变。出生点附近固定留出
一块平坦陆地，保证多人出生不会落进水里或悬崖边。

`terrain.rs` 与 `terrainContent.mjs` 的逐位一致由
`server/tests/terrainParity.test.mjs` 逐格保证——**不能只靠放置记录的比对**：物件只
落在平地上，那条路径永远采样不到斜坡、角点和水面。详见
`.cursor/skills/skyland-chunk-world/references/chunk-world.md`。

### 稀疏地形编辑

玩家改过的格子进 `TerrainPatchStore`：按 chunk 分桶，只保存与默认生成结果不同的
那些，写回默认值会把记录删掉。内存因此跟着「被真正编辑过的格数」走，而不是世界
面积。共享层的每个采样入口（`sampleTerrain`、`resolveTerrainMovement`）都接受一个
`cellCodeAt` 覆盖，所以接上编辑层只是把同一个函数传下去。

**服务端是唯一权威。** `ServerScene` 持有 patch store，移动、出生点和掉落落地全部
读它。客户端**不做本地预测**：`terrain:edit` 发出去，服务端校验通过后广播
`terrain:patch` 回来，那时才写进本地覆盖层。地形直接决定人站在哪里，抢跑一帧再被
拉回去比晚一个 RTT 难受得多。

服务端的校验：序号必须递增（挡重放）、距离按**权威玩家坐标**和格心算（够不到就
不生效）、目标格必须落在活动区内。编辑和其它输入共用同一个令牌桶，连点不会绕过
限流。新成员加入房间时，房间进程把已有 patch 单独发给他，否则他脚下的世界和服务端
不是同一个。

界面是屏幕左侧的一条竖栏（`src/ui/TerrainEditorPanel.ts`），小标签点一下展开。
**收起等于关闭编辑功能**，不只是把按钮藏起来：当前工具会被清空，
`TerrainEditController` 收到 undefined 之后既不高亮也不响应点击。圆形按钮上下排列，
选中的那个变成深底浅字，准星指向的地形格实时高亮，点击提交一次修改。图标走
`src/ui/icons/IconSprite.ts` 的 SVG sprite：路径数据按 ID 定义一份，用的地方
`<use href="#icon-...">` 引用。

**已知限制**：树和石头的静态碰撞盒来自放置记录里的 `y_mm`，那是**基础地形**的高度，
不跟着 patch 走。所以在物件脚下改地形，物件会浮起或陷进去。

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

### 每个 chunk 的绘制预算

一个 chunk 的树与岩石仍合批成**一份**填充几何体和**一份**轮廓线几何体，颜色随
顶点走（`createFillMaterial` 的 `vertexTint`）。地形增加普通地面填充/网格两个 pass；
含水格时再增加水面/水线两个 pass。实例草由 `StreamingGrassSystem` 另占两个 pass。
因此单块按内容为 4–8 次 draw call，且只存在于加载半径内，数量上界仍由常驻 chunk
数决定。

`renderer.content` 的 `ground` / `trees` / `grass` 开关在流式场景里改为决定 chunk
里放什么：关掉某一类就注册一个空模板。放置结果本身不受影响——放置算法在 WASM 与
JS 两个后端之间必须逐位一致，所以它不接受任何逐场景的开关。

草有两条路：固定场景用 `GrassFieldSystem`，按整块活动区一次性铺满；流式场景用
`StreamingGrassSystem`，只为当前加载的 chunk 创建草叶。流式系统直接读取生成器原有的
草簇坐标、朝向和缩放，每簇仍保持三片叶子，因此替换不会改变位置或密度；所有已加载
chunk 共用一张跟随玩家焦点、按固定步长滑动的 32 米局部弯曲纹理。玩家踩踏始终可写入
当前场景的草地交互目标，鼠标输入则由场景级 `mouse-grass-interaction` Component 独立提供；
`open-world.scene.json` 不注册鼠标压草。窗口移动时会按世界坐标
重投影仍在重叠区内的草痕，快速传送到不重叠区域则
自动回到中性状态；纹理成本因此不随世界尺寸增长。两条路的叶片形状都取自
`createGrassBladeGeometry`，观感保持一致。

大世界的 `interactive-particle-effect` 通过 `worldGeneration.spawnChance` 为每个 chunk
确定性生成至多一个落叶团候选点；房间世界种子、组件 `seed` 与 chunk 坐标共同决定位置。
`clusterRadius` 配置的是每个点周围的圆形落叶团半径，不会缩放单片落叶。组件复用世界的
`loadRadius` / `keepRadius` 流送 Actor，并限制每帧创建一个 chunk，资源上界不随世界面积增长。

顶点已经是世界坐标，承载它们的对象留在原点，Three.js 自动算出的包围球就落在
正确位置上，视锥剔除按 chunk 生效。

### WASM 生成后端

`native/chunkgen` 是一个 `no_std` 的 Rust crate，编译到 `wasm32-unknown-unknown`，
产物约 5.9 KB。它做两件事：放置算法，以及把模板几何体按每个物件的位置、高度、
朝向、缩放变换后写进一整块连续的顶点缓冲。模板几何体仍由 Three.js 在 JS 侧生成后
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
以及为之后调大视距、加大物件密度留出余量。剩下 39% 的开销是两条
路径都要付的切片拷贝，真要继续压缩，下一步是把位置、法线、颜色交错进同一份
`InterleavedBuffer`，把三次拷贝并成一次。

## 碰撞与空间划分

树、石头、船和玩家都在同一张均匀网格上做碰撞查询。这一节讲的是「查询成本
为什么不随世界变大而变大」，以及第三人称镜头怎么不穿模。

### 为什么需要空间划分

碰撞检测的成本来自「拿一个查询去比对所有碰撞体」。加载半径内 25 个 chunk
一共能派生出上千个静态碰撞体，逐个比对的话，玩家每走一步都要跑一遍整份列表，
而真正相关的只有身边那几个。

`shared/collision/CollisionGrid.mjs` 把 XZ 平面切成边长 8 米的格子，碰撞体
登记进它 AABB 覆盖到的格子，查询只访问与查询区域相交的格子。成本从
「碰撞体总数」变成「查询点附近的密度」。

选均匀网格而不是四叉树／BVH 的理由：这个世界的碰撞体尺寸相近、分布均匀，
均匀网格的最坏情况和平均情况几乎一样；插入与删除是 O(1)，每帧刷新的动态
Actor 不需要重建任何树。格子按需创建、空了立刻回收，所以内存跟着「已加载的
碰撞体」走，不跟世界面积走——这是它能用在大世界里的前提。

两个细节保证了上界：单个碰撞体最多登记进 16 个格子，更大的进 oversized 列表
每次都看；查询去重靠每条记录上的 stamp，不分配 Set 也不产生临时数组。

### 一个场景一张碰撞世界

`shared/collision/CollisionWorld.mjs` 按生命周期把碰撞体分成两类：

| 类别 | 谁放进去 | 什么时候撤走 |
| --- | --- | --- |
| 静态分组 | 一个 chunk 的树和石头，key 就是 chunk key | chunk 卸载时整组撤走 |
| 动态条目 | Actor，按 id 原地更新 | Actor 消失时按 id 撤走 |

窄相统一由 `resolveCircleAgainstSimpleCollisions` 处理——网格只负责给出候选，并把
同一份玩家垂直轮廓传进去。低矮 Actor 的顶部不超过玩家原型配置的
`maximumStepHeight` 时不做 XZ 推出；更高且与玩家身体垂直重叠的盒子仍会阻挡。
`server/tests/collisionWorld.test.mjs` 会逐个比对网格结果与全量遍历结果。

### 静态碰撞不走网络

`shared/world/chunkColliders.mjs` 把已有的整数放置记录翻译成碰撞盒。它没有引入
任何新的随机性，所以浏览器与房间 DS 从同一个 `(worldSeed, chunkX, chunkZ)`
得到同一批盒子，静态碰撞和静态几何体一样，一个字节都不用同步。客户端预测因此
不会出现「本地被树挡住、服务端不知道有树」的反复拉扯。

碰撞形状取自 `src/models/` 的线稿模型：

| 物件 | 挡走路 | 挡镜头 |
| --- | --- | --- |
| 树干 | 半径 0.22 m、高 1.3 m | 同左 |
| 树冠 | 不挡 | 两段盒子，最宽 1.2 m，到 4 m 高 |
| 岩石 | 0.48 × 0.40 m、高 0.46 m | 同左 |
| 草 | 不挡 | 不挡 |
| 蘑菇 | Actor 动态碰撞 | Actor 动态碰撞 |

树冠不参与推出的理由和弹性蘑菇一样：放置格只有 4 米，如果两米多宽的树冠也挡路，
林子里会寸步难行。但镜头必须被树冠挡住，否则第三人称相机会从枝叶中间穿过去。
一个盒子带一个层掩码（`COLLISION_LAYER.MOVEMENT` / `CAMERA`），两种用途共用
同一张网格。

### 服务端的 chunk 常驻策略

房间 DS 上有两样东西要跟着玩家在大世界里滑动，它们装载的内容不同，但「什么时候
装、什么时候卸」完全一样，所以那一份策略只有一个实现：
`server/scene/ChunkResidency.mjs`。它维护常驻集合，装什么由 `onLoad` / `onUnload`
决定。两条纪律和客户端 `ChunkStreamer` 一致：常驻集合的上界是
玩家数 × (2 × keepRadius + 1)²，与世界面积无关；`keepRadius` 严格大于
`residentRadius`，站在边界上来回走不会反复建了拆，而且没有人跨过边界的 tick
直接返回，不做任何集合运算。

| 使用者 | 装载内容 | residentRadius / keepRadius |
| --- | --- | --- |
| `server/scene/ServerChunkColliders.mjs` | chunk 静态碰撞体 | 1 / 2 |
| `server/actors/ServerGeneratedPropActors.mjs` | 可交互的世界生成物件 Actor | 2 / 3 |

房间 DS 不建几何体，但必须知道树在哪，否则玩家会被客户端预测挡住、又被服务端
和解拉回去。碰撞体只服务玩家自己的推出解算，所以一圈就够。

生成物件的半径更大，而且**不能小于原型的 `replicationPolicy.radiusChunks`**：AOI
之内的物件必须有 Actor，否则被采掉的那个没有快照条目，客户端会把它画回来。这个
下界在构造时从所有已登记原型里取最大值，两个半径不会各写一份之后悄悄失配。

整个世界有约 2000 棵树和 900 块石头。全部常驻的话，每一个按 Component 查询的
System 都要为它们付钱——`TemperatureSystem` 的热源收集是 `query(transform)`，会
10 Hz 扫全世界。改成跟着玩家滑动之后，一名玩家在场时 ActorWorld 里带 Transform
的 Actor 从 1913 个降到 162 个，而且不再随世界变大而增长。

玩法状态用**偏离态**保存：卸载时只记下被采过或已采完的物件（血量、是否移除、
revision），装载时按同一个 id 恢复并立刻挂上 `ReplicatedComponent`。完好的物件
什么都不记，所以状态量跟着「玩家改动过多少个」走，而不是跟着「世界里有多少个」走。
被移除这一位同时写进 `ServerChunkColliders` 的 skip 掩码，静态碰撞和几何体因此
一起消失。

### 世界生成物件的原型注册表

一个物件是布景还是可交互 Actor，取决于场景有没有给它配置原型变体。变体写在
`gameplay.worldProps` 里；没有配置的种类（当前是草）只有网格，不产生 Actor。

```json
"gameplay": {
  "worldProps": {
    "tree": [
      { "archetype": "generated-tree", "weight": 5 },
      { "archetype": "fruit-tree", "weight": 1 }
    ],
    "rock": [{ "archetype": "large-rock", "weight": 1 }],
    "mushroom": [{ "archetype": "elastic-mushroom", "weight": 1 }]
  }
}
```

**变体归场景，定义归原型。** 原型只描述「它是什么」——多少血、掉什么、交互距离
多远；一张地图里有哪些变体、各占多少是地图的事。`weight` 是 1–1000 的相对权重，
上例普通树与果树约为 5:1。每条放置记录用
`(worldSeed, kind, chunkX, chunkZ, propIndex)` 的共享整数哈希选中一项，所以服务端与
客户端结果一致。可采集生成物只同步偏离态；蘑菇这类会移动、会改变交互关系的对象
则由服务端发送完整 Actor 快照。单纯增加同 kind 变体不改变位置、缩放或 chunk 顶点，
因此不需要修改 Rust 放置实现和 WASM ABI。`worldProps` 只能出现在带
`renderer.world` 的流式场景上；每个 kind 最多配置 16 个不重复原型。

绑定的原型连同它掉落的堆叠原型会被自动带进场景的原型表，作者不用再在
`runtimeActorArchetypes` 里重复列一遍——那份重复正是「绑了但忘了带进来」这类
错误的来源。

Actor id 是自描述的：`prop:<种类>:<chunkX>:<chunkZ>:<放置下标>`。种类是冗余的
——后三项已经唯一确定一格——带上它之后，「只拿到 id」的一侧可以结合房间种子重新
运行一次很小的变体哈希，直接得到原型，不必重建整个 chunk。可采集物的快照仍只发
`{ id, revision, propState }`，没有 `archetypeId`；可拖拽 Actor 则发送完整状态。
这不会让客户端说了算：权威 Actor 只能由服务端从同一世界种子推导。

掉什么、掉多少写在原型的 `generatedProp.drop` 里，不写在代码分支里；数量按生成
时的缩放取整，所以大树掉的木材比小树多，两端算出的结果一致。

`SceneCatalog` 在启动时校验这几条：

| 约束 | 违反后的现象 |
| --- | --- |
| `worldProps` 只出现在流式场景上 | 固定摆放的场景里没有 chunk 物件可绑 |
| 绑定的种类名必须已知 | 打错一个字，那一种物件静默地不生成 |
| 每个 kind 的变体数组必须有 1–16 项，权重为 1–1000 | 无法稳定划分哈希区间 |
| 同一个 kind 不能重复配置同一原型 | 同一配置被拆成多段，比例难以审查 |
| 变体原型必须是 `generatedProp` 采集物或 `elasticTether` 弹性 Actor | 生成记录没有可运行的玩法载体 |
| 绑了 `tree` 就必须开 `renderer.content.trees` | 一片撞得到、采得到、但看不见的树 |
| 掉落必须指向存在且可堆叠的原型 | 要等玩家采到那一下才炸在交互路径上 |

### 两种采集形态

原型的 `generatedProp` 里有没有 `regrow` 决定这个物件怎么被采：

| | 没有 `regrow` | 有 `regrow` |
| --- | --- | --- |
| 状态 | `maximumHealth` / `harvestDamage` | 没有血量 |
| 采集 | 掉血，掉到 0 才掉东西 | 每采一次都掉东西 |
| 采完 | 永久消失，几何体与静态碰撞一起撤走 | 原地不动，进入冷却 |
| 恢复 | 不会 | 冷却结束自己恢复 |

两者互斥，`ActorCatalog` 在加载时就拒绝同时写两套——否则「这一下到底扣血还是
进冷却」得读代码才知道。

冷却用的是**绝对服务端时间** `readyAt`，和 `LifetimeComponent` 一个范式：chunk
卸载期间时间照样流逝，装回来时比一次就知道长回来没有，长回来的直接丢掉偏离态
记录，回到「没被动过」。**没有定时器，没有逐 tick 扫描。**

`readyAt` 原样复制给客户端，两端各自判断熟没熟，所以「长回来」这一刻**不需要
再发一条快照**。客户端拿的是快照缓冲换算过的服务端时钟，不是本地 `Date.now()`
——两端时钟差几分钟是常事，用本地时间会把整个冷却算偏。

果子不进 chunk 合批：合批器只能按放置记录里的 kind 选模板，没有逐实例的状态
通道，要让「同一棵树有果子/没果子」两种外观就得改 WASM 的 ABI。
`GeneratedPropFruitSystem` 拿已有的派生 Actor 单独铺一层实例化网格，代价是每帧
多两次绘制，换来的是放置算法与 WASM 一行不动。

### 两张地图绑同一套世界生成

`open-world` 与 `orchard` 用的是同一个世界种子、同一套 chunk 参数，区别在各自的
带权原型表：

| 场景 | `tree` | `rock` | `mushroom` |
| --- | --- | --- | --- |
| `open-world` 无边草原 | `generated-tree` 权重 5（生命 3 → 木材）+ `fruit-tree` 权重 1（冷却 120 秒 → 果实） | `large-rock`（生命 5 → 石料） | `elastic-mushroom`（按 E 拖拽） |
| `orchard` 果林 | `fruit-tree` 权重 1（全是果树） | `generated-rock`（生命 4 → 石料） | 未配置 |

两张地图上树与石头的位置、朝向、缩放完全一致；变体只决定每条记录承载哪一个玩法
原型。无边草原把 `elastic-mushroom` 绑定到生成器的 `mushroom` kind，蘑菇会以略低于
草的频率散布；靠近后按 E 叼住，移动即可拖拽，再拉出 `pullDistance` 那么远就整株拔断。

拖拽行程从**叼住那一刻**起算，而不是离锚点的绝对距离。绝对判定下你站多远按的 E
决定了还能拖多久——贴脸按能拖一米多，顶着交互距离按就只剩半米，玩起来像「一按就掉」。
按叼住点起算之后，不管从哪按，拖拽行程都是同一段（当前 2.8 米，步行约 0.9 秒）。

交互键在三种状态下含义不同，由服务端按状态分派：还长在地上时是「叼住」，拉着还没断时
是「松开」（弹回原位、恢复可交互），已经叼在嘴上时是「放下」。嘴里同时只允许有一株，
否则手上那株就失去了唯一的放下入口。拉着的那株可能已经被拖出就近搜索半径，叼着的那株
`interactable` 又是关的，两种都不会出现在就近候选里，所以客户端在手上有东西时把交互键
直接指向它，而不是靠就近拾取。

拔断之后蘑菇进嘴，跟着玩家的嘴部走，这一段既不是长在地上、也还不是自由刚体：不建刚体、
不受重力。叼着时它是横衔的，所以放下时不需要任何冲量，落地姿态由离手那一刻的朝向决定，
自然就是躺着。老家 chunk 卸载不会带走叼在嘴上的那株，玩家离开房间则让它原地落下。

地形碰撞网只有陆地顶面，水面格是空的；放进水里的物件穿过水面之后底下什么都没有，
会一直往下掉。掉落刚体因此按地形的实心高度（水下就是水底）加了一层地板。

躺下的姿态和位置一样属于「这个物件被动过」的偏离态：`ServerGeneratedPropActors`
的 `captureDeviation` 一并记下朝向，chunk 卸载后重建时把它交回刚体。只存位置的话，
走出 keep 半径再回来，躺在地上的蘑菇会在原地站起来。

草没有原型认领，仍然是纯布景。两种采集走的是同一条 `harvest-prop` 代码路径，
`ServerScene` 里没有任何一处提到树或石头。

掉落物的绘制同样按渲染模型分派：`HighCountActorBatchSystem` 认 `PILE_RENDER_MODELS`
里登记的堆叠模型，每种模型给出自己的模板分块（圆木是三根交错的圆柱，石堆是三块
压扁的低多边形石头），后面的合批、实例化与轮廓线合并两种共用。同一个批次仍然固定
两次绘制。

### 第三人称相机悬臂

镜头穿模的根源是：机位由「角色位置 + 固定偏移」直接算出，这条计算里没有世界的
存在，于是角色贴着树时机位就落在了几何体内部——近裁剪面把模型切开，或者干脆
看见背面。

`src/camera/CameraBoom.ts` 把机位当成一根从角色伸出去的杆子：每帧从角色胸口
沿杆子扫掠一个半径 0.32 m 的球（`CollisionWorld.sweepSphere`，只看 CAMERA 层），
撞上东西就返回撞击点之前的安全比例。TopDown 应用该比例时只收缩 XZ 距离，Scene
配置的高度保持不变；鼠标射线按最终渲染机位重建。`TopDownController` 默认关闭这项遮挡判定与
收缩功能；只有构造时显式传入 `cameraCollisionEnabled: true` 才会使用 `cameraProbe`。

收放是不对称的，这是刻意的：

- **收（撞上障碍）立即生效。** 晚一帧就是穿模一帧，这是这套东西存在的理由。
- **放（障碍让开）按固定速率平滑。** 瞬间弹回去会让画面猛地一跳，贴着树跑动时
  更会变成来回抽搐。

扫掠始终按**全长**做，而不是按当前收缩后的长度——只有这样，障碍让开之后悬臂
才知道自己可以再伸出去多远。窄相是「线段 vs 按探针半径外扩的有向盒」：外扩后的
盒子在角上是方的而不是圆的，贴着盒角掠过时会比真实的球早一点判定命中，这个
方向对镜头是安全的。

服务端和解触发瞬移时（跨了好几个 chunk），悬臂会 `reset()`，不把上一处的收缩量
带到新位置。

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

开发构建额外启用 `IMC.Development`。按 F8 会通过数据化 InputAction 打开 CommonUI
调试页；页面仍遵守栈顶输入、焦点、Escape/F8 关闭和 Scene 清理规则。调试页可以切换
Actor 简易碰撞边框、温度标签、房间权威天气，并显示房间时钟、请求跳到某个时段。
天气与时段按钮都只发送请求，房间 DS 按场景配置校验后随快照同步结果。产品构建会移除
该 Mapping，不占用 F8。

## 服务器权威的天气与昼夜

天气和昼夜都是房间级权威状态，客户端只渲染结果。DS 每 tick 推进
`server/scene/SceneEnvironmentDirector.mjs`，快照里只多三个数：离散天气枚举
`weather`、时刻 `timeOfDay`（小时，`[0, 24)`）和 `dayLength`（一整天的真实秒数，
0 表示时钟被冻结）。云量、雨雪、风、天空渐变、日月轨迹、星空亮度和环境光全部由
客户端按这三个数本地推导，网络上不传任何表现参数。

「怎么切」写在场景 JSON 的 `environment` 里：

```json
"environment": {
  "weather": {
    "initial": "sunny",
    "allowPlayerControl": true,
    "cycle": {
      "enabled": true,
      "minimumSeconds": 90,
      "maximumSeconds": 240,
      "candidates": ["sunny", "cloudy", "fog", "rain", "storm"]
    }
  },
  "dayNight": { "enabled": true, "startHour": 7.4, "dayLengthSeconds": 900 }
}
```

- `weather.cycle` 让 DS 在候选天气之间自动轮换，间隔按房间世界种子确定性抽样，
  每次都会换成与当前不同的一种；`allowPlayerControl` 关掉之后连调试菜单也改不动天气。
- `dayNight.enabled` 关闭的场景恒定停在 `startHour`（默认正午），
  `paused` 则是启用昼夜但冻结时间，用来做固定黄昏或夜景。
- 整块 `environment` 可以省略：默认是晴天加一个停在正午的冻结时钟，正午的天空正好
  等于 `renderer.background`，因此没有接入昼夜的场景和以前逐像素一致。

客户端把两套表现拆成两个视觉 System，并且**只有天气系统写场景环境**：
`src/environment/DayNightSystem.ts` 先按本地时钟算出天空底色、环境光、主光方向、
日月位置与星空亮度，`src/weather/WeatherSystem.ts` 再在同一帧把云量压灰、雾浓度和
雷闪叠上去，一次性写进 `scene.background`、`scene.fog` 与场景共享 uniform；两套系统
各写一遍就会在同一帧互相覆盖。日轮、月轮、星空与流星是无限远元素，每帧跟着相机平移；
雨雪仍按本地玩家周围的 3×3 chunk 激活，粒子保持世界坐标固定。和参考项目一致，普通
物体填充、纸面地表、地面网格与草叶不混入距离雾色；流式世界的合批物件仅在雾效最远端
12 米内渐隐，用来遮住 chunk 流送边缘而不牺牲近中景清晰度。

时刻在两帧快照之间由 `DayNightClock` 用与服务端相同的共享数学继续推进，收到快照时
小偏差平滑追赶、大偏差（重连、调试跳时段）直接跳过去，所以时间不会随快照频率跳动。

### 时刻驱动的光照

天色不只是换一个整体色调。`src/shaders/environmentLighting.ts` 是填充材质、海面、
草叶与交互粒子共用的一份 GLSL，同一段数学不会在四个 shader 里各抄一遍：

- **方向性散射雾**：雾色不再是单一天空色。朝着太阳看会被日光染暖，背对太阳仍是天空的
  冷色。没有这一项时，雾一旦铺满画面（大片海面、开阔平原）就会糊成一整块单色，日落
  也就只剩「整屏变橙」。日轮沉到地平线以下后散射归零，只剩天边的余晖。
- **半球染色**：朝天的面取当前天色，朝下的面取场景地面色，两者都归一化到平均亮度 1，
  所以只改色相不改曝光——黄昏时物体顶面偏暖、底面偏冷，正午则完全中性。
- **低日角直射**：太阳越贴地，直射项的对比越强，清晨与黄昏因此有明确的受光面和背光面，
  而不是只换一个色调。
- **云影**：两层滚动的值噪声按云量压暗环境光，随风漂移，地面、物件和草叶被同一片阴影
  扫过。只有白天的直射光投得出云影，夜里和暴雨的漫射光下自动消失。
- **接触阴影**：Actor 脚下的影子在顶点着色器里按太阳方位拉长、平移，浓度跟着直射光的
  「硬度」走：晴朗正午最清楚，阴天散射光下化开，夜里几乎消失。
- **墨色**：共享墨线材质每帧按环境光染色，夜里偏冷、黄昏偏暖，浓度不变——线宽在 WebGL
  里改不了，墨色是线稿唯一的调节量。

这些量全部由天气系统这一个写入方在合成环境时一次写入共享 uniform；正午的中性白光下
每一项都退化成恒等变换，所以关闭昼夜的场景与接入之前逐像素一致。

## 数据化场景

大厅阶段只创建一个带纸张色背景的空 Three.js Scene，不加载地面、树木、草丛、玩家
或远端玩家模型。创建或加入房间并收到服务器的 `room:joined` 后，客户端才按照响应中
的场景 JSON 构建地图；断开房间后会释放地图资源并恢复空场景。

可选择地图位于 `config/scenes/*.scene.json`，每个文件定义一张独立地图。当前示例：

- `grassland.scene.json`：完整线稿草地、树林和草丛
- `open-meadow.scene.json`：移除树林的暖色开阔原野
- `water.scene.json`：低多边形线稿海面，以及木筏、漂流货箱和礁石 Actor 的交互示例
- `thermal-lab.scene.json`：篝火逐步点燃邻近干草并继续传播热量的测试场景

`config/scenes/scene.schema.json` 描述可编辑字段。场景配置包括：

- 地图 id、显示名称、描述和人数上限
- 场景 Actor 的原型引用、初始位置和朝向
- `gameplay.playerActor.archetype` 选择按连接动态生成的玩家 Actor 原型
- `gameplay.runtimeActorArchetypes` 声明运行时允许生成、但不固定摆放的 Actor 原型
- 按顺序加载的场景级 Component（场景专属逻辑、流程与规则）
- `environment` 中房间权威的初始天气、天气轮换规则与昼夜推进速率
- 渲染器类型、背景、雾效、内容开关和颜色表
- 服务端权威活动边界与出生点规则
- 默认观察相机参数

新增地图时复制一个 `.scene.json` 并使用新的唯一 `id`；Node.js 组合服务器启动时会
扫描并严格校验全部配置。配置无效或 id 重复会阻止服务器启动，避免客户端与 DS 使用
不同的地图数据。修改配置后需要重启 Node.js 服务器。

可复用 Actor 原型位于 `config/actors/*.actor.json`。场景的 `actors` 只负责摆放固定对象；
玩家原型由 `gameplay.playerActor.archetype` 引用，并按连接动态加入 ActorWorld。
`ActorCatalog` 会解析玩家移动、浮力、船舶动力、交互、货物、危险物、温度、可燃性、热源和渲染 Component，DS 使用相同
的净化结果创建 ActorWorld。木筏的权威位置、控制者、航速、吃水、漂浮状态和静态倾斜，
以及货箱的承载关系和礁石危险范围都会进入 `actors` 快照。客户端收到快照后才创建对应
Replica。Actor 使用服务端校验的 `parentActorId + localTransform` 构成层级，DS 在父 Actor
移动后由 `AttachmentSystem` 按拓扑解算子 Actor 的最终世界坐标。客户端只对最终世界
Transform 回退 120 ms 插值；父子关系不插值，海浪造成的上下浮动仍只作用于视觉子节点，
不改写权威 Transform。

`guide-path.actor.json` 是无服务端 Mesh 的展示型 Actor：`GuidePathComponent` 权威保存
局部路径点、启用态和当前节点，并提供 `setPath()`、`setEnabled()`、
`setCurrentPointIndex()`、`advance()` 与 `reset()`。这些离散状态随 Actor 快照复制；客户端
`GuidePathVisualSystem` 才按 Wayfinder 参考创建流动白色虚线与 additive 发光 Billboard，
不叠加线稿描边或暗色底线。删除服务器 Actor 就会让所有
客户端移除对应 Replica，并释放该路径独占的几何、材质和贴图。
大世界中该原型使用 2 Chunk AOI 复制，AOI 外不会创建客户端 Replica；服务端命中检查
固定为 10 Hz。单条路径最多 32 个局部路点（坐标绝对值不超过 64 米）和 256 个渲染采样，
始终只创建一个当前节点 Sprite；所有 GuidePath 共同复用一张 64×64 光晕纹理。

每个受支持的 Actor 模型在创建时会从 `render` 的 authoring 尺寸自动生成一个简易有向盒，
无需再维护重复碰撞配置。玩家圆形碰撞、可控 Actor 推出和客户端预测共用
`shared/actor/simpleCollision.mjs`；房间 DS 仍是最终权威。宽相只查询玩家附近的网格格子，
成本随局部碰撞密度而不是世界面积增长。

### 高数量 Actor 与掉落物堆

Actor 身份、逐 tick 模拟、网络复制和 Object3D 已经互相独立。`wood-pile.actor.json`
是第一种使用这条路径的原型；砍树或战利品系统通过服务端入口生成物品堆：

```js
scene.spawnItemStack('wood-pile', {
  quantity: 6,
  position: [x, y, z],
  velocity: [vx, vy, vz],
});
```

它仍然是完整 Actor，有 Transform、物品数量、温度、燃料、碰撞与交互 Component，
但生命周期按成本分层：

```text
active（弹道/燃烧） → sleeping（不再移动） → dormant chunk record（离开 ActorWorld）
        ↑                                      │
        └──────── 玩家进入保留圈后恢复同一 id ──┘
```

- 同类 sleeping 堆先按邻近距离合并；单 chunk 每个兼容组超过 16 堆时触发过载聚合。
- active 软预算默认 256；Actor 与 dormant record 的转换每 tick 最多 32 个，避免尖峰。
- `ReplicationPolicyComponent` 把物品堆限制在玩家周围 2 个 chunk 的快照，额外 1 圈作为
  驻留迟滞。房间进程为每名玩家分别生成快照，网关只投递给对应连接。
- sleeping 且离开所有玩家保留圈的 Actor 会序列化成按 chunk 保存的记录；记录不运行
  System、不占碰撞条目、也不进入快照。寿命通过绝对服务端时间和到期最小堆继续结算。
- 燃烧堆保持 active；合并时数量、温度、剩余燃料与寿命一起守恒，不会只合并模型。
- 客户端 Replica 不创建独立 ThreeObject。相同原型、驻留状态与燃烧状态组成一个批次，
  每批固定一份 InstancedMesh 填充和一份合并 EdgesGeometry 轮廓；射线选择改用权威
  Transform 与碰撞半径的解析命中。

`ActorWorld.query` 使用 Component 倒排索引并缓存组合结果，只有 Actor 或 Component
结构变化时才失效；因此 System 不会在每 tick 为全部 Actor 重建临时数组。掉落物碰撞
仍进入场景唯一的 `CollisionWorld`，没有额外的空间查询旁路。

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
- TopDown 把玩法 Scene 的完整 `camera.position` 作为相对角色焦点的偏移；焦点通过阻尼追踪角色，不会改写 Scene 定义的距离与构图。当前玩法场景统一使用 `[5.5, 7.5, 8.5]`，从地面 XZ 斜方向俯视角色。
- 在画面上左键或单指拖动可旋转 TopDown 镜头；水平旋转和有界俯仰都使用参考项目的惯性阻尼。
- 玩家模型、步行速度、冲刺倍率和最大可跨越高度来自场景引用的玩家 Actor 原型；默认
  `player-slime` 的 `maximumStepHeight` 为 0.2 米。
- W / A / S / D：按俯视镜头的屏幕方向移动。
- 镜头旋转后，WASD、虚拟摇杆和手柄移动会立即改用新的相机前/右轴，不会沿旋转前的世界方向继续移动。
- Shift：加速移动。
- 鼠标：通过透视射线投影到玩法 XY 平面，并让史莱姆面向投影点。玩法坐标的 Y 在 Three.js 世界中映射为地面的 Z 轴。
- 玩法 TopDown 默认保持 Scene 配置的完整距离和高度，不因树冠、岩石或建筑遮挡自动推近；需要避障镜头的独立控制器仍可显式启用 `CameraBoom`。
- 流式大世界里的树干与岩石会挡住走路，宽大的树冠只挡镜头、不形成隐形墙。
- 水域自由镜头仍使用 WASD；按 F 接管/释放当前可用木筏，方向键发送船舶油门与转向意图。客户端不预测船舶坐标。
- 准星对准线稿货箱时会出现高亮与交互提示；控制木筏后按 E 装载或卸载。距离、控制权、载重和附着位置都由 DS 校验并广播。
- 驶入礁石危险半径会由 DS 按冷却时间造成浮筒损伤；HUD 显示航速、载重、漂浮状态、损伤数和最新事件。
- 左上角 `•••`：打开游戏菜单；“退出房间”会发送离开消息、清理当前地图与玩家，并返回大厅空场景。WebSocket 保持可复用，之后可以直接加入其他房间。

史莱姆参考 `.cursor/demo/line-art-style-magic-cabin-main/index.html`，使用三层透明材质、内部核心、气泡、阴影、顶点波动和移动压缩回弹。`.cursor/demo/` 用于集中存放只读参考案例；该参考路径也记录在 `.cursor/rules/line-art-reference.mdc` 中，作为项目始终生效的规范。

## 房间进程

生产环境目前只有一个对外端口。客户端页面、HTTP API 和 WebSocket 都进入同一个 Node.js
HTTP Server；WebSocket 网关只负责连接和数据帧，`RoomConnectionHub` 再把传输无关的
房间消息路由到对应的房间 DS：

```text
浏览器 / PC WebView
        │
        ├── GET /、/assets/* ─────────→ StaticWebServer → dist/
        ├── HTTP /api/* ──────────────→ ApiRouter → RoomProcessManager
        └── WebSocket /ws ────────────→ WebSocketGateway ──┐
                                                           ↓
                                                   RoomConnectionHub
                                                           │
                                                   RoomProcessManager
                                                           │ IPC
                                    ┌──────────────────────┼──────────────────────┐
                                    ↓                      ↓                      ↓
                               room-worker A         room-worker B         room-worker C
                               ServerScene           ServerScene           ServerScene
```

客户端的 `RoomClient` 同样不直接依赖 WebSocket：大厅列表与建房由 `HttpRoomDirectory`
负责，游戏消息先经过 `MessageCodec`，再交给注入的 `GameTransport`。传输接口提供
`control` 与 `realtime` 两种用途，并通过 `capabilities` 明示实际投递保证。当前
`WebSocketTransport` 把两者都映射为可靠有序传输；后续 Electron 可注入混合实现，
保留 WebSocket 控制通道并把实时输入与快照交给主进程 UDP，而无需修改场景与玩法层。

服务端的 `RoomConnectionHub` 持有逻辑会话、房间归属、输入限流和广播通道选择。
未来增加 `UdpGateway` 时，它与 `WebSocketGateway` 共享这个枢纽，避免复制加入房间、
Actor 控制和断线清理逻辑。

大厅进程只管理静态资源、连接与路由，不直接执行房间模拟。`RoomProcessManager` 每创建
一个房间都会使用 `child_process.fork()` 启动独立的 `room-worker.mjs`。

每个房间进程拥有自己的 `ServerScene`、玩家集合、输入队列和 20 Hz 更新循环。房间异常退出不会拖垮其他房间。

创建房间时会分配一个 32 位世界种子，随房间摘要一起下发。流式场景的客户端据此
生成与服务端一致的地形与物件，换房间就是换一个世界。

房间创建后如果没有玩家，或最后一名玩家离开后，会启动 60 秒空置回收计时；期间有玩家加入会立即取消计时。大厅接口通过 `idleExpiresAt` 返回服务端截止时间，房间卡片据此显示倒计时，归零后自动刷新列表。计时到期仍为空房间时，主进程会关闭并移除对应 DS 子进程。

收到 `SIGINT` 或 `SIGTERM` 时，组合服务器会关闭 WebSocket 网关和连接枢纽、通知
所有房间 DS 退出，并在 HTTP Server 停止监听后结束主进程。

## 移动同步

服务端权威：客户端上报的是**意图**而不是坐标，位置一律由房间进程计算。

```
浏览器                                    房间进程
  每帧本地预测（立即响应输入）
  每 50 ms 上报 { sequence, deltaSeconds,
                 move, sprint, yaw }  ──→  校验 → 推进权威位置
  记录该序号对应的预测位置
                                     ←──  每 100 ms 下发逐连接快照
                                          （高数量 Actor 按 AOI 裁剪）
  自己那条：与预测对账后平滑纠正
  其他人：回退 120 ms 做插值渲染
```

`shared/playerMovement.mjs` 是两端共用的移动实现，`TopDownController` 的本地预测与
`ServerScene` 的权威计算调用同一个 `applyPlayerMovement`，相同输入必然得到相同位置，
客户端预测才有对账的基础。基础速度来自服务器校验后的玩家 Actor 原型，实际速度读取
GAS `Movement.Speed` 的 CurrentValue；涉水 GameplayEffect 因此同时约束 DS 权威移动与
客户端预测。跨越高度仍来自玩家 Actor 原型；
`shared/networkTuning.mjs` 统一了频率、插值延迟与各项阈值。

### 服务端的校验

上报坐标只能做「合理性钳制」，上报输入才谈得上防作弊。当前的校验有：

| 手段 | 位置 | 作用 |
| --- | --- | --- |
| 方向向量归一化到 ≤ 1 | `sanitizeMoveInput` | 放大向量换不来速度 |
| 基础速度由 Actor 原型限定，环境倍率由 GAS Effect 聚合 | `ActorCatalog` + `Movement.Speed` + `applyPlayerMovement` | 客户端不能提交或放大速度参数 |
| 低矮台阶按权威高度过滤 | `maximumStepHeight` + `CollisionWorld` | 低台阶可跨越，高障碍仍推出 |
| 活动范围钳制 | `clampToPlayArea` | 走不出大世界的活动区 |
| 单条输入时长上限 | `ServerScene.applyInput` | 一条消息最多推进 0.1 s |
| 服务器时钟维护的时间预算 | `ServerScene.update` | 谎报时长只会提前花光预算 |
| 序号严格递增 | `ServerScene.applyInput` | 重放与乱序输入被丢弃 |
| 输入消息令牌桶 | `RoomConnectionHub` | 任意传输上的单个逻辑会话都刷不爆房间进程 |
| 非法数值过滤 | `toFiniteNumber` | NaN / Infinity 不会污染权威状态 |

客户端时间不可信是这里最容易踩的坑：`deltaSeconds` 由客户端提供，但服务端按自己的
时钟给每名玩家补充时间预算，谎报时长最多只能提前用完预算，换不到额外位移。

### 服务端权威船舶

`ActorControlComponent` 为可控 Actor 保存排他的 `ownerPlayerId`、输入序号和事件序号；
同一玩家只能占用一艘船，断开或离开房间会自动释放。`VesselMotorComponent` 保存原型配置
与运行态，`VesselMotorSystem` 在 DS 20 Hz tick 中根据油门、转向、浮力降速系数和玩法
边界推进 Transform。超过 300 ms 没有新输入会自动把油门归零，因此丢包不会造成持续失控。

底层载重和损伤变更仍使用统一的 Component mutation；调试入口走 `actor:event`，场景货箱
则走语义更明确的 `actor:interact`。两者都要求序号严格递增，且最终由 DS 做权限与状态校验：

- `cargo:add` / `cargo:remove` 修改 `BuoyancyComponent.loads`，下一 tick 只重算标脏的浮力。
- `damage` 降低原型浮力部件的完整度，可使木筏从正常、超载进入进水或沉没状态。
- 动态载重总量、受损部件数、事件版本和最后事件随 Actor 快照广播。
- 装载货箱通过通用 Actor 父子关系挂到木筏，`AttachmentSystem` 在服务端统一解算 Transform；卸载时解除挂载、保持世界坐标并把它放到船侧。
- `VesselHazardSystem` 在服务端检测木筏与礁石半径，不接受客户端主动上报“已碰撞”。

客户端 `RoomClient` 提供 `sendActorCargoAdd`、`sendActorCargoRemove` 和 `sendActorDamage`
作为底层事件入口，并提供 `interactWithActor` 给准星交互控制器；服务端仍会重新校验所有权、
序号、交互距离、承载关系、数值范围和目标 id。

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
- `src/scene/components/`：由场景 JSON 选择的场景级 Component、生命周期宿主与注册表
- `src/world/`：chunk 流式加载、ChunkView 与生成后端的加载
- `src/environment/`：昼夜时钟镜像、天空渐变与日月星空视觉 System
- `src/weather/`：天气粒子、云层与场景环境合成
- `src/ui/common/`：CommonUI 栈和通用窗体
- `src/ui/pages/`：房间大厅、创建房间页面
- `src/interaction/`：最底层游戏交互事件路由
- `src/controllers/`：TopDown 控制器与 Fly/TopDown 控制路由
- `src/camera/`：相机变换、自由飞行控制器与第三人称相机悬臂
- `src/player/`：玩家实体和史莱姆动画
- `src/network/`：浏览器房间客户端、消息协议与快照插值
- `src/scenes/data/`：客户端场景 JSON 类型
- `src/models/`：程序化地面、树木、草丛、岩石、天体与 chunk 模板/合批
- `src/materials/`：填充 Shader、轮廓线材质与接触阴影材质
- `src/shaders/`：草叶、海面、粒子与共享环境光照的 GLSL 片段
- `server/network/`：WebSocket 网关
- `server/http/`：API 路由、HTTP 响应和生产静态站点服务
- `server/rooms/`：房间进程管理器与 worker
- `server/scene/`：服务端权威场景状态
- `server/actors/`：Actor 原型目录、服务端工厂、浮力与快照逻辑
- `server/scenes/`：JSON 场景目录加载、校验与查询
- `shared/actor/`：浏览器与房间 DS 共用的 Actor、Component、ActorWorld 核心
- `src/actors/`：客户端 Actor Replica、Actor 快照缓冲、渲染 Component 与视觉 System
- `config/actors/`：可复用 Actor 原型 JSON 与 Schema
- `config/scenes/`：每张地图的独立 JSON 与 Schema
- `shared/`：前后端共用的移动模拟、昼夜时钟数学与同步常量
- `shared/world/`：世界配置、chunk 坐标、确定性生成、两种生成后端与 chunk 静态碰撞体
- `shared/collision/`：均匀网格空间划分、场景碰撞世界与扫掠球求交
- `native/chunkgen/`：编译为 WebAssembly 的 Rust 生成与合批实现
- `tests/`：不依赖浏览器的客户端逻辑测试
