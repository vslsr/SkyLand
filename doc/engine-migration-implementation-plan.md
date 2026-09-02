# 引擎自研迁移 · 实现路径

> 配套文档：`doc/engine-migration-roadmap.md`（方案与论证）
> 本文只回答一件事：**那份路线图落到这个仓库里，一次改一步，每一步改哪些文件、验收标准是什么。**
> 分支：`claude/engine-migration-roadmap-vlqccr`

路线图的结论是「关键路径只有两件事：PlatformLayer 的线程抽象、SceneLayer 的 Render 边界」。
本文按这个结论排序，把每一步拆成**可以单独合入、单独回滚**的一次改动。

---

## 进度

| 步骤 | 状态 | 落地 |
| --- | --- | --- |
| 第 0 步 · 跨源隔离 | **已完成** | `server/http/crossOriginIsolation.mjs`、`vite.config.ts`、`src/platform/` |
| 第 0.5 步 · 惰性 step 语义补测试 | **已完成** | `server/tests/physicsLazyStep.test.mjs` |
| 第 0.5 步 · 合并两套碰撞 | 未开始 | 见 §0.5b——它不是纯清理，需要单独立项 |
| 第 1 步 · 剥出 Render World 边界 | **已完成** | `src/render/`、`RenderProxyComponent`、`ActorTransformSystem` |
| §8.2 · GPU 资源所有权表 | **已完成（最小核心）** | `src/core/assets/AssetOwner.ts`、`src/render/renderAssets.ts` |
| 第 1.5 步 · 表现 Component 脱离 THREE | **已完成** · 棘轮 8 → 0 | 见 §1.5；玩家实体也接到了边界上 |
| 第 1.75 步 · 拆掉表现 System 的夹心 | **已完成** | 见 §1.75；Actor 世界只剩五个不认识 three 的 System |
| 第 2 步 · Sim Worker | **前提被测量推翻** · 已打点、已量、结论见 §2 | 搬进 worker 只能省约 1.2 ms／帧 |
| §2 第 1 项 · 摊平 `render-spawn` | **已完成** | 进房间那一帧 146 ms → 15 ms，见 §2「已经做了的」 |
| §2 第 2 项 · 地形碰撞网格进 worker | **已完成** | PlatformLayer 第二块 + chunk 挂载 4.2 → 2.45 ms |
| 第 3 步 · OffscreenCanvas | **进行中** · 可行性已验证、前置已拆两件 | 见 §3；`SceneWorld` + 合批实例通道 |
| 第 4 步 · 换掉 Three.js | 可无限期推迟 | 见 §4 |

依赖关系没变，仍然是路线图里那条：`0 → 0.5 → 1 → 2 → 3 → 4`，§8.1 / §8.2 与 ToolLayer 可并行。

---

## 第 0 步 · 跨源隔离 ✅

`SharedArrayBuffer` 与 Emscripten pthreads 只在 `crossOriginIsolated === true` 的文档里可用。
仓库此前既没有 COOP 也没有 COEP，SAB 处于禁用状态。

**改动**

- `server/http/crossOriginIsolation.mjs`：`COOP: same-origin` + `COEP: require-corp` + `CORP: same-origin`。
  在 `server/index.mjs` 路由之前统一 `setHeader`，所以文档、静态资源、API 与错误响应共用同一份策略——
  只要有一份 HTML 漏了，整页就拿不到隔离，而失败方式是「SAB 静默不可用」，不是报错。
- `vite.config.ts`：`server.headers` 与 `preview.headers` 发同一组头，本地开发的能力集与线上一致。
- `src/platform/threading.ts`：PlatformLayer 的第一块。`detectThreadingCapabilities()` /
  `allocateSharedBytes()` / `isSharedBytes()`。
  未隔离的浏览器**仍然暴露 `SharedArrayBuffer` 构造器**，所以探测按 `crossOriginIsolated` 判定；
  把「有构造器」当成「能共享」，会让问题留到 worker 上线那天。
- `src/main.ts` 启动日志打印能力集。

**验收**：`server/tests/crossOriginIsolation.test.mjs`、`tests/PlatformThreading.test.ts`，
以及真实浏览器里的 `crossOriginIsolated === true`——启动日志现在打的是
`isolated · shared-memory · workers · offscreen-canvas`，第 2、3 步要的能力全部就位。

**顺带确认**：全仓零外部资源（`src/ui/icons/IconSprite.ts` 里唯一的 `http://` 是 SVG 命名空间），
所以 `require-corp` 没有挡掉任何东西。以后引入 CDN 字体或图片时，对方必须带 `Cross-Origin-Resource-Policy`。

---

## 第 0.5a 步 · 钉住惰性 step 语义 ✅

`PhysicsWorld.step()` 上那句 `do not remove this apparently empty tick` 是一条隐含契约：
Rapier 的新 collider 要等一次 `world.step()` 之后才对查询可见，查询入口靠 `prepareQueries()` 补跑。

**验收**（`server/tests/physicsLazyStep.test.mjs`，四条黑箱断言；
观测手段是 `castCameraSphere()` 会 `prepareQueries()`、`castRay()` 不会，差值即「这一步跑没跑」）：

1. 新 collider 在补跑一步之前对查询不可见；
2. `prepareQueries()` 只在脏的时候补跑，跑完即清标记；
3. **补跑的是真实一步，会把动态刚体推进一个 timestep**——这是最容易被忽略的副作用，
   查询挪到别的线程时必须原样保留，否则同一段玩法代码在两端会得到不同的轨迹；
4. chunk / actor / static group / character 九类变更都会重新置脏。

---

## 第 0.5b 步 · 合并两套碰撞（未开始）

路线图把它标成「纯清理」。**按当前代码它不是。**

- `shared/collision/`（913 行，均匀网格 + 解析推出）服务非玩家 Actor 的推出与交互宽相；
- `shared/physics/PhysicsWorld.mjs`（Rapier）服务玩家移动与相机悬臂。

两者的解算结果不同：`CollisionWorld.resolveCircle` 是两轮解析推出，Rapier 是 KCC 的
`computeColliderMovement`。合并意味着**改变权威玩法行为**，要重新标定，并且客户端与服务端
必须同一次提交一起换（和路线图 §11 对换 Jolt 的要求同构）。

