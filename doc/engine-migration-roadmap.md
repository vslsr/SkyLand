# 引擎自研迁移路线图

> 分支：`claude/project-rendering-pipeline-ubjzq9`
> 目标：**特化**「块状地形大世界 + 线稿风格美术」这一种玩法，而不是做通用引擎
> 文档定位：从 Three.js 走到自研引擎的分步方案。供团队讨论，也供后续 session 作为共享上下文
> 可视化版本（同内容，带图）：<https://claude.ai/code/artifact/2d3b0fd9-70b9-4d5c-ae60-5c160dbc10c6>

核心主张：**起点不是渲染器，是 Game World 与 Render World 之间那条边界**。它现在就能定，定完之后每一步都可增量、可暂停，而且无论最终是否写 C++ 渲染器，这条边界都是同一条。

---

## 四条结论

| | 结论 | 要点 |
| --- | --- | --- |
| 前提修正 | **浏览器有真多线程** | Worker 是真 OS 线程，Emscripten pthreads 让 C++ 的 `std::thread` 直接可用。缺的只是跨源隔离响应头——本仓库目前**未配置**，半天就能补上。 |
| 起点 | **先剥边界，不动渲染器** | 把 `THREE.Object3D` 从 Actor 上摘掉、换成 `proxyId` + SoA 数据。这一步**不改一个像素**，却是「以后能不能上 worker」的唯一决定性因素。 |
| 范围收缩 | **物理不进 C++ 核心** | Rapier 已是 Rust/WASM 且客户端与服务端**共用同一份二进制**。C++ 只做渲染器，项目量级从 18 个月掉回几个月。 |
| 范围收缩 | **CoreLayer 里砍掉 DOM** | 为了跑自己写的 UI 而实现一个浏览器，方向是反的。游戏运行时不需要 DOM，编辑器可以留在真浏览器里。 |

---

## 1. 浏览器的三条真约束

「浏览器不支持多线程」这个前提需要修正。`Web Worker` 是真线程，`SharedArrayBuffer` + `Atomics` 提供共享内存与无锁同步；对 C++ 核心更直接——Emscripten 的 pthreads 就是真的 pthreads，底下映射到 Worker + SAB。选 C++ 这件事，恰好把这个顾虑消掉了大半。

前置条件只有一个：**跨源隔离**（`crossOriginIsolated === true`），需要服务端发 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`。本仓库的 `server/http/` 与 `vite.config.ts` 里都搜不到，所以 SAB 目前是禁用状态。

真正的约束只有三条，和 UE 面对的几乎一样：

| 真正的约束 | 对架构的后果 |
| --- | --- |
| 一个 GPU context 只能被一个线程拥有 | 必须有独立渲染线程。这本来就是目标架构，不是障碍——Emscripten 的 `OFFSCREENCANVAS_SUPPORT` 让 GL context 归一个 pthread 所有。 |
| DOM 与输入事件只在主线程 | 输入要序列化后投递，并且必须带 tick 号，否则预测的输入序列和服务端对不齐。主线程退化成 IO 线程。 |
| **对象不能跨线程，只有 SAB 里的字节能** | **这条才是逼着改架构的那条。**Game World 与 Render World 之间不能共享指针。 |

---

## 2. 边界的性质决定一切

初步设计的分层（Game World / Render World / Physics World）是对的，但 UE 里 `Component → Primitive` 那条箭头**不是引用**：中间隔着 `FPrimitiveSceneProxy`（渲染线程独占的镜像）、命令队列和双缓冲，游戏线程与渲染线程差一帧。

如果箭头落地成直接引用，就是现在的做法——`ThreeObjectComponent` 直接持有 `THREE.Group`，`ActorTransformSystem` 直接写 `render.root.position.set(…)`（`src/actors/systems/ActorTransformSystem.ts:38`）。单线程能跑，一上 worker 全废。

```text
现在（跨不过线程边界）                第 1 步之后（可以跨）

  Actor                               Actor
   └ ThreeObjectComponent              └ RenderProxyComponent
        持有 THREE.Group                    只持有 proxyId: u32
             │                                    │ 写 SoA
             │ position.set()                     ▼
═════════════╪════ 线程边界 ═════      ┌──────────────────────────┐
             ✕  对象过不去             │ SharedArrayBuffer · 双缓冲 │ ← 边界在这里
             │                        └──────────────────────────┘
             ▼                                    │ 读
        THREE.Object3D                            ▼
      （与上面同一个对象）                  RenderScene (FScene)
                                         PrimitiveProxy · 无 Actor 指针
```

同一条线程边界，两种穿越方式。左边那条引用无论怎么优化都过不去——对象不能跨线程。右边的 SAB 双缓冲坐在边界上，两侧各自读写自己那一份字节。

**硬约束：Render World 里不允许出现指向 Actor 的指针，只能有 id 和自己的数据副本。** 这条现在（单线程、还用着 Three.js）就能靠代码强制。

第 1 步落地成一个接口，现有 Three 代码原样搬进它的第一个实现：

```ts
interface RenderScene {
  createProxy(desc: PrimitiveDesc): ProxyId;
  destroyProxy(id: ProxyId): void;
  submitTransforms(soa: Float32Array): void;   // 不是 Object3D
  submitView(view: ViewUniforms): void;
  render(): void;
}

