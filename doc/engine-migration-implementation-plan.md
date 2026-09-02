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
| 第 1.5 步 · 表现 Component 脱离 THREE | **进行中** · 棘轮 8 → 5 | 已搬火焰与草地压弯，剩 5 个，见 §1.5 |
| 第 2 步 · Sim Worker | 未开始 | 见 §2 |
| 第 3 步 · OffscreenCanvas | 未开始 | 见 §3 |
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
- **表现 System 仍然读 Actor 的 Component**（浮力、货物、弹性绳）。它们现在按 `proxyId` 向渲染世界
  取 Object3D，不再从 Actor 上直接摘。这条剩余耦合是第 1.5 步的内容。

---

## 第 1.5 步 · 表现 Component 脱离 THREE（未开始）

第 1 步只搬了 `ThreeObjectComponent`。**只要还有一个 Actor Component 握着 Object3D，
Sim Worker 就搬不过去**——对象过不了线程边界。所以这一步是第 2 步的硬前置。

规则：**Actor Component 不得 import 渲染侧模块**（`three` / `models` / `guidance` /
`slime` / `grass` / `materials`；`render/` 里的边界类型不算，那正是它该引的）。
`tests/RenderSceneBoundary.test.ts` 里有一份豁免清单当棘轮，**只能变短**；
清单空了，第 2 步的前置条件就满足了。

### 剩余清单（5 个，起点是 8）

| Component | 持有 | 跨边界要送的数据 |
| --- | --- | --- |
| `InteractionMarkerComponent` | 自绘标记 + 朝向相机的四元数 | 标签字符串、可见性、锚点高度 |
| `TemperatureMarkerComponent` | 同上 | 温度值、可见性、锚点 |
| `GuidePathVisualComponent` | `GuidePath` 整条线 | **变长**：路径点 + 两个 revision |
| `HybridSlimeVisualComponent` | 蒙皮 rig，`BufferAttribute` 直写 | 权威 yaw、移动速度 |
| `SlimeSurfaceDragComponent` | `Raycaster` + 一堆 `Vector3` | 拾取射线；本质是渲染侧的交互 |

已经划掉的三项：

- **`PbfSlimeVisualComponent`（删除）**——连同 `PbfSlimeVisualSystem` 整条 PBF 表现路径不可达：
  那个 System 从未出现在 `addSystem` 列表里，Component 也只被它自己引用。
  （`src/slime/pbf/PbfSlimeSimulation.ts` 因此没有引用者了；路线图写明「旧 PBF 求解器仍独立保留」，
  删不删是产品决定。）
- **`GrassDisplacementComponent`**——`THREE.Object3D` 换成 `WorldPositionSampler` 回调 + 普通数字。
- **`FireVisualComponent`**——缩成只剩一个目标强度，动画搬进 `ThreeFireVisual`。

### 定长参数通道（已落地）

火焰立起来的这段通道，剩下四项里的定长参数直接复用：

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

### 两条注意

1. **除了 Replica 这条路，还有本地玩家那条。** `src/player/PlayerEntity.ts` 与
   `RemotePlayer.ts` 也是 Actor，视觉走 `createPlayerActorVisual()`，**完全没有经过
   `ThreeRenderScene`**。这一步必须把它们也接到同一条边界上，否则 Sim Worker 里会留一半场景图。
2. **变长数据需要命令通道，不是 SoA 槽位。** 定长参数（强度、温度、yaw）可以加进
   `RenderTransformBuffer` 旁边的第二段 SoA；引导路径那种变长的要走
   `RenderCommandSink`——它现在只有 `destroyMeshProxy` 一个方法，就是为这件事留的口子。
   单线程下是直接调用，上 worker 之后是往环形缓冲写命令。

### 顺带修掉的两个真实缺陷

现状调查在两个装配枢纽里翻出来的，与搬迁本身无关但同属这条边界：

- `createReplica` 在 `createMeshProxy` 与 `addActor` 之间会抛（原型声明了 `temperature`
  却没装上 Component 时），抛出后槽位既不在 `freeSlots` 里也没有 Actor 持有它——泄漏一个
  挂在场景图上的模型。已包进 `try/finally`。