建议独立立项，验收条件写成「同一批输入下推出结果的最大偏差」而不是「代码合并完成」。
在那之前它不阻塞第 1、2 步：`ClientActorSystem` 已经同时向两者登记 Actor 碰撞盒。

---

## 第 1 步 · 剥出 Render World 的边界 ✅

路线图里回报最高的一步：**不改一个像素**，但把「Game World 与 Render World 之间只能过数据」
这条约束用代码强制下来。

### 落地形态

```text
Game World                     边界                      Render World
──────────────────────────────────────────────────────────────────────
Actor                                                    ThreeRenderScene
 └ RenderProxyComponent    ┌────────────────────┐         └ ThreeMeshProxy[]
      proxyId: number  ──▶ │ RenderTransformBuffer │ ──▶       root / visualRoot
                           │ SAB · bank0 / bank1  │            rigs · 材质
ActorTransformSystem       │ f32 x y z yaw        │
 只写字节，不 import three   │ i32 parentSlot       │       submitTransforms()
                           └────────────────────┘       从字节反算局部坐标
```

| 文件 | 作用 |
| --- | --- |
| `src/render/RenderScene.ts` | §2 的接口。按 §4.5 收窄成固定四类，**刻意没有 `createProxy(desc)`**——新增一类内容要新增一个具名入口，而不是往可变长表里再塞一种 kind。第 1 步只搬 `Meshes[]`。 |
| `src/render/RenderTransformBuffer.ts` | 坐在边界上的 SoA 双缓冲。一整段字节（header + `Float32` transforms + `Int32` parents），一次 `postMessage` 就能交给 worker。 |
| `src/render/three/ThreeRenderScene.ts` | `RenderScene` 的 Three 后端。类里没有一个 `Actor` 类型。 |
| `src/render/three/ThreeMeshProxy.ts` | 从 `ThreeObjectComponent` 搬过来的那份状态——同样的 Object3D，从 Actor 上换到了渲染世界里。 |
| `src/actors/components/RenderProxyComponent.ts` | 取代 `ThreeObjectComponent`，**只持有一个整数**加一个命令口。 |
| `src/actors/systems/ActorTransformSystem.ts` | 只写 SoA。这个文件因此不再 `import three`。 |
| `src/actors/systems/RenderTransformSyncSystem.ts` | 翻面并提交。**第 3 步之后它会消失**——它现在的存在本身就是「还没拆线程」的标记。 |

### 三条被代码强制的约定

1. **Render World 里没有指向 Actor 的指针**，只有 `ProxyId` 和自己的数据副本。
2. **Game World 里没有 `THREE.Object3D`**。`tests/RenderSceneBoundary.test.ts` 会遍历 Actor 的
   每个 Component 字段断言这一点，并检查 `ActorTransformSystem.ts` 没有 `import three`。
3. **父子关系只以 `parentProxyId` 过边界**。「局部坐标怎么算」是 Three 场景图的需求，
   属于渲染侧；换成别的后端时这段数学可能根本不需要。

### 验收

- `tests/RenderSceneBoundary.test.ts`、`tests/RenderTransformBuffer.test.ts`，全套测试绿。
- 无头 Chromium 实跑四张地图：能力实验室（Actor + 能力 rig）、无边草原（流式 chunk、
  生成物件 proxy 的持续增删）、线稿海域（父子 Actor 的木筏与货箱、浮力波动）。
  持续行走 6 秒，画面与 chunk 流送正常。

### 唯一的行为变化

渲染世界拿到的是权威 transform 的 **f32 镜像**（SoA 是 `Float32Array`），Actor 上的权威值仍是 f64。
512 米世界里误差约 0.06 毫米，而 §4.3 计划中的顶点格式是 `i16` 量化到毫米——f32 远高于目标精度。
相关断言已改按 f32 容差比较。

### 三条留给后续步骤的约定

- **每帧写满所有存活槽位。** 双缓冲不做脏标记；`publish()` 之后新的写面是刚发布那一面的副本，
  所以漏写一帧退化成「保持上一帧」，不会读到两帧前的值。
- **视图只在 `RenderTransformBuffer.#adopt()` 里重建。** 现在只有自己的扩容会重新分配；
  等 Emscripten 开了 pthreads，WASM heap 是 SAB、别的线程增长堆会让所有 JS 侧视图失效——
  那时这个类改成「每次访问重取视图」，接口不变。路线图 §5 的第三个坑被关在了这一个文件里。
- **表现 System 仍然读 Actor 的 Component**（浮力、货物、弹性绳、挂载、脱落翻滚）。它们现在按
  `proxyId` 向渲染世界取 Object3D，不再从 Actor 上直接摘。第 1.5 步的棘轮管的是 **Component**，
  管不到它们——这条耦合到第 1.5 步结束仍然在，是第 2 步要划的那条缝（见 §1.5「渲染世界的归属」）。

---

## 第 1.5 步 · 表现 Component 脱离 THREE ✅

第 1 步只搬了 `ThreeObjectComponent`。**只要还有一个 Actor Component 握着 Object3D，
Sim Worker 就搬不过去**——对象过不了线程边界。所以这一步是第 2 步的硬前置。

规则：**Actor Component 不得 import 渲染侧模块**（`three` / `models` / `guidance` /
`slime` / `grass` / `materials`；`render/` 里的边界类型不算，那正是它该引的）。
`tests/RenderSceneBoundary.test.ts` 里那份豁免清单当棘轮，**只能变短**——现在它空了。

### 八项都搬完了

| Component | 原来持有 | 现在过边界的 |
| --- | --- | --- |
| `PbfSlimeVisualComponent` | 整条旧 PBF 表现 | **删除**（不可达，见下） |
| `GrassDisplacementComponent` | `THREE.Object3D` | `WorldPositionSampler` 回调 + 数字 |
| `FireVisualComponent` | 火焰动画状态 | 一个目标强度（参数段） |
| `InteractionMarkerComponent` | 自绘标记 + 朝向相机的四元数 | spawn 时的「要不要」+ 标签命令 |
| `TemperatureMarkerComponent` | 同上 | 温度值（参数段）+ 全局开关 |
| `GuidePathVisualComponent` | `GuidePath` 整条线 | **变长**：走 `RenderCommandSink` |
| `HybridSlimeVisualComponent` | 蒙皮 rig，`BufferAttribute` 直写 | 七个 f32（`SlimeMotionParams`） |
| `SlimeSurfaceDragComponent` | `Raycaster` + 一堆 `Vector3` | **什么都不过**：整体属于渲染侧 |