class ThreeRenderScene implements RenderScene { /* 现有代码搬进来 */ }
```

注意这里的 `PrimitiveDesc` **不是一个通用的可变长 primitive 表**——它在 §4「特化方向」里被收窄成固定的四类，SAB 布局因此是定长数组而不是逐对象分配。

做完这一步，Three.js 被关进一个盒子里，帧率不变、画面不变。而**这个盒子的接口，和以后 C++ 渲染器的接口是同一个**——这是整个迁移里回报最高的一步。

---

## 3. 线程布局

网络层不该独占一个线程。理由是那条紧耦合链：*快照到达 → 和解 → 回放未确认固定步*。10 Hz 快照配 60 Hz 模拟，稳态每次回放约 6 个固定步，抖动时更多（上限 `MAXIMUM_PENDING_INPUT_STEPS = 120`）。这是个突发尖峰；把网络和模拟拆到两个线程只会凭空多一跳、还强制异步化。`WebSocket` 在 Worker 里可用，整个搬进去即可。

```text
                        ┌──────────────────────────────┐
                        │    房间进程 · Node fork       │
                        │  20Hz tick · 10Hz 快照 · 权威 │
                        └──────────────┬───────────────┘
                                       │ WebSocket（在 worker 内）
                                       ▼
 ┌──────────────┐ 输入 SAB 环 ┌────────────────────────┐ transform SoA ┌─────────────────┐
 │    主线程     │ ─────────→ │      Sim Worker         │ ───────────→ │  Render Worker   │
 │ DOM / UI     │            │ GameTransport / 协议     │              │ FScene / Proxy   │
 │ 输入采集+tick │            │ UWorld·Actor·Component  │              │ OffscreenCanvas  │
 │ canvas 移交   │            │ 预测 + PlayerReconciler │              │ GL / WebGPU 命令  │
 │ 无模拟·无渲染 │            │ 角色控制器查询            │              │ 显示器刷新率·插值 │
 └──────────────┘            │ 60Hz 固定步 · 与 rAF 解耦 │              └─────────────────┘
                             └──────┬──────────▲───────┘
                 角色查询 · 同步      │          │  刚体推进 · 可异步
                                    ▼          │
                             ┌────────────────────────┐
                             │ PhysicsWorld·Rust/Rapier│
                             │   与服务端同一份 .wasm   │
                             └────────────────────────┘
```

角色控制器必须与输入处理同步——它在预测的关键路径上，不能差一帧；刚体推进（船、掉落物、蘑菇）才可以异步。

附带收益：模拟一旦脱离渲染帧，`MAXIMUM_SIMULATION_CATCH_UP_STEPS = 5` 这个「切后台标签会积压」的补丁可以删掉，而渲染线程能在两帧模拟之间插值——**144Hz 屏幕上跑出 144Hz 画面，模拟仍是 60Hz 固定步**。

---

## 4. 特化方向与不做清单

引擎的目标不是通用，是特化这一种玩法。这一条比任何技术选型都更能约束范围：**块状地形和线稿风格都是封闭的小枚举，通用引擎不敢做的假设这里都能做。**

特化的实质首先是**敢砍**。下面这份清单里的能力，在当前仓库里全部核实为零——把它写成「不做」的承诺，比写「要做什么」更能防止范围蔓延。

| 通用引擎必备 | 这个项目 |
| --- | --- |
| 阴影贴图 | `castShadow` / `shadowMap` = 0 |
| PBR / IBL / 反射探针 | `MeshStandardMaterial` = 0，光照是手写 GLSL |
| 骨骼动画 / Morph target | `SkinnedMesh` / `AnimationMixer` = 0（史莱姆是程序化形变） |
| 纹理系统 / mipmap / 各向异性 | `TextureLoader` = 0，全程序化 |
| 资源导入（glTF / FBX） | 零资产加载 |
| 一般化材质系统 | 实际只有两种：fill shader + line shader |
| 一般化 LOD | 线稿远景不该简化，雾已经遮住了 |
| 视锥剔除 / BVH / 八叉树 | chunk 网格 + 半径测试就是精确解，见 §4.4 |

### 4.1 地形：13 种形状 × 2 种表面的封闭枚举

`TERRAIN_SHAPE` 只有 13 项（`FLAT` / `RAMP`×4 / `CORNER_HIGH`×4 / `CORNER_LOW`×4），`TERRAIN_SURFACE` 只有 2 项，高度层打包进同一个 code 的高字节（`shared/world/terrainConfig.mjs:34`）。**地形几何是一个整数的纯函数。**

而现在是 `createTerrainChunkGeometry`——**475 行 CPU 代码**，每 chunk 遍历 `TERRAIN_GRID² = 256` 格，往普通 `number[]` 里 push。

```text
现在                                    cell code 纹理

  cell code × 256                        cell code × 256
        │ createTerrainChunkGeometry           │ texSubImage2D
        │ 475 行 CPU，逐格 push                 │ 无 CPU 几何
        ▼                                      ▼
  顶点缓冲（每 chunk 一份）               16×16 R16UI 纹理 · 512 B
        │ 上传                                 │ 顶点着色器展开
        ▼                                      │ 13 项形状常量表
  50–100 draw / 25 chunk                       ▼
                                         1–2 draw / 全部 chunk
  编辑 1 格 → dispose + 重建 256 格
                                         编辑 1 格 → 1 个 texel
