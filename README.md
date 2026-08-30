# SkyLand

基于 Vite、TypeScript、Three.js、Node.js 与 WebSocket 的低多边形联机场景原型。

当前包含：

- Three.js 淡色填充与 `EdgesGeometry` 线稿草地场景
- `Scene` / `SceneManager` 场景生命周期
- 每个 Scene 独立的 `CommonUIManager` 栈
- 房间大厅、Grid 房间卡片和通用弹出窗体
- Node.js 大厅进程、WebSocket 网关和每房间独立子进程
- 参考项目风格的透明软体史莱姆玩家
- Fly / TopDown 双控制器自动切换
- 服务端权威的移动同步：输入上行、快照广播、客户端预测与和解
- 无限世界：按玩家位置流式加载程序化地块，内容合批到固定 draw call

## 运行

分别启动房间服务端与 Vite 客户端：

```bash
npm run server
npm run dev
```

- 客户端：`http://localhost:5180`
- 房间服务端：`http://127.0.0.1:3090`
- 生产预览：`http://localhost:4180`

测试与构建：

```bash
npm test          # 服务端与客户端纯逻辑测试
npm run build
```

`tests/` 下的客户端测试由 Node.js 的类型剥离直接运行，覆盖不依赖浏览器的逻辑
（和解、快照插值、几何共用），因此不参与 `tsc` 构建。`src/` 按 Vite 的习惯写
不带扩展名的相对导入，`tests/tsResolverHooks.mjs` 在测试时补上扩展名。

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

## 玩家控制

- 玩家实体不存在：使用原有 `FlyController` 自由飞行镜头。
- 玩家加入房间并生成实体：`SceneControlRouter` 自动切换到 `TopDownController`。
- W / A / S / D：按俯视镜头的屏幕方向移动。
- Shift：加速移动。
- 鼠标：通过透视射线投影到玩法 XY 平面，并让史莱姆面向投影点。玩法坐标的 Y 在 Three.js 世界中映射为地面的 Z 轴。

地形目前是平的，玩家的 Y 恒为 0，所以服务端不需要知道地块内容。等地形起伏之后，
`worldGen` 要移进 `shared/`，让房间进程也能算出同一份高度来校验位置。

史莱姆参考 `.cursor/line-art-style-magic-cabin-main/index.html`，使用三层透明材质、内部核心、气泡、阴影、顶点波动和移动压缩回弹。该参考路径也记录在 `.cursor/rules/line-art-reference.mdc` 中，作为项目始终生效的规范。

## 房间进程

客户端通过 HTTP 获取或创建房间，通过 `/ws` WebSocket 加入房间。大厅进程只管理连接和路由；`RoomProcessManager` 每创建一个房间都会使用 `child_process.fork()` 启动独立的 `room-worker.mjs`。

每个房间进程拥有自己的 `ServerScene`、玩家集合、输入队列和 20 Hz 更新循环。房间异常退出不会拖垮其他房间。

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
| 活动范围钳制 | `clampToPlayArea` | 走不出草地 |
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
- `src/ui/common/`：CommonUI 栈和通用窗体
- `src/ui/pages/`：房间大厅、创建房间页面
- `src/interaction/`：最底层游戏交互事件路由
- `src/controllers/`：TopDown 控制器与 Fly/TopDown 控制路由
- `src/player/`：玩家实体和史莱姆动画
- `src/network/`：浏览器房间客户端、消息协议与快照插值
- `src/world/`：地块生成、构建与流式加载
- `src/models/`：程序化平地、树木、草丛、实例化合批与共用几何登记
- `src/materials/`：填充 Shader 与轮廓线材质
- `server/network/`：WebSocket 网关
- `server/rooms/`：房间进程管理器与 worker
- `server/scene/`：服务端权威场景状态
- `shared/`：前后端共用的移动模拟、分块坐标与同步常量

## 无限世界与分块

世界没有边界。地块边长 32 米、以原点为中心对齐，`ChunkStreamer` 按玩家所在地块
加载周围半径 2（5×5）的范围，走出去就卸载身后的。内容由 `worldGen` 按地块坐标
确定性生成——同一个坐标永远给出同一批树，所以既不需要保存，也不需要在网络上传输。
地块 (0,0) 是出生地，沿用原来手工摆放的三棵树和十三处草丛，向外才程序化生成。

### 合批

线稿风格下每个物体都是「填充网格 + 轮廓线」两次 draw call，逐个物体画的话
draw call 会随内容量线性增长。地块给了一个天然的合批粒度：

- 重复形状（树干、树冠、草叶）各压成一个 `InstancedMesh`
- 所有轮廓线顶点预先乘上各自的变换，合并成一条 `LineSegments`

于是一个地块永远是 6 次 draw call——地面填充、地面网格、树干、树冠、草叶、
合并轮廓线——与里面有多少棵树、多少片草无关。同样的内容（一块地面、三棵树、
33 片草叶）改造前需要 99 次 draw call。

`InstancedMesh` 用自定义 `ShaderMaterial` 时要注意：three 会自动声明
`instanceMatrix`，但不会套用内置的顶点变换块，`createFillMaterial` 必须自己
在 `#ifdef USE_INSTANCING` 下把它乘进模型矩阵。

### 剔除

地块内容又宽又扁（32×32×4），外接球半径至少 22.6 米，球与球大面积交叠，
three 逐物体的包围球判定几乎剔不掉任何东西。所以子物体统一关掉
`frustumCulled`，改由 `ChunkStreamer.cull` 按地块的包围盒整块判定；
`SceneRenderer` 为此把 `prepare`（更新相机与视锥）和 `render` 分成两步。

`InstancedMesh` 还有一个坑：它的包围球只覆盖单个实例，整片草只要地块原点不在
画面里就会被整体剔掉。`instancedBatch` 用同一批 `BufferAttribute` 另建一个
`BufferGeometry` 来换包围球——three 的 GPU 缓冲以 attribute 为键，这样不产生
任何额外上传，代价是这个视图与别处共用底层数据，绝不能 dispose。

### 兴趣区

世界无限之后，一份快照装下全房间玩家就没有意义了。`filterSnapshotForViewer`
按每个连接自己的位置裁剪快照，只保留 96 米内的其他玩家；观察者自己那条永远保留，
客户端的预测和解要靠它对账。兴趣区半径远大于雾的可见距离（52 米），所以边界处
玩家的进出在画面上看不出来。

## 几何共用

线稿风格下每个物体都是「填充网格 + `EdgesGeometry` 轮廓线」两份资源，草叶和树冠
这类重复形状一旦逐个构建，浪费会随场景规模线性放大。

`createOutlinedObject` 按几何缓存顶点法线与轮廓线：同一份几何加同一个阈值只算一次，
之后所有实例共用同一个 `BufferGeometry`，位置与旋转留在 `Object3D` 上。当前草地场景
的几何上传量因此从 118 次 / 31.2 KB 降到 36 次 / 9.6 KB，渲染结果逐像素不变。

共用的代价是所有权变含糊：任何单个物体 dispose 掉它，其他还在用的物体会一起失效。
`src/models/sharedGeometry.ts` 把共用关系显式登记下来，释放资源的一方（例如玩家离开
时的 `RemotePlayer.dispose`）据此跳过。
- `tests/`：不依赖浏览器的客户端逻辑测试