`PbfSlimeVisualComponent` 是删的不是搬的：连同 `PbfSlimeVisualSystem` 整条旧 PBF 表现路径
不可达——那个 System 从未出现在 `addSystem` 列表里，Component 也只被它自己引用。
（`src/slime/pbf/PbfSlimeSimulation.ts` 因此没有引用者了；路线图写明「旧 PBF 求解器仍独立
保留」，删不删是产品决定。）

### 玩家实体也接到了边界上

最后两项锁在一起（共用同一份 rig 与 `HybridSlimeSimulation`），而且都卡在同一个前提上：
**本地玩家根本没有 ProxyId**——它的模型由 `renderer.addWorldObject()` 直接挂进场景，
从没经过 `ThreeRenderScene`。所以这一步顺带把 `src/player/` 整个接了过来：

- `RenderScene` 新增具名入口 `createPlayerProxy(PlayerProxyDesc)`。玩家是**另一类内容**
  （自带配色、走路动画、蒙皮拖拽），按 §4.5 的取向给它一个入口，而不是往 `MeshProxyDesc`
  上挂几个只有玩家会用的可选字段。
- **过边界的配色是身份不是颜色**：desc 里是 `paletteSeed`（远端玩家的 id），
  哪种身份配哪套颜色由渲染侧决定。
- `PlayerEntity` / `RemotePlayer` 各自持有一份 f64 的 transform 记录，每帧兑现进 SoA；
  渲染侧那份 f32 是镜像，不是源。两者都不再持有 `Object3D`，
  `createPlayerActorVisual` 缩成 `playerVisualShape.ts` 里的三个标量。
- 过渡形态 `src/player/objectPositionSampler.ts` 随之删除。
- **帧序**：玩家更新排到 `renderer.update` 之前。翻面发生在 Actor 世界里，写在翻面之后
  就晚一帧——软体读到的速度会和它被摆到的位置对不上。

### 蒙皮拖拽：不是所有表现都要过边界

`SlimeSurfaceDragComponent` 有一个同步 `beginDrag(ray): boolean`——看上去是条 Render→Game
的反向读，实际上不是：**指针、相机和外壳三样东西都在渲染这一侧**。它从来就不是玩法
（拾取的是动态 `BufferGeometry`，写的是纯客户端弹簧力，既不移动 Actor 根节点，也不碰
权威碰撞或网络状态）。所以整条链路搬进渲染世界，`SlimeSurfaceDragController` 改由场景
持有、按 `ProxyId` 寻址，往玩法侧只发「拖拽开始/结束」一个布尔（一次手势只有一个所有者）。

### 定长参数通道

火焰立起来的这段通道，后面几项的定长参数直接复用：

```text
ActorTransformSystem      写 transform ─┐
ActorVisualParamSystem    写 params    ─┼─→ 同一段字节 ─→ publish() ─→ 渲染侧读
RenderTransformSyncSystem publish + submit                （帧一致，不会撕裂）
```

- `src/render/RenderVisualParams.ts`：具名下标 + `COUNT`。新增参数在这里加常量，不是往表里塞 key。
- **参数与 transform 必须同段**：分两个缓冲各自 `publish()` 会撕裂——强度来自第 N 帧、位置来自第 N+1 帧。
- **每帧写满所有存活槽位**（没有该表现的写 0）。槽位销毁后立刻还给 `freeSlots` 供复用；
  参数段若只在值变化时写，复用槽位的新 proxy 会读到上一个 proxy 的值。逐帧写满是为了沿用
  transform 段已有的不变量，而不是另立一条「谁负责清零」的规则。
- **不要量化**。火焰那对阈值（吸附 0.002、可见 0.01）是一对，塞进 u8 或 f16 会让强度永远吸不到 0。

三条通道按**数据形状**选，不按内容选：

| 形状 | 通道 | 例子 |
| --- | --- | --- |
| spawn 时的一次性事实 | `MeshProxyDesc` / `PlayerProxyDesc` | 模型配置、要不要标记牌、引导线样式、配色种子 |
| 每帧的定长标量 | 参数段 SoA | 火焰强度、温度、史莱姆的七个运动量 |
| 变长 / 只在变化时 | `RenderCommandSink` | 引导路径的路点、交互标签 |

`PARAM_SLIME_AIRBORNE` 存的是「离地」而不是「贴地」，这是被上面那条「写 0」规则逼出来的：
求解器的默认态是 `grounded = true`，存 `grounded` 的话 0 就成了「浮空」，所有不驱动这项
参数的史莱姆都会被当成在空中。取反之后默认值自洽。

**权威 yaw 一个字节都没过边界。** 它就是 `submitTransforms` 刚写进 `proxy.root.rotation.y`
的那个角度——外壳要抵消的正是「root 这一级实际被转了多少」，在渲染世界内部读它是
Render→Render。这也顺手修掉了 `HybridSlimeVisualSystem` 那条反向依赖（那个 System 整个
删掉了）：它此前从 `render.root.rotation.y` 回读，上 worker 之后读不到，而且对**有父节点的
Actor 是错的**——`submitTransforms` 给子节点写的是相对 yaw，读回来当世界 yaw 用会抵消错角度。

### 顺带修掉的两个真实缺陷

现状调查在两个装配枢纽里翻出来的，与搬迁本身无关但同属这条边界：

- `createReplica` 在 `createMeshProxy` 与 `addActor` 之间会抛（原型声明了 `temperature`
  却没装上 Component 时），抛出后槽位既不在 `freeSlots` 里也没有 Actor 持有它——泄漏一个
  挂在场景图上的模型。已包进 `try/finally`。
- `ClientActorSystem.dispose` 不调用 `renderScene.dispose()`，渲染资源的释放完全依赖
  「每个 proxy 都恰好有一个活着的 Actor 持有它」这条不变量，而上面那条路径正好破坏它。