```

25 个常驻 chunk 的全部地形数据是 **12.8 KB 纹理**（6,400 格 × 2 字节）。

最值钱的是最后一行：**地形编辑是已上线的玩法**，而现在改一格要 `rebuildTerrain()` dispose 后重建整个 chunk（`src/world/ChunkView.ts:76`）。

附带白拿一项：**地形的轮廓线也能从 code 推导**——平面与斜坡的交界是枚举里已知的，不需要跑 `EdgesGeometry` 做拓扑边提取。

### 4.2 物件：只有 4 种，可以跨 chunk 全世界实例化

`PROP_KIND_COUNT = 4`（tree / grass / rock / mushroom），`PROP_GRID = 8` → 每 chunk 最多 64 个。现在是**按 chunk 合批**：25 个常驻 chunk × 4–8 draw ≈ 150 次绘制。

封闭的物件集允许更进一步——**按种类合批、跨 chunk**：4 种 × 2（fill + outline）= **8 次绘制覆盖整个可见世界**，chunk 装卸只是往实例缓冲里写或移除一段 range。加上水面、草与少量 Actor，整个世界约 **15–20 次绘制，且上界不随视距增长**。

通用引擎不能这么做，因为它不知道物件种类是封闭的。

### 4.3 线稿的调色板极小 → 顶点格式压到三分之一

整个游戏用到的颜色不超过几十种，轮廓线更是一个常量（`0x171614`）。2 米格、32 米 chunk，位置用 chunk 局部 `i16` 量化到毫米绰绰有余。

```text
现在   pos 3×f32(12) + normal 3×f32(12) + tint 3×f32(12)      = 36 字节/顶点
特化   pos 3×i16 量化(6) + normal oct 2×i8(2) + palette u8(1)  = 10 字节/顶点

按实测 4,700 顶点/chunk × 25 chunk：  4.2 MB → 1.2 MB，带宽同比例下降
```

这与 §8 ResourceLayer 的烘焙格式是同一个决定，两处必须一起定。

### 4.4 有界视距白送的两个「不需要」

相机 `far = 100`，`loadRadius = 2` → 最近的未加载内容至少在 64 米外，常驻集是 5×5 = 25 个 chunk。

- **不需要通用视锥剔除**：chunk 网格 + 半径测试就是精确解，而且是 O(1)。BVH、八叉树、portal 一个都不用写。
- **不需要 LOD**：整个常驻集在 100 米内，且线稿风格远处本来就不该简化。

### 4.5 特化后的 Render World 数据模型

这一条**收窄了 §2 里 `PrimitiveDesc` 的默认假设**：通用的可变长 `PrimitiveProxy` 列表，对这个游戏是错的抽象。特化的 Render World 是固定的四类：

```text
RenderWorld
├ TerrainField       每 chunk 一张 code 纹理 + 高度层偏移      1–2 draw
├ PropInstances[4]   tree / grass / rock / mushroom 实例数组   8 draw
├ WaterField         水面格实例（复用同一张 code 纹理）        2 draw
└ Meshes[]           玩家、Actor、交互标记等一次性网格          少量
```

这让第 1 步的 SAB 布局简单得多——**全是固定长度的数组，没有逐对象的 proxy 分配**，跨线程传的就是几段 `Float32Array` / `Uint16Array` 视图。比通用 proxy 表更快，也更好写。

### 4.6 诚实的一条：Three.js 不是这些优化的瓶颈

上面三项**几乎全部可以在换掉 Three.js 之前拿到**——`InstancedBufferGeometry`（草已经在用）、`DataTexture`、带 `normalized` 的 `Int16Array` 属性、自定义 `ShaderMaterial`，Three 都支持；降到 15–20 次绘制之后，它每次绘制的状态校验开销可以忽略。

真正的瓶颈在自己的代码里：**475 行的 CPU 地形生成**和 **36 字节的顶点格式**。

所以特化不改变路线图顺序，但改变两件事：**第 4 步的收益从「性能」变成「控制权」**（渲染线程归属、WebGPU compute、不背通用引擎的重量），以及**第 4 步要写的东西小很多**——不是通用 RHI，是 2 个 shader + 6 个 pass。

---

## 5. 物理层：不要动它

`shared/physics/PhysicsWorld.mjs` 这一个文件，浏览器和房间进程**都在跑**（`src/scene/createLineArtScene.ts:32` 与 `server/scene/ServerScene.mjs:137`）。玩家移动走 Rapier 的 `computeColliderMovement`（`PhysicsWorld.mjs:290`），客户端预测和服务端权威调的是同一个函数。

和解容差 `RECONCILE_TOLERANCE = 0.06` 米——这 6 厘米是靠「两端是同一份 WASM 二进制」撑住的。WASM 的浮点是严格 IEEE-754：没有 x87 80 位中间精度、没有 FMA 收缩、没有编译器重排，**同一个 `.wasm` 在任何机器上逐位一致**。这比「C++ 分别为客户端和服务端编译两次」强得多。

```text
 ┌────────────────────────┐   输入 + tick 号   ┌────────────────────────┐
 │  浏览器 · Sim Worker    │ ───────────────→ │  房间进程 · Node fork   │
 │  预测 60Hz 固定步        │ ←─────────────── │  权威 20Hz tick         │
 │  rewindAndReplay 未确认步│  快照 10Hz         │  ServerScene.mjs:137   │
 └──────────┬─────────────┘  容差 0.06m        └────────────┬───────────┘
            └───────────────┐         ┌────────────────────┘
                            ▼         ▼
                 ┌─────────────────────────────────┐
                 │      同一份 Rapier .wasm         │
                 │ shared/physics/PhysicsWorld.mjs │
                 └─────────────────────────────────┘

 换掉任一端 → 6cm 容差击穿 → RECONCILE_SNAP_DISTANCE 2.5m 频繁触发