- `ClientActorSystem.dispose` 不调用 `renderScene.dispose()`，渲染资源的释放完全依赖
  「每个 proxy 都恰好有一个活着的 Actor 持有它」这条不变量，而上面那条路径正好破坏它。

### 还没解决的两条

- **`HybridSlimeVisualSystem` 有一条 Render→Game 的反向依赖**：`authorityYaw` 取自
  `render.root.rotation.y`——也就是 SoA 刚兑现出去的 yaw 又被读回来。上 worker 之后读不到。
  正确的源是 `TransformComponent.yaw`（父子情况下还要减去父 yaw）。搬这一项时必须一起修。
- **本地玩家那条路径仍然绕开边界**。`src/player/objectPositionSampler.ts` 是过渡形态：
  它把 Object3D 挡在了 Actor Component 之外，但闭包本身仍捕获渲染世界的对象——
  **棘轮变短不等于真的能进 Sim Worker**。真正过边界要等 `PlayerEntity` / `RemotePlayer`
  也走 `createMeshProxy`。

建议继续按 Component 逐个搬，每搬一个从棘轮清单里划掉一个，保持每次提交都是绿的。

---

## 第 2 步 · 网络 + Game World + 物理整体进 worker（未开始）

依赖 0、1、1.5。

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
- **`native/chunkgen` 单独一个 worker**。`ChunkStreamer.drainBuildBudget()` 的「每帧最多建一个
  chunk」本身就是「生成在主线程会卡帧」的补丁，挪走后可以并行建、放开视距。
- 做完可以删掉 `MAXIMUM_SIMULATION_CATCH_UP_STEPS = 5`——那个常量只是「模拟被绑在渲染帧上」的补丁。

改动清单（预估）：

1. `src/platform/` 加 worker 生成与消息通道（PlatformLayer 的第二块）；
2. 输入按 tick 号序列化进一个 SAB 环形缓冲（主线程退化成 IO 线程）；
3. `ClientActorSystem` + `GameTransport` + `PlayerReconciler` + `PhysicsWorld` 搬进 Sim Worker；
4. `RenderTransformSyncSystem` 的 `submitTransforms` 留在主线程，先只把模拟搬走；
5. 帧时间打点：这一步的价值是**证据**——在写第一行 C++ 之前，先证明 worker 架构在这个项目里跑得通。

---

## 第 3 步 · OffscreenCanvas + 渲染线程（未开始）

依赖 1、2。Render Worker 拿 `transferControlToOffscreen()` 的 canvas，通过第 1 步定好的
`RenderTransformBuffer` 读 transform；`RenderTransformSyncSystem` 在这一步删除。
到这里就是完整的 UE 线程模型，而渲染仍然可以是 Three.js。

`SceneRenderer` 目前混着渲染核心（`WebGLRenderer` + camera）与一堆 Game World 查询
（`sampleGroundHeight` / `raycastGround` / `pickTerrainCell`）。搬 canvas 之前要先按这条线拆开：
查询留在 Sim 侧，渲染核心进 Render Worker。

---

## 第 4 步 · 换掉 Three.js（可无限期推迟）

依赖 1、3，且必须先有 §8.1 的烘焙格式——几何不脱离 `THREE.Mesh`，渲染器就换不掉
（`src/models/chunkTemplates.ts:114` 的 `createTemplateFromObject` 输入类型就是 `THREE.Object3D`，
遍历里读的是 `THREE.Mesh` / `THREE.LineSegments`）。

按 §4 特化之后要写的是 **2 个 shader + 6 个 pass**，不是通用 RHI。
如果第 2 步做完帧时间已经够了，这一步的代价是零——第 1 步定的那条边界本来就是自研渲染器需要的那条。

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
| 物理引擎 | 保留 Rapier | 已由 §0.5b 的分析加固：两端同一份 `.wasm` 是 0.06 米容差的前提 |
| 线协议 | 先不动 JSON | 和 SAB 布局一起换，别分两次 |