### 渲染世界的归属

渲染世界（`ThreeRenderScene` + `RenderTransformBuffer`）现在由 `createLineArtScene` 建，
挂在 `SceneComposition` / `SceneRenderer` 上——不再归 `ClientActorSystem`。理由是玩家：
它不是 Replica，但它的 proxy 必须和 Actor 的 proxy 落在同一张槽位表、同一段 SoA 里，
否则「一个 `ProxyId` 指一个东西」就不成立了。

两处连带：

- **Actor 世界改成总是建**，哪怕地图上一个 Actor 都没有。渲染世界那次翻面归它管
  （`RenderTransformSyncSystem` 夹在写 SoA 与依赖翻面结果的 Actor 表现 System 之间），
  按「有没有 Actor」建它会让没有 Actor 的地图上玩家整个不动。空的 `ActorWorld` 每帧什么都不做。
- **那个夹心结构在 §1.75 里拆掉了**：当时 `AttachmentVisualSystem` 读的是翻面之后摆好的
  Three 局部变换，所以 publish/submit 拆不出 Actor 世界。现在它搬进了渲染世界，
  Actor 世界里 `RenderTransformSyncSystem` 是最后一个。「谁驱动谁就负责释放」仍然成立：
  `ClientActorSystem.dispose()` 释放渲染世界。

### 下一步

Component 的棘轮空了，但 Actor 世界里跑的 **System** 还有五个握着 `ThreeRenderScene`。
那是 §1.75。

---

## 第 1.75 步 · 拆掉表现 System 的夹心 ✅

第 1.5 步把表现从 Component 上摘了下来，但 `ClientActorSystem` 往 `ActorWorld` 里
注册的 System 还有五个直接改 Three 对象。其中一个是**真正的结构性障碍**：

```text
搬迁之前，Actor 世界里的顺序：
  ActorTransformSystem        写 SoA
  ActorVisualParamSystem      写 SoA
  RenderTransformSyncSystem   publish + submitTransforms   ← 翻面被夹在中间
  WaterBob / Cargo            改 visualRoot
  AttachmentVisual            读父子两级刚摆好的 matrixWorld ← 就是它要求翻面先发生
  ElasticTether / DropRoll    改 rig
```

`AttachmentVisualSystem` 读的是 `submitTransforms` 刚写进 `root`/`visualRoot` 的
世界矩阵，所以翻面必须排在它前面；而写 SoA 又必须排在翻面前面。这个夹心结构让
「Actor 世界整体搬进 worker、submit 留在主线程」这条第 2 步的路线走不通。

而它真正需要的东西只有一样：**父子关系**——那本来就在 SoA 的 parents 段里。

### 五个都搬了

| 原 System | 现在 | 跨边界的 |
| --- | --- | --- |
| `WaterBobVisualSystem` | `ThreeWaterMotionVisual`（`hull`） | 吃水 + 两个静态倾斜 |
| `CargoVisualSystem` | `ThreeWaterMotionVisual`（`cargo`） | 什么都不用加：transform 与 parent 都在 SoA 里 |
| `AttachmentVisualSystem` | `ThreeAttachmentVisual` | 同上 |
| `ElasticTetherVisualSystem` | `ThreeElasticTetherVisual` | 目标点、两个状态位、拔断长度、松手计数 |
| `ActorDropRollSystem` | `ThreeDropRollVisual` | 半径 + 四元数 |

几处值得记下来的判断：

- **浪高不过边界。** 波面公式是渲染配置，不是玩法状态——渲染侧自己按世界坐标采样
  就行。过边界的只有吃水深度和装载造成的静态倾斜。
- **「船体还是货箱」是一个值，不是两个开关。** 原型里 `buoyancy` 与 `cargo` 互斥
  （船有前者、箱有后者），所以 `MeshProxyDesc.waterMotion: 'hull' | 'cargo'`。
- **弹性拉伸的相位改成哈希槽位。** 它以前哈希 Actor id，用途只有一个——把闲置摆动
  错开。槽位在这个 proxy 活着的整段时间里不变，所以效果一样。
- **`ThreeElasticTetherVisual` / `ThreeDropRollVisual` 不需要 desc 标记。** 只有弹性
  蘑菇那种模型才会建出对应的 rig，而它们正是原来那两个 System 会挑中的 Actor——
  rig 的有无本身就是那个事实。
- 参数段 9 → 24。每槽位 24 个 f32、两份 bank、容量 256，合计约 49 KB，可以忽略。

### 新棘轮：Actor 世界里的 System

`tests/RenderSceneBoundary.test.ts` 里多了两条：

1. `ActorTransformSystem` / `ActorVisualParamSystem` / `ActorInstanceSystem` /
   `ActorGuidePathSyncSystem` / `RenderTransformSyncSystem` 都不得 import 渲染实现；
2. **这份名单必须等于 `ClientActorSystem` 里 `world.addSystem(...)` 的实际列表**。
   少了第二条，新增一个 System 就会被第一条悄悄放过。

为此 `GuidePathState` 挪到了 `RenderScene.ts`，`setGuidePath` 进了
`RenderCommandSink`——引导路径同步因此也只依赖边界类型。

### 下一步

Actor 世界这一侧干净了。剩下的耦合在**上一层**：`ClientActorSystem` 自己仍然是
render 与 game 混在一起的（果实实例化、悬停高亮、`root` getter 都在里面；
合批已经在第 3 步里靠实例通道拆开了），
`src/scenes/GrasslandScene.ts` 也同时握着输入、相机、玩家实体和渲染器。
第 2 步要划的缝就在这两处，见 §2。

---

## 第 2 步 · 网络 + Game World + 物理整体进 worker（**前提已被测量推翻**）

依赖 0、1、1.5、1.75。改动清单的第 5 项（帧时间打点）**先做了**，因为路线图自己写着
「方向认同，但归因建议先测」。量完之后前四项失去了依据，所以这一节改成先摆证据。

### 怎么量的

`src/platform/FrameTimeline.ts`：分阶段**自耗时**、环形窗口、p50/p95/max。
阶段可以嵌套，子阶段的整段耗时从父阶段扣掉——`createReplica` 里那次建模型嵌在
`applySnapshotSet` 里，平的记法会让同一段时间既算进 `sim-actors` 又算进
`render-spawn`，把「搬进 worker 能省多少」凭空翻倍。