```

**建议：把物理明确划给 Rust 一侧，保留 Rapier。** 真正需要 C++ 的是渲染器（GL/WebGPU 状态机、命令缓冲、job system），物理不在这个列表里。换 Jolt 能买到多线程 island 求解和为回滚设计的 `SaveState`，但代价是赔上「客户端服务端同一份模拟」这个最大的资产。

这个决定顺带把范围收缩了：**C++ 核心可以只做渲染器，不必上服务端**——因为需要双端一致的那部分（物理 + gameplay）根本没进 C++。它也让 Rust 与 C++ 不必链进同一个 WASM 模块（那件事很痛），两者本来就是两个模块，只交换数据。

### 三个已知的坑

- **惰性 step 有语义。** `PhysicsWorld.step()` 是查询驱动的（`prepareQueries()`），代码里留着一句 `do not remove this apparently empty tick`（`PhysicsWorld.mjs:323`）。这种「空 step 其实有意义」的地方最容易在迁移时出事，先补测试钉住。
- **两套碰撞并存。** `shared/collision/` 那张均匀网格还在服务非玩家 Actor 的推出与交互宽相。自研之前先合并成一套，否则会把技术债原样搬进新引擎。
- **SAB 上的堆会失效。** Emscripten 开 pthreads 后 WASM heap 是 SharedArrayBuffer，堆增长会让 JS 侧所有 `Float32Array` 视图失效。必须封装成「每次访问重新取视图」，否则是只在内存增长时复现的随机 bug——这条约定要写进第 1 步的接口。

---

## 6. 网络层：现状比预期的好

`src/network/transport/GameTransport.ts:3` 已经按 `'reliable-ordered' | 'unreliable-sequenced'` 双通道抽象好了——这是照着 WebTransport / UDP 画的接口，`WebSocketTransport` 只是当前的一个实现。这一层直接能用。

线协议现在是 `JSON.stringify` / `JSON.parse`。直觉上该换二进制，但建议**先测再换**：10 Hz 快照加上已有的 AOI／dormant 机制已经把 Actor 数量限住了，JSON 未必是瓶颈。真要换的时候，让它和 SAB 决策绑在一起——快照直接解码进 SAB 上的 SoA 布局，模拟 worker 写、渲染 worker 读，零拷贝。**二进制协议和多线程是同一次改动的两个面**，分开做等于做两遍。

| 同步节奏（现状） | 值 | 迁移后的变化 |
| --- | --- | --- |
| 服务端 tick | 20 Hz | 不变 |
| 快照广播 | 10 Hz | 不变；解码目标改为 SAB 上的 SoA |
| 预测固定步 | 1/60 s | 不变，但脱离 rAF，由 Sim Worker 自己驱动 |
| 远端插值回退 | 120 ms | 插值移到渲染线程，按显示器刷新率求值 |
| 单帧补跑上限 | 5 步 | **可删除**——这个常量只是「模拟被绑在渲染帧上」的补丁 |
| 和解容差 / 瞬移 | 0.06 / 2.5 m | 不变——前提是物理不换（见 §5） |

---

## 7. 分层架构

初步分层是 ToolLayer / FunctionLayer / ResourceLayer / CoreLayer / PlatformLayer。骨架成立，下面是四处修改。

**最主要的意见：竖着的层表达不了线程模型**，而线程恰好是这个项目最难的部分。UE 也是两个轴——层是竖切的（Core / Engine / Game），线程边界是横切的（Game / Render / RHI thread）。具体后果是：§2 那条 `RenderProxy` + SAB 双缓冲，**它是 SceneLayer 内部的一条线，不是层与层之间的边界**。按层边界去实现它，会得到一个错误的抽象——Render World 被下沉进 CoreLayer，然后它就需要知道 Actor 是什么。

```text
层 ↓ / 线程 →     主线程             Sim Worker            Render Worker
──────────────────────────────────────────────────────────────────────────
ToolLayer       编辑器·DOM/Web    ·                  ┊  ·
──────────────────────────────────────────────────────────────────────────
SceneLayer ★    ·                 Game World·Physics ┃  Render World
                                                     ┃  ← RenderProxy · SAB
──────────────────────────────────────────────────────────────────────────
FunctionLayer   ·                 网络复制·Ability    ┊  动画·粒子表现
──────────────────────────────────────────────────────────────────────────
ResourceLayer   ·                 加载·流送          ┊  GPU 上传
──────────────────────────────────────────────────────────────────────────
CoreLayer       事件·输入          容器·数学·Job      ┊  RHI·命令缓冲
──────────────────────────────────────────────────────────────────────────
PlatformLayer   ├───── 线程 · 图形 · 音频 · 文件 · 网络 · 时钟 ─────┤
──────────────────────────────────────────────────────────────────────────

  ───   层边界 · 依赖方向 · 可以是接口调用
  ┊     线程边界 · 执行边界 · 只能是数据
  ┃     RenderProxy：SceneLayer 内部的线程边界，不是层边界