打点按**「第 2 步之后这段代码会在哪个线程上」**分组，不按模块分。

环境：headless Chromium + SwiftShader（软件光栅），`无边草原` 流式地图，一路向前走
22 秒。**`draw` 因此被严重放大**（真实 GPU 上它是提交命令的 CPU 时间，不是光栅化），
其余阶段是 CPU 侧的真实数字。跨源隔离已生效：`isolated · shared-memory · workers ·
offscreen-canvas`。

### 稳态（不建 chunk 的帧，n≈46–64，整帧 p50 ≈ 10.7 ms）

| 阶段 | p50 | 第 2 步之后在哪 |
| --- | --- | --- |
| `draw` | 6.33 ms | 主线程（SwiftShader 放大，真实 GPU 上远小于此） |
| `sim-colliders` | 0.61 ms | **Sim Worker** |
| `sim-actors` | 0.49 ms | **Sim Worker** |
| `render-visuals` | 0.30 ms | 主线程 |
| `scene-systems` | 0.24 ms | 主线程 |
| `render-batches` | 0.14 ms | 主线程 |
| `sim-player` | 0.06 ms | **Sim Worker** |

**要搬进 Sim Worker 的三项加起来是 1.16 ms，占整帧 11%。** 把 `draw` 换算成真实 GPU
（假设 1 ms），整帧约 5.5 ms，Sim 占比也就 21%——仍然不是瓶颈所在。

### 建一个 chunk 的那一帧（n≈5–15 帧／窗口）

| 阶段 | p50 | 性质 |
| --- | --- | --- |
| `chunk-geometry` | 2.10–2.45 ms | Three 对象；第 3 步之前挪不走 |
| `chunk-terrain-build` | 1.34–1.37 ms | 纯计算，可挪 |
| `chunk-terrain-register` | 0.63–0.97 ms | 往 Rapier 的 WASM 堆里塞，随物理世界走 |
| `chunk-props-collide` | 0.21–0.32 ms | 纯计算，可挪 |
| **`chunk-gen`** | **0.17 ms（WASM）／0.34 ms（JS）** | 纯计算，可挪 |
| `chunk-grass` | 0.15–0.29 ms | |

### 三条结论

1. **「`native/chunkgen` 单独一个 worker」这条建议的前提是错的。** 路线图的理由是
   「`CHUNK_BUILD_BUDGET_PER_FRAME = 1` 这个预算本身就是『生成在主线程会卡帧』的补丁」。
   实测：生成是这六项里**最便宜**的一项，WASM 下 0.17 ms。预算是被
   `chunk-geometry`（2.1 ms）+ `chunk-terrain-build`（1.3 ms）逼出来的。
   强制走 JS 后端（`?chunkgen=js`）也只有 0.34 ms——**这就是这个 worker 的收益上限**。

2. **整个 Sim Worker 只能省约 1.2 ms／帧。** 它不是吞吐量优化。

3. **两处真正的卡顿都在渲染侧，Sim Worker 一点忙都帮不上：**
   - `render-spawn`：进房间那一帧 **31–146 ms**，n=1。`createReplica` 把当批 Replica 的
     模型一次全建出来（`createMeshProxy` → `createActorVisualModel`）。
   - chunk 挂载：约 4–5 ms 的尖峰，其中最大的一块是 Three 几何。

### 那第 2 步还做不做

**做，但理由要换掉，而且不该排在最前面。** 换掉之后仍然成立的理由只剩两条，
它们都不是吞吐量：

- **模拟脱离 rAF**。现在固定步被绑在渲染帧上，`MAXIMUM_SIMULATION_CATCH_UP_STEPS = 5`
  就是「切后台标签会积压」的补丁。搬进 worker 之后模拟按自己的时钟走，这个补丁可以删。
- **渲染线程能在两帧模拟之间插值**：144 Hz 屏幕上跑 144 Hz 画面，模拟仍是 60 Hz。
  这条要等第 3 步，第 2 步是它的前置。

按证据重排的话，性价比顺序是：

| 顺序 | 做什么 | 依据 | 状态 |
| --- | --- | --- | --- |
| 1 | **摊平 `render-spawn`**：Replica 建模按帧预算分摊 | 单帧 31–146 ms，是全程最大的一次卡顿 | **已完成** |
| 2 | **`chunk-terrain-build` 进 worker**（不是 `chunk-gen`） | 约 1.3 ms，是 chunk 尖峰里最大的那块纯计算 | **已完成** |
| 3 | 第 3 步 · OffscreenCanvas | `chunk-geometry` 与 `render-visuals` 只有到那时才挪得走 | 未开始 |
| 4 | 第 2 步 · Sim Worker | 收益是决定论与解耦，不是帧时间 | 未开始 |

`chunk-props-collide` 最后**没搬**：它 p50 只有 0.2–0.3 ms，而它依赖生成器的输出
（`props` 数组），要搬就得在生成之后再来一趟往返——为 0.3 ms 加一次往返不划算。

### 已经做了的：第 1 项 · 摊平 `render-spawn` ✅

`ClientActorSystem` 的 Pass 1 现在按**时间预算**建 Replica，默认 4 ms／帧。

**为什么是时间预算不是个数预算。** 要压的就是「一帧的墙钟时间」，而不同原型的建模
成本差一个数量级——`CHUNK_BUILD_BUDGET_PER_FRAME = 1` 那条按个数的预算在这里压不住
最贵的那几个。预算再紧也保证每帧建一个，否则视野里新出现的 Actor 可能永远排不上。

**没有待建队列。** 快照集合每帧都完整重放，这一帧没轮到的下一帧自己会再来；于是
「排着队的 Actor 已经离开视野」这种脏状态根本不存在——它自然就不会被补建。这是
分帧方案里最容易做错的一块，而这个系统的结构正好让它不必存在。

**父节点优先。** 「父节点可以出现在快照的任意位置」是 Pass 1 原本就保证的性质，
分帧之后更要紧：孩子先于父节点被建出来的话，Pass 2 会把它当成「挂在外部 Actor 上」
——那条路径是给玩家用的，一个本该跟着船走的货箱会被当成玩家嘴里叼着的东西。
所以建之前先递归建父节点；父节点这一帧建不出来就连孩子一起推到下一帧。
脏数据里的环形父子关系用一条链集合挡住，不让它把客户端拖进死循环。

实测（同一环境）：

| | 之前 | 之后 |
| --- | --- | --- |
| 进房间那一帧 | 31–146 ms，n=1 | 摊到 10 帧，单帧最大 **15 ms** |
| 稳态走动时的 `render-spawn` | —（都挤在进房间那一帧） | p50 4.7–4.8 ms，p95 5.4–8.2 ms |

超出 4 ms 的那一点是「已经开工的模型要建完」，上限就是最贵的那一个模型。
真要再压下去，得让 `createMeshProxy` 本身可分段——那属于第 3 步的范围。

### 已经做了的：第 2 项 · 地形碰撞网格进 worker ✅

**PlatformLayer 的第二块**：`src/platform/WorkerJobRunner.ts`。

做成**一次请求一次响应的纯函数调用**，不是通用消息总线。要搬的活本来就是纯函数，
而通用总线会诱使调用方把状态也搬过去——那是第 2 步真正难的部分，不该被一个工具类
顺手带进来。拿不到 worker（或构造失败、或 worker 崩了）就地跑同一份实现，
而且保持同样的 `Promise` 形状：调用方只有一条代码路径。这和
`loadChunkGenerator` 里「WASM 加载失败就降级到 JS」是同一个取向。

**过边界的是种子和编辑覆盖，不是算好的格子码。** 第一版是主线程先把那 289 格采样好
再送过去——打点立刻照出问题：`chunk-terrain-sample` p50 **1.09 ms**。算格子码本身就
不便宜（每格五次程序化底图评估 + 一次哈希 + 一次带字符串键的 Map 查询），主线程先算
一遍等于把要搬走的活留了一半在原地。改成只送 `worldSeed` 和这一窗里的编辑覆盖之后，
主线程这一步是 `chunk-terrain-overrides` p50 **0.02 ms**——没被编辑过的 chunk
（绝大多数）更是零成本。

**挂载改成两段，而且顺序不能反。** 先请求地形网格，回来了才建视图：那张 trimesh
就是玩家脚下的地面（Rapier 的角色控制器直接踩它），先挂视图再等网格，流送边缘会
出现「看得见但踩不到」的一格，玩家会掉下去。同时在途 4 个，一趟往返的延迟正好被
「每帧最多挂一个」的预算掩掉。

**地形编辑仍然走同步重建。** 编辑是一次用户动作，等一趟往返笔刷会有延迟；流送是
后台行为，等得起。这条分界也让「异步」只影响一条路径。

| | 之前 | 之后 |
| --- | --- | --- |
| `chunk-terrain-build` | p50 1.2–1.4 ms | 主线程报表里**消失**（只剩编辑路径） |
| 主线程收集输入 | — | `chunk-terrain-overrides` p50 0.02 ms |
| 单个 chunk 的主线程成本 | 约 4.2 ms | 约 **2.45 ms** |

安全绳是一组等价性用例：工作线程「按种子推 + 打覆盖」得到的格子码，必须和权威
`TerrainPatchStore` **逐格相同**，包括落在东、北那多出来的一行一列上的编辑——
推错一格就是穿地，不是画面瑕疵。

### 原改动清单（保留，但 1–4 项的依据已经不成立）

- **不能拆网络与模拟**：紧耦合链「快照到达 → 和解 → 回放未确认固定步」是突发尖峰，
  拆两个线程只会凭空多一跳。`WebSocket` 在 Worker 里可用，整个搬进去。
- **别把 `GameTransport` 的双通道当成已有能力**（路线图 §6.1 已修正）：
  `unreliable-sequenced` 从未被任何实现使用过，`WebSocketTransport` 的 `realtime`
  声明的是 `reliable-ordered`，两条通道走同一个 socket。这一层描述的是**目标形态**，
  不是现状。搬进 worker 不改变这一点——它只是把同一个 WebSocket 换个线程。
- **换传输不在第 2 步的范围内**，而且前置成本在服务端（§6.4：客户端约 10%、
  服务端约 90%）。`server/network/WebSocketGateway.mjs` 写死了 WebSocket，
  服务端根本没有对应的传输抽象——这层不对称本身该补，但与线程拆分无关。
  在快照率提到 30–60 Hz、压低插值延迟、或面对高丢包移动网络之前，换传输
  属于没有证据支撑的优化（§6.3：120 ms 插值缓冲正好吃掉一次 TCP 重传，
  而快照是全量状态，丢一帧只靠外推撑过去）。
- 做完可以删掉 `MAXIMUM_SIMULATION_CATCH_UP_STEPS = 5`——那个常量只是「模拟被绑在
  渲染帧上」的补丁。**这条仍然成立，而且是第 2 步剩下的主要理由。**

1. ~~`src/platform/` 加 worker 生成与消息通道（PlatformLayer 的第二块）~~ **已完成**：
   `WorkerJobRunner.ts`，第一个用户是地形碰撞网格（见上）；
2. 输入按 tick 号序列化进一个 SAB 环形缓冲（主线程退化成 IO 线程）；
3. `ClientActorSystem` 先按 game / render 一分为二：`ActorWorld` 与快照插值这一半进 worker，
   合批、果实实例化、悬停高亮与 `root` 留在主线程（§1.75 已经把它的 System 列表清干净了，
   现在挡路的是这个类自己）；`GameTransport` + `PlayerReconciler` + `PhysicsWorld` 一起进去；
4. `RenderTransformSyncSystem` 的 `submitTransforms` 留在主线程，先只把模拟搬走；
5. ~~帧时间打点~~ **已完成**：`src/platform/FrameTimeline.ts`，报表每 10 秒打一次
   （`[frame]` 开头）。第 2 步的价值本来就是证据——证据拿到了，见上面三条结论。

---

## 第 3 步 · OffscreenCanvas + 渲染线程（进行中）

依赖 1、2。Render Worker 拿 `transferControlToOffscreen()` 的 canvas，通过第 1 步定好的
`RenderTransformBuffer` 读 transform；`RenderTransformSyncSystem` 在这一步删除。
到这里就是完整的 UE 线程模型，而渲染仍然可以是 Three.js。