```

**跨线程的东西一律是数据，跨层的东西才可以是接口。**

新增的 **SceneLayer** 是原方案里缺的那一层——Game World / Render World / Physics World 在原来的五层里没有家，塞进 FunctionLayer 会很快失控。**PlatformLayer 是一条连续基带**：它在每个线程上都存在，提供同一套 API。

### 四处修改

| 修改 | 原方案 | 之后 |
| --- | --- | --- |
| 新增 SceneLayer | UWorld / FScene / PhysicsWorld 无归属 | 插在 Function 与 Tool 之间。三个 World 有了家，`RenderProxy` 边界明确为它的内部实现。 |
| Web 降级为后端 | Web 是特殊情况，靠「特化浏览器核心」抹平 | Web 只是 PlatformLayer 的一个后端。**CoreLayer 不需要「是一个浏览器」，只需要能移植到 PlatformLayer 之上。** |
| CoreLayer 砍掉 DOM | 自研 DOM + WebGL + WebAudio | 拆成三块分别决策：JS/TS 运行时（价值最高）、图形 RHI、音频。DOM 砍掉或外包给 CEF / Ultralight / Servo。 |
| ResourceLayer 按现状定形 | 图片 / 模型 / 骨骼模型 | 现状是**零资产加载**。先定形为程序化模板 + WASM 模块 + 场景/Actor JSON 三类；骨骼与贴图留接口不实现。 |

### 为什么 DOM 该砍掉

`src/ui/` 12 个文件里 8 个用 `document.createElement`，UI 完全是 DOM + CSS。所以「要 DOM」的直觉有来源，但要区分两种理由：

- **因为 UI 是用 HTML/CSS 写的** → 为了跑自己控制的 UI 而去实现一个浏览器，方向反了。
- **因为要 web 部署** → 那本来就有真浏览器，不需要自己写。

DOM + CSS 布局 + 层叠 + 文本排版是三个巨型子系统，做出来只是为了渲染自己写的几个面板。两条更划算的路：**游戏运行时根本不要 DOM**（HUD 用自己的渲染器画——项目里已有 `IconSprite`、3D 交互标记、温度标记这些自绘先例），**编辑器留在真浏览器里**（作为 web app 通过 socket 连运行时，顺带让编辑器和运行时的迭代解耦）。

### PlatformLayer 的后端映射

| 能力 | Web 后端 | Native 后端 |
| --- | --- | --- |
| 线程 | `Worker + SharedArrayBuffer` | `std::thread` |
| 图形 | `WebGL2 / WebGPU` | `GL / Vulkan / Metal` |
| 音频 | `WebAudio` | `WASAPI / CoreAudio / OpenSL` |
| 文件 | `fetch / OPFS` | `mmap / fopen` |
| 网络 | `WebSocket / WebTransport` | `TCP / UDP` |
| 时钟 | `performance.now` | `QPC / mach_absolute_time` |

实践建议：**Web 后端先行**。它的约束最紧（见 §1），而 native 是放松约束、不是新增约束。反过来先做 native 再适配 Web，一定会漏。

### ToolLayer 的地基比预期好

`config/` 里 23 个 Actor 原型 + 6 张地图**全是 JSON，并且都带 `.schema.json`**，加上已有的 `TerrainEditorPanel` 与 `DebugMenuPage`，编辑器地基是现成的。

关键设计取向：**编辑器编辑的是那些 JSON，不是运行时对象。** 这样编辑器与运行时之间只有一份 schema 契约，不需要反射系统，也不需要运行时暴露内部结构——对小团队是巨大的省力。

落地形态（H5 编辑器怎么和 C++ 运行时接、为什么不内嵌 webview、编辑器如何复用现有的客户端协议）单独写在 **`tool-layer-implementation.md`**。

---

## 8. ResourceLayer 与资源生命周期

这一层有两个独立的问题，容易被混成一个「资产系统」去立项。分开看，结论差别很大：**格式的理由是解耦（而不是性能），所有权的理由是现在就有一个真实缺陷。** 两者都必须在第 4 步之前完成，且都不阻塞第 0 / 1 / 2 步。

### 8.1 要设计的是烘焙产物格式，不是导入格式

仓库里**零资产可导入**，所以「图片 / 模型 / 骨骼的导入管线」是在为不存在的内容建设施。但有一个真实的、资产形状的问题：**每次加载场景、每次 spawn Actor，都在运行时重算一遍完全确定性的几何体。**

| 耦合点 | 后果 |
| --- | --- |
| 几何定义绑在 Three.js 上<br>`src/models/chunkTemplates.ts:114` | `createTemplateFromObject` 的输入类型就是 `THREE.Mesh` / `THREE.LineSegments`。**只要几何还是「运行时用 Three 算出来的」，第 4 步就换不掉 Three。** 这是这件事最主要的理由。 |
| 每个 Actor spawn 重算<br>`src/actors/ClientActorSystem.ts:742` | `createActorVisualModel(...)` 逐 Actor 调用，每次新建几何并跑一次 `EdgesGeometry`（拓扑边提取）。只有物品堆走了 `HighCountActorBatchSystem` 的共享批次。 |
| 配色被烘进顶点流<br>`TEMPLATE_FILL_STRIDE = 9` | 颜色逐顶点写死，模板**无法跨配色复用**——同一棵树在 `grassland` 与 `open-world` 得各烘一遍。 |

**格式设计里唯一真正的结构决定：把 color 拆出去，并量化位置与法线。** 这一条要在写第一版之前定好，之后再改就要重烘全部产物（与 §4.3 是同一个决定）。

```text
现在   stride 9   [ px py pz │ nx ny nz │ r  g  b ]     每套配色烘一份，36 B

建议   pos 3×i16  [ px py pz ]   chunk 局部量化到毫米      几何全局烘一次
       nrm 2×i8   [ oct 编码 ]                            线稿不需要高精度法线
       u8         [ paletteIndex ]                        配色 = 上传时查表
                                                          合计 10 B/顶点
```

容器本身不要 glTF、不要 FBX、不要自定义 IFF。**判断格式成不成功只有一条标准：运行时能不能直接当 typed array 视图用。**

```text
header   { magic, version, contentHash, templateCount }
index[]  { kind, fillOffset, fillCount, lineOffset, lineCount }
blob       交错顶点块（position+normal 一段，paletteIndex 另一段）

运行时     fetch → new Float32Array(buffer, fillOffset, fillCount)
           零解析 · 零拷贝 · 零对象分配
```

生成方式沿用项目已有的两个 bake 步骤——`build:abilities`（esbuild 产 `.mjs`）和 `build:wasm`（cargo 产 `.wasm`，**产物签入仓库**）。加一个 `build:assets`，不引入新的工具链概念。

**必须带 `contentHash`——这是现在就缺的防线。** `chunkgen.wasm` 现在签入仓库、改了 Rust 才手动 rebuild，忘了 rebuild 没有任何防线。烘焙几何会把这个问题放大：改了 `tree.ts` 忘了重烘，画面静默用旧模型。运行时校验哈希，不匹配就**降级回运行时生成并告警**——这同时给出一条平滑迁移路径，烘焙产物可以从「可选加速」开始。

**什么时候不该做：** 如果只图性能，现在不值当——chunk 模板只有 5 个（tree / grass / rock / mushroom / ground），构建成本是毫秒级。Actor 那条成本更真实，但也该先在 `createChunkTemplates` 与 `createActorVisualModel` 前后打点拿到数字。**按性能立项会发现收益不够；按解耦立项它是第 4 步的必要前置。**

### 8.2 所有权表：现在已经有三套规则，互相不一致

全仓 `.dispose()` 出现 **143 次，散在 56 个文件**。释放逻辑被写成了三套各自为政的手写约定，其中第三套和前两套的哲学直接冲突：

| 位置 | 规则 |
| --- | --- |
| `ChunkView.dispose()` | 注释写明「材质与网格线几何体由 ChunkStreamer 按场景持有，**卸载单个 chunk 时不能动它们**」 |
| `ThreeObjectComponent` → `disposeObject` | 用 `ACTOR_ROOT_MARKER` 剪枝，避免释放到别的 Actor 的资源上 |
| `SceneRenderer` → `disposeScene` | **遍历整棵场景树，无差别 dispose 每一个 geometry 和 material** |

```text
现在                                   所有权表之后

disposeScene  ChunkView  disposeObject   disposeScene ChunkView disposeObject
 无差别遍历     注释避让    marker 剪枝     release()   release()   release()
     │            │            │              └──────────┼──────────┘
     └────────────┼────────────┘                         ▼
                  ▼                          ┌────────────────────────┐
    ┌────────────────────────┐               │       AssetOwner       │
    │    OUTLINE_MATERIAL    │               │ refcount 3 → 2 → 1 → 0 │
    │       模块级单例        │               └───────────┬────────────┘
    └────────────────────────┘                           ▼
                                              ┌────────────────────────┐
       换场景即被 dispose                      │    OUTLINE_MATERIAL    │
                                              │     归零才 destroy      │
                                              └────────────────────────┘
```

`OUTLINE_MATERIAL` 与 `GROUND_GRID_MATERIAL` 是模块级单例（`src/materials/lineMaterials.ts:3`），几乎每个物体的轮廓线都指向同一个实例；而 `replaceScene` 每次换地图都会遍历整棵场景树无差别 dispose，把这个进程级单例一起释放掉。

现在没炸，是因为 Three 会在下次使用时重建 program 与 VBO——所以它表现为**换场景后的一次着色器重编译毛刺**，不是崩溃。

**为什么它必须排在第 4 步之前：** 自研渲染器自己管 GL 对象之后，**没有「重建」这层兜底**——dispose 一个还被别人引用的资源，就是 use-after-free：要么黑屏，要么驱动崩。同一段代码，现在是毛刺，那时是崩溃。

最小核心就三个方法，配一条规则：**谁 acquire 谁 release；遍历场景树永远不 dispose。**

```ts
type AssetHandle<T> = number & { readonly __asset: unique symbol };