**§2 的实测把这一步的优先级抬上来了**：主线程的时间几乎全在渲染侧
（`draw` + `chunk-geometry` + `render-spawn` + `render-visuals`），而这些**只有到这一步
才挪得走**。

### 可行性已经验证过了

先做了一个最小尖刀（scratch，不入库）：`transferControlToOffscreen()` 出来的画布交给
worker，在 worker 里取 WebGL 上下文并清屏。结果：

```text
offscreenSupported: true
WebGL 2.0 (OpenGL ES 3.0 Chromium)
crossOriginIsolated: true
```

跑在与线上同一组隔离头（COOP/COEP/CORP）下，用的也是验证时一直用的
headless Chromium + SwiftShader。**所以这一步在这个仓库、这套验证环境里是能做完、
也能验证的**——这是开工前该先花二十分钟买到的确定性。

### 要搬的东西有多少

`src/` 下有 **79 个文件** import `three`。渲染世界搬进线程意味着它们全部跟着走：
模型、chunk 几何、草地、天气、昼夜、海面、合批、`ThreeRenderScene`、相机、
`WebGLRenderer`。Three 的对象过不了线程边界，所以**没有「只搬渲染器不搬场景图」
这个中间态**。

好消息是前面几步已经把大部分脏活做完了。整条渲染栈里只剩 **三处**碰 DOM：

| 位置 | 用途 | 怎么办 |
| --- | --- | --- |
| `createInteractionMarkerVisual.ts` | `document.createElement('canvas')` 画标签贴图 | 换 `OffscreenCanvas` |
| `createTemperatureMarkerVisual.ts` | 同上 | 换 `OffscreenCanvas` |
| `MouseGrassInteractor.ts` | `getBoundingClientRect` | 它是**输入**适配器，本来就该留在主线程 |
| `loadChunkGenerator.ts` | `window.location.search` 读 `?chunkgen=js` | 调试开关，加个 guard |

### 真正要做选择的只有一处

`pickActorInteraction`：`ClientActorSystem` 内部拿 `THREE.Raycaster` 打 proxy 的
场景图，返回「准星指着哪个可交互 Actor」。渲染世界进线程之后它就地做不了，
而调用方（交互控制器）是**同步的玩法逻辑**。两条路：

1. 渲染线程每帧回送一个「准星命中了谁」（多一帧延迟，但准星本来就跟着相机走）；
2. 玩法侧用碰撞体重做一次解析求交（不依赖渲染，但和肉眼看到的轮廓会有出入）。

这个还没定。**除它之外，玩法侧问渲染世界的问题一个都没有了**——这正是第 1 / 1.5 /
1.75 步一路收窄边界的结果。

### 已经做了的：把玩法查询从 `SceneRenderer` 里拆出来 ✅

`SceneRenderer` 同时是四件事：渲染器、场景宿主、地形查询服务、Actor 查询服务。
四件里只有第一件该跟着 canvas 走——**玩法每帧都要问「脚下多高」「前面挡不挡镜头」，
那不能变成一次跨线程往返。**

新增 `src/scene/SceneWorld.ts` 收下后三件里属于玩法的部分：地形采样、物理查询、
Actor 查询、草地脉冲入口。`SceneRenderer` 只剩渲染核心、表现开关，以及两个确实属于
渲染侧的查找（`getActorRenderProxy`、`setTerrainHighlight`）。

**这一半几乎不碰 Three**：地形是纯数据、物理是 Rapier、Actor 查询走 Game World。
唯一的例外就是上面那个 `pickActorInteraction`。

场景组合目前仍由 `SceneRenderer` 装配，所以换场景时由它把玩法那一半交给
`SceneWorld`；canvas 真搬走的时候装配会跟着走，那条依赖会反过来——现在先把
**接口**拆干净，不动装配的归属。

### 已经做了的：合批内容的实例通道 ✅

`HighCountActorBatchSystem` 是**一个渲染系统直接扫 `ActorWorld`**：每帧
`world.query(TRANSFORM, ITEM_STACK)`，再逐个 Actor 掏 `ActorResidencyComponent`、
`CombustibleComponent`、`DropMotionComponent`。canvas 一旦进线程，这条就断了。

掉落堆过不了已有的两条通道：它们**没有单独的 proxy**——`createReplica` 见到
`itemStack` 就提前返回，整批由合批器一次实例化画掉，所以 `ProxyId` + transform SoA
对它们不适用。这是路线图 §4.5 说的第四种形状（`PropInstances`）：

新增 `src/render/RenderInstanceBuffer.ts`——**每帧重建的定长记录数组**，
离散字段（原型下标、驻留态、燃烧、单个还是一堆、实例号）走 `Int32Array`，
连续量（位置、朝向、数量、刚体半径）走 `Float32Array`。分两段而不是把整数塞进 f32，
是因为那种事早晚会在某个边界上咬人一次。

不做增量（「谁变了就发谁」）：掉落堆的数量随捡拾/掉落每帧都可能变，记账成本高于重铺；
定长也意味着上 worker 之后这两段可以直接是 `SharedArrayBuffer` 视图。

写入方是 `src/actors/systems/ActorInstanceSystem.ts`，和 `ActorTransformSystem`
同一类东西：**只写字节，不 import three**。「哪些原型走合批」「数量为 1 时换单个模板」
是玩法事实，留在这一侧；那些下标怎么变成几何与材质是渲染侧的事。

渲染侧因此**不再认识 Actor，只认识实例号**。滚动姿态是从位移累积出来的，要能把
这一帧的实例认成上一帧那一个——Actor id 是字符串过不了字节边界，所以玩法侧发一个
`InstanceIdTable` 分配的槽位号，离开视野就还回去复用，和 `ProxyId` 一个套路。

**这一项不省帧时间**：`render-batches` p50 只有 0.06–0.17 ms。它是结构前提，
不是性能改动。