interface AssetOwner {
  /** 同 key 复用同一份资源，引用计数 +1 */
  acquire<T>(key: string, create: () => T, destroy: (value: T) => void): AssetHandle<T>;
  get<T>(handle: AssetHandle<T>): T;
  /** 引用计数归零才真正 destroy */
  release<T>(handle: AssetHandle<T>): void;
}
```

| 现在 | 改成 | 收益 |
| --- | --- | --- |
| `disposeScene` 遍历式 dispose | release 本场景 acquire 的句柄 | 单例缺陷消失 |
| `ChunkView.dispose` 小心避让共享材质 | 直接 release | 那条注释约定可以删了 |
| `disposeObject` 的 `ACTOR_ROOT_MARKER` 剪枝 | 直接 release | 整套剪枝逻辑可以删了 |

### 8.3 现在不要做的四件事

| 能力 | 现在的替代 | 触发条件 |
| --- | --- | --- |
| 异步加载 + 去重 | `initRapier` 已是 singleton + promise guard；全仓只有 2 处异步资源 | §8.1 的 `.bin` 格式落地时 |
| LRU / 驻留预算 | `ChunkStreamer` 的 loadRadius / keepRadius 已针对 chunk 语义调过 | 出现第二类需要驻留预算的资源时 |
| 热重载 | 无 | ToolLayer 真正开工时 |
| 依赖图 | 无贴图、无材质实例化，依赖是平的 | 美术方向引入贴图时 |

提前把这四样做进去，会得到一个比 `ChunkStreamer` 更弱、又必须去替换它的抽象。所以立项名字应该是**「GPU 资源所有权表」而不是 RuntimeAssetManager**；等 `.bin` 格式落地、异步与去重挂上来之后，它才成为 `RuntimeAssetManager`。

### 8.4 归属与线程

- **CoreLayer**（「内存 GC」那格）→ 句柄表 + 引用计数 + 释放。**不知道资产是什么**，只知道有人持有。
- **ResourceLayer** → 加载、烘焙产物解码、key 的命名与去重。`RuntimeAssetManager` 是这一层的门面，建立在 CoreLayer 的所有权表之上。

Sim / Render worker 拆开之后，**GPU 资源只存在于渲染线程**，所有权表必须住在那一侧，Sim 侧只能拿到一个整数句柄。这和第 1 步的 `proxyId` 是同构的——都是「跨线程只传 id，实体留在拥有它的那一侧」，两者可以共用同一套句柄语义，不需要两套。

---

## 9. 语言划分

| 层 | 语言 | 理由 |
| --- | --- | --- |
| Renderer / job system / 内存 | **C++** | 这是唯一真正需要重写的东西。Emscripten pthreads + OffscreenCanvas 给到真正的渲染线程。 |
| Physics (Rapier) / chunkgen | **Rust** | 已有、已确定性、已双端共用。`native/chunkgen` 现在这个「纯数据进纯数据出、5.9 KB」的形态很健康，别为统一而统一。 |
| Gameplay / Actor / 网络逻辑 | **TypeScript** | 迭代速度，且 `shared/` 那 7,278 行已与服务端共用、零 Three 依赖——它已经是一个干净的 Game World 核心。 |

Three.js 的替换难度比想象中低。统计实际用到的符号：`Group` 138 次、`Vector3` 129、`BufferGeometry` 75、`ShaderMaterial` 43、`EdgesGeometry` 13。而 `castShadow`、`shadowMap`、`GLTFLoader`、`MeshStandardMaterial`、`SkinnedMesh`、`AnimationMixer`、任何 `THREE.Light`——**全是 0**。

要自研的其实只有：GL 状态机 + BufferGeometry 上传 + 一棵 transform 树 + 视锥剔除（而 §4.4 说明连剔除都不需要通用版）。真正烦的只有 `EdgesGeometry`（拓扑边提取）和 `Raycaster`，而这两个都不在热路径，可以最后做、甚至永久保留移植版。

---

## 10. 路线图

顺序是有依赖的，不是优先级排序。

### 第 0 步 · 打开跨源隔离
`现在就能做` `半天` `零架构风险`

`server/http/` 加 COOP/COEP 响应头，`vite.config.ts` 加 dev server headers。做完 `SharedArrayBuffer` 可用。

顺带能立刻暴露「哪些外部资源会被 CORP 挡掉」——这种问题晚发现很贵，而它和后面所有步骤都无关，可以今天就合。

### 第 0.5 步 · 清掉会被一起搬走的债
`现在就能做` `纯清理`

- 合并 `shared/collision/` 与 `PhysicsWorld` 两套碰撞。
- 给 `step()` 的惰性语义补测试（那句 `apparently empty tick`）。

不做的话，这两样会被原样搬进新引擎，而且是在最难调试的阶段暴露。

### 第 1 步 · 剥出 Render World 的边界
`回报最高` `不改一个像素` `依赖 0.5`

- `ThreeObjectComponent` → `RenderProxyComponent { proxyId }`，不再持有 `THREE.Group`。
- `ActorTransformSystem` 改成往 `Float32Array` 写 SoA，不再 `position.set()`。
- 现有 Three 代码整体搬进 `ThreeRenderScene implements RenderScene`。
- 数据模型按 §4.5 的四类定形，不要做成通用 primitive 表。

仍然单线程、仍然用 Three.js、帧率不变。但「Render World 不引用 Actor」这条约束**被代码强制了**，而这个盒子的接口就是以后 C++ 渲染器的接口。

### 第 2 步 · 网络 + Game World + 物理整体进 worker
`首个可测收益` `依赖 0、1`

- 网络、UWorld、预测和解、角色控制器查询同处一个 Sim Worker（不能拆，见 §3）。
- `native/chunkgen` 单独一个 worker。现在 `ChunkStreamer` *每帧最多建一个 chunk*（`drainBuildBudget()`，`src/world/ChunkStreamer.ts:255`）——这个预算本身就是「生成在主线程会卡帧」的补丁，挪走后可以并行建、放开视距。

这一步做完，主线程只剩 UI 和输入。**它同时是在证明 worker 架构在这个项目里跑得通——在写第一行 C++ 之前拿到这个证据很重要。**

### 第 3 步 · OffscreenCanvas + 渲染线程
`依赖 1、2`

Render Worker 拿到 `transferControlToOffscreen()` 的 canvas，通过第 1 步定好的 SAB 双缓冲读 transform。对应 Emscripten 侧的 `OFFSCREENCANVAS_SUPPORT`，让 GL context 归一个 pthread 所有。

到这里就是完整的 UE 线程模型了，而且渲染仍然可以是 Three.js。

### 第 4 步 · 才是换掉 Three.js
`可无限期推迟` `依赖 1、3`

到这里 Three.js 只剩下「把 proxy 数据翻译成 GL 调用」，而且按 §4 特化之后要写的是 **2 个 shader + 6 个 pass**，不是通用 RHI。

附带理由：项目锁在 **three@0.128（2021）**，`outputEncoding` / `sRGBEncoding`（`src/rendering/SceneRenderer.ts:82`）、`PlaneBufferGeometry`（`src/grass/GrassBendField.ts:15`）都已是被删除的 API——「升级 Three」和「换掉 Three」的成本差距没那么大。后者能直接上 WebGPU：**compute shader 是绕开单线程的另一条路**，草地弯曲场（现在是 ping-pong render target）、粒子这类完全可以搬上去。

### 对「后期会吃力」的一个反向意见

方向认同，但归因建议先测。按现在的代码，主线程大头很可能是 chunk 生成／合批（已知会卡，否则不会有每帧一个的预算）和 `PbfSlimeSimulation` / `HybridSlimeSimulation`（固定步长子步循环）——**这两样在第 2 步就解决了，都不需要自研渲染器**。而 draw call 侧现在是 4–8 次／chunk，在 WebGL 上远谈不上瓶颈。

所以：如果第 2 步做完帧时间已经够了，**第 4 步可以无限期推迟，代价是零**——因为第 1 步定的那条边界本来就是自研渲染器需要的那条边界。

### 层与路线图的对应

| 层 | 对应路线图 | 能否并行 |
| --- | --- | --- |
| PlatformLayer 线程抽象 | 第 0、2 步 | **关键路径** |
| SceneLayer 的 Render 边界 | 第 1 步 | **关键路径**，回报最高 |
| CoreLayer · RHI / 3D world | 第 4 步 | 可无限期推迟 |
| CoreLayer · JS 运行时 | 路线图外 | 独立项目 |
| ResourceLayer 烘焙格式 | 第 4 步的前置 | 可并行，不阻塞 0／1／2 |
| CoreLayer · 资源所有权表 | 第 4 步的前置 | 可并行，现在就能开 |
| ToolLayer | 路线图外 | 可并行，现在就能开（见 `tool-layer-implementation.md`） |

关键路径其实只有两件事：**PlatformLayer 的线程抽象**和 **SceneLayer 的 Render 边界**。其余都可以挪后或并行。

---

## 11. 待决事项

需要团队拍板的，不是能替你们定的。

| 决定 | 建议 | 如果选另一边 |
| --- | --- | --- |
| **Web 还是 Native 是第一目标** | **最该先定的一个** | 两个都要 → 必须按**交集**设计，§1 那三条约束仍然全部生效，自研运行时只为 native 构建买单。Web 只是预览 → native 侧线程模型可以完全自由。不定下来，CoreLayer 的工作量能差一个数量级。 |
| 美术方向是否保持程序化 | 保持 | 决定 ResourceLayer 的形态。保持 → 实质是模板缓存 + chunk 流送预算，与 glTF／骨骼无关。要上骨骼动画 → 那是一条新的美术管线，应独立于自研引擎排期。 |
| 物理引擎 | 保留 Rapier | 换 Jolt 必须**客户端服务端同一次提交内一起换**，并重新标定和解容差。 |
| `shared/` 7,278 行的归属 | 留在 TS（方案 B） | 方案 A：重写成 C++ 并让 Node 也加载同一份 WASM，彻底消灭「双后端逐位一致」的维护成本——但这是项目量级的分水岭。第 1–3 步在两条路下完全一样，可以推迟到有实测数据后再定。 |
| 烘焙格式何时做 | 按解耦立项，不按性能 | 按性能立项会发现收益不够（chunk 模板只有 5 个）。但它是第 4 步换掉 Three 的前置——几何不脱离 `THREE.Mesh`，渲染器就换不掉。 |
| 线协议 | 先不动 JSON | 要换就和 SAB 布局一起换，别分两次。 |
| WebGL 还是 WebGPU | 第 4 步再定 | WebGPU 的 compute 对草地／粒子有实质价值，但会把浏览器支持面收窄，需要保留 WebGL 后端。 |

运维提醒：`server/rooms/RoomProcessManager.mjs:57` 是每房间 `fork` 一个子进程，每个都会加载一份 Rapier WASM。如果以后有别的 WASM 模块也上服务端，内存要按房间数乘一遍算预算。

---

## 12. 结论所依据的现状

全部可在当前 main 上复核。

| 位置 | 事实 |
| --- | --- |
| COOP / COEP | 未配置——`server/`、`vite.config.ts` 中均无匹配，SAB 目前禁用 |
| Worker 使用 | 客户端零使用；服务端是每房间 `fork` 子进程 |
| `shared/` 的纯度 | 76 个文件、7,278 行，**零 Three 依赖** |
| Three 依赖面 | 84 个文件 import three，其中 36 个在 `src/models/`（程序化建模） |
| `src/scene/createLineArtScene.ts:32`<br>`server/scene/ServerScene.mjs:137` | 同一个 `PhysicsWorld` 类，两端各实例化一次 |
| `shared/physics/PhysicsWorld.mjs:290` | `computeColliderMovement`——预测与权威共用的角色移动入口 |
| `shared/physics/PhysicsWorld.mjs:323` | `do not remove this apparently empty tick`——惰性 step 的隐含语义 |
| `src/actors/systems/ActorTransformSystem.ts:38` | `render.root.position.set(...)`——当前 Game→Render 的直接写入点 |
| `src/world/ChunkStreamer.ts:255` | `drainBuildBudget()`——每帧最多构建一个 chunk 的预算 |
| `src/network/transport/GameTransport.ts:3` | `reliable-ordered \| unreliable-sequenced`——传输层已按 WebTransport 抽象 |
| `src/ui/` 的形态 | 12 个文件中 8 个使用 `document.createElement`，UI 完全是 DOM + CSS |
| 资产加载 | **全仓零资产加载**。唯一的 `fetch` 是 `chunkgen.wasm` 与房间目录 API |
| `config/` 的数据化程度 | 23 个 `*.actor.json` + 6 个 `*.scene.json`，两类各带一份 `.schema.json` |
| `src/models/` | 38 个文件全部为程序化建模，输出 `BufferGeometry` |
| `.dispose()` 的散落 | 出现 **143 次，散在 56 个文件**，分属三套互不一致的手写所有权约定 |
| `src/materials/lineMaterials.ts:3` | `OUTLINE_MATERIAL` / `GROUND_GRID_MATERIAL` 是**模块级单例**，被 `disposeScene` 的遍历式释放一并 dispose |
| `src/models/chunkTemplates.ts:114` | `createTemplateFromObject` 的输入类型是 `THREE.Mesh` / `THREE.LineSegments` |
| `shared/world/terrainConfig.mjs:34` | `TERRAIN_SHAPE` 只有 **13 项**，`TERRAIN_SURFACE` 2 项，高度层打包进同一个 code |
| `src/models/terrain/createTerrainChunkGeometry.ts` | **475 行** CPU 几何生成，每 chunk 遍历 `TERRAIN_GRID² = 256` 格 |
| 世界与常驻集 | `CHUNK_SIZE 32` · `TERRAIN_CELL_SIZE 2` · `WORLD_CHUNK_RADIUS 8`（512 m）；`loadRadius 2` → 常驻 25 chunk，相机 `far = 100` |
| 物件种类 | `PROP_KIND_COUNT = 4`，`PROP_GRID = 8` → 每 chunk 最多 64 个 |