踩到的一个坑值得记：我按印象把驻留态写成了 `['active', 'dormant', 'despawning']`，
而 `ActorResidencyComponent.setState` 只认 `active` 与 `sleeping`——dormant 表示
Actor **已经离开 ActorWorld**，也就不会有实例记录。`residencyCode('sleeping')`
于是落回 0，休眠的堆被并进 active 批，合批的对象名对不上。已在
`tests/RenderInstanceBuffer.test.ts` 里钉住这一点。

### 还没做的

| | 说明 |
| --- | --- |
| 拆 `ClientActorSystem` | 它同时跑 Actor 世界（玩法）和持有渲染世界、悬停高亮；合批已经拆开，`GeneratedPropFruitSystem` 还在直接读 `ActorWorld` |
| 拆 `ChunkStreamer` | 流送规划（玩法）+ 几何（渲染）+ 碰撞体注册（物理）三合一 |
| 相机每帧过边界 | `CameraFrame` 在主线程按输入算出来，要送到渲染线程 |
| 两处 `document.createElement('canvas')` | 换 `OffscreenCanvas` |
| `pickActorInteraction` 的选择 | 见上 |

后两项是小活；前三项是这一步的主体，而且**和第 2 步是同一条缝**——
`ClientActorSystem` 与 `ChunkStreamer` 按 game / render 切开这件事，
两步都要它。所以先切缝，再决定哪个 worker 先上。

`SceneRenderer` 目前混着渲染核心（`WebGLRenderer` + camera）与一堆 Game World 查询
（`sampleGroundHeight` / `raycastGround` / `pickTerrainCell`）。搬 canvas 之前要先按这条线拆开：
查询留在 Sim 侧，渲染核心进 Render Worker。

---

## 第 4 步 · 换掉 Three.js（可无限期推迟）

依赖 1、3，且必须先有 §8.1 的烘焙格式——几何不脱离 `THREE.Mesh`，渲染器就换不掉
（`src/models/chunkTemplates.ts:114` 的 `createTemplateFromObject` 输入类型就是 `THREE.Object3D`，
遍历里读的是 `THREE.Mesh` / `THREE.LineSegments`）。

按 §4 特化之后要写的是 **2 个 shader + 6 个 pass**，不是通用 RHI。
路线图原话是「如果第 2 步做完帧时间已经够了，这一步的代价是零」；§2 的实测说明
**帧时间不会因为第 2 步变够**——真要动帧时间，得从渲染侧下手。
但这不改变结论：第 1 步定的那条边界本来就是自研渲染器需要的那条，换不换随时可决定。

---

## §8.1 · 烘焙产物格式（未开始，可并行）

**按解耦立项，不按性能。** chunk 模板只有 5 个，构建成本毫秒级；真正的理由是
「只要几何还是运行时用 Three 算出来的，第 4 步就换不掉 Three」。

写第一版之前必须定好的唯一结构决定（与 §4.3 是同一个决定）：**把 color 拆出去，并量化位置与法线。**
之后再改就要重烘全部产物。

```text
现在   stride 9   [ px py pz │ nx ny nz │ r g b ]        每套配色烘一份，36 B
建议   pos 3×i16  + nrm 2×i8 (oct) + u8 paletteIndex     几何全局烘一次，10 B
```

判断格式成不成功只有一条标准：**运行时能不能直接当 typed array 视图用。**
生成方式沿用已有的两个 bake 步骤（`build:abilities`、`build:wasm`），加一个 `build:assets`。
必须带 `contentHash`，不匹配就降级回运行时生成并告警——这同时给出一条平滑迁移路径。

---

## §8.2 · GPU 资源所有权表 ✅（最小核心）

修的是一个**真实缺陷**，不是预防性重构：`OUTLINE_MATERIAL` 是模块级单例、几乎每个物体的
轮廓线都指向它，而删掉任意一个 Actor 都会遍历它的子树把这份共享材质一起 dispose 掉。
每次拾取、每次物件消失都触发一次着色器重编译。

现在只是毛刺（Three 会在下次使用时重建 program 与 VBO）。自研渲染器自己管 GL 对象之后
**没有这层兜底**：同一段代码那时是 use-after-free。所以它必须排在第 4 步之前。

- `src/core/assets/AssetOwner.ts`：`acquire` / `get` / `release` + 引用计数。
  这一层**不知道资产是什么**（§8.4：CoreLayer 那一格），文件里没有一个 Three 类型。
- `src/render/renderAssets.ts`：进程级实例 + `releaseOwnResources()`。
  §8.4 把 GPU 资源划在渲染线程一侧，所以实例住在 `src/render/` 下。
- 四条遍历式释放路径（`SceneRenderer`、`ThreeMeshProxy`、`AbilityLabVisualSystem`、
  `PlayerActorVisual`）改为经由它避让共享资源。

**剩余工作**：这是「谁 acquire 谁 release；遍历场景树永远不 dispose」的过渡形态。
把 per-object 几何体也转成句柄之后，那四处遍历连同 `AssetOwner.owns()`、
`ThreeMeshProxy` 的 `PROXY_ROOT_MARKER` 剪枝一起删掉。届时 §8.3 的四件事
（异步加载去重 / LRU / 热重载 / 依赖图）仍然不做，触发条件见路线图。

---

## 不在本路线图内

- **CoreLayer 的 JS 运行时**：独立项目。
- **ToolLayer**：可并行、现在就能开。地基比预期好——`config/` 里 23 个 Actor 原型 + 6 张地图
  全是带 schema 的 JSON。设计取向：**编辑器编辑的是那些 JSON，不是运行时对象。**
- **DOM**：不做。游戏运行时不需要 DOM，编辑器留在真浏览器里。

---

## 待决事项（仍未拍板）

路线图 §11 的六项里，前三项在做完上面几步之前不必定；剩下三项已经有事实上的默认：

| 决定 | 当前默认 | 何时必须定 |
| --- | --- | --- |
| Web 还是 Native 是第一目标 | Web 后端先行 | 第 2 步之前——它决定 CoreLayer 的工作量能差一个数量级 |
| 第 2 步与第 3 步的先后 | 按 §2 的实测，第 3 步的收益更大 | 下一次动线程之前 |
| 物理引擎 | 保留 Rapier | 已由 §0.5b 的分析加固：两端同一份 `.wasm` 是 0.06 米容差的前提 |
| 线协议 | 先不动 JSON | 和 SAB 布局一起换，别分两次 |
