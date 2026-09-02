# 玩家碰撞重写：总览

> 分支：`claude/player-collision-rewrite-aeoyi2`
> 方案：**B —— 接入 Rapier `KinematicCharacterController`**
> 文档定位：Phase 1–6 的共享上下文。各阶段文档只写「本阶段做什么」，诊断、探针数据与架构决策一律回指本文。

## 0. 一句话

玩家现在没有「角色控制器」，只有三套互不相干的启发式规则拼在一起，且**「地面」只有地形一种来源**。本次重写把玩家换成对**统一碰撞世界**做扫掠-滑动的标准运动学角色控制器，地形与物件走同一条碰撞路径。

## 1. 现状诊断

### 1.1 现有的四块拼装件

| 模块 | 实际做的事 | 问题 |
| --- | --- | --- |
| `shared/playerMovement.mjs` `applyPlayerMovement` | 输入方向 × 速度 × dt = 新 XZ，直接赋值 | 没有速度这个量，松手立刻归零，谈不上惯性 |
| `shared/world/terrainMovement.mjs` `resolveTerrainMovement` | 沿位移采 5 个脚点比较高度差，**超阈值整步否决** | 没有接触点、没有法线、不滑动；地形专用 |
| `shared/collision/CollisionWorld.mjs` `resolveCircle` | Actor 盒子的 XZ 圆形推出 + 垂直区间过滤 | 只挡不踩；与地形语义完全不同 |
| `shared/actor/components/PlayerJumpComponent.mjs` | 竖直冲量 + 重力 | `grounded` 只有按跳跃键才会变 false |

`server/scene/ServerScene.mjs:599` 的 `resolvePlayerMovement` 与 `src/rendering/SceneRenderer.ts:169` 的 `resolveSimpleCollision` 各自抄了一遍「地形解算 ↔ 物件推出交替 4 次」的循环——两份代码，两套 step 语义。

### 1.2 三个已上报缺陷的根因

**缺陷 A：跳上高地形后卡在两格接缝，服务端继续走，再跳被瞬移**

1. **整步否决，不做滑动。** `terrainMovement.mjs:38` 的 `footprintStepAllowed` 发现抬升超过 `maximumStepHeight`（配置 **0.2**，而 `TERRAIN_HEIGHT_STEP` 是 **1.0**）就返回 `undefined`，整段位移作废。落在接缝上时半径 0.42 的采样十字前方那点落在高格，抬升 1m > 0.2m，完整位移被拒；退化到分轴后两轴常常同样被拒 → 完全卡死。
2. **两端运算顺序不同。** 客户端 `TopDownController.update`（`src/controllers/TopDownController.ts:274`）先 `updateVerticalMotion`（积分 + 落地）再水平移动；服务端 `applyInput` 水平垂直一起算，之后才 `resolveGround`。做水平解算的那一刻两端 `airborne` 状态不同，而 `traversableStepHeight`（`PlayerJumpComponent.mjs:87`）空中返回「离地净空」、地面返回 0.2 → **客户端已落地被挡、服务端还在空中过去了**。
3. **时基不同。** 客户端按渲染帧 dt 逐帧预测；上行每 50ms 一条（`src/scenes/GrasslandScene.ts:480`），服务端用**一条**输入推进 50ms。跳跃按下沿的时刻两端对不齐。
4. **和解器不重放输入。** `PlayerReconciler` 只把误差按指数拉回。客户端卡住 + 服务端在走 → 误差单调增长 → 超过 `RECONCILE_SNAP_DISTANCE`（2.5m）→ 瞬移。

**缺陷 B：从高处走出去被吸附到低一格，没有惯性抛物线**

1. 没有「离开地面」这个状态转移，`grounded` 变 false 的唯一入口是 `setPressed`。
2. grounded 时 y 是贴地投影：`resolvePlayerMovement` 里 `verticalPosition.y = playerSupportHeightAt(...)`，每帧把 y 直接赋成新 XZ 处的地表高度 → 走出边缘 = 垂直瞬移，速度 0。
3. 没有水平速度可保留，`airControl` 只是缩放输入而非保留动量。

**缺陷 C：跳到蘑菇/石头上被强制拉下来**

1. `ServerScene.mjs:674` 的 `playerSupportHeightAt()` **只采样地形 + 浮力，碰撞体一个都不参与**。落地判定里的 `supportY` 是石头底下那块地形的高度，玩家永远不会在石头顶面 grounded。
2. `shared/actor/simpleCollision.mjs` 的 `blocksVerticalProfile` 有一句 `if (obstacleMaximumY <= moverMinimumY + stepHeight) return false`——从上方落下时脚底高于石头顶面，石头直接被跳过，连横向推出都没有，径直穿模下坠。
3. 蘑菇更特殊：`createSimpleCollisionFromRender` 里 `line-art-elastic-mushroom` 只给了 `halfWidth: radius * 0.4` 的细根部，**菌盖根本没有碰撞体**。

三个缺陷是同一个根因的三种表现：**支撑高度只有地形一种来源，物件只是 XZ 平面上的一圈栅栏。**

### 1.3 顺带暴露的问题

- 没有天花板判定，跳进盒子底面/树冠会穿过去。
- 速度上报是位移反推（`player.speed = distance / granted`），撞墙时掉到 0，动画抖。
- `MAXIMUM_TERRAIN_STEPS = 64` 固定步进，步长 0.4m 与半径 0.42m 同量级，高速移动会漏检。

## 2. Rapier 探针结论

以下全部在 Node 中实跑验证（探针脚本未入库）。

| 验证项 | 结果 |
| --- | --- |
| `@dimforge/rapier3d-compat@0.20.0` 在 Node 跑通 | 通过，`await RAPIER.init()` |
| compat 内嵌 wasm vs bundler 版 wasm | **逐字节相同**（2 021 200 bytes，md5 一致）→ 客户端用 `rapier3d`、服务端用 `rapier3d-compat` 无数值差异 |
| 缺陷 A：跳上 1m 台阶后继续走 | `enableAutostep(1.05, 0.15, false)` → 落到 feetY=1.02 后平顺走过接缝，不卡（**1.05 已在 `07-followups.md` 改为 0.35**：接缝其实靠 trimesh 共面与 snapToGround 解决，用不着这么高的 autostep） |
| 缺陷 B：走出悬崖 | `enableSnapToGround(0.25)` → 越过边缘后 `computedGrounded()` 变 false，水平速度保留，抛物线下落 |
| 缺陷 C：跳上石头顶面（顶 y=0.6） | 站在 feetY=0.62，沿顶面行走，走到边缘再自然落下 |
| collider 插入顺序不同的最大偏差 | **0** —— 客户端 chunk 流式加载顺序与服务端不同也不影响结果 |
| 不调 `world.step()` 时查询 | **查不到新插入的 collider**（grounded=false）→ 每 tick 必须 `step()`，这是硬约束 |

## 3. 目标架构

### 3.1 新模块

```text
shared/physics/
  RapierRuntime.mjs         init 单例 + 两端统一的 RAPIER 句柄注入
  PhysicsWorld.mjs          World 门面：角色/chunk/Actor collider 的增删改 + step()
  characterParams.mjs       offset / autostep / snapToGround / 坡度角，两端共用常量
  stepCharacter.mjs         唯一的一步模拟
shared/world/
  terrainCollisionMesh.mjs  地形格 → 三角网（顶面 + 崖壁），物理与渲染共用
```

### 3.2 地形碰撞体：每 chunk 一个 Trimesh

`src/models/terrain/createTerrainChunkGeometry.ts:223` **已经**在生成需要的拓扑：每格 2 个顶面三角形（按 `usesNorthWestSouthEastDiagonal` 选对角线）+ 东/北共享边上的崖壁 quad。把其中的纯拓扑部分抽到 `shared/world/terrainCollisionMesh.mjs`，渲染侧继续加颜色和描边，物理侧建 `ColliderDesc.trimesh(vertices, indices)`。

**碰撞面 = 看到的那个面**，这是本次重写的核心命题。

不能用 Rapier 的 Heightfield：它共享顶点，表达不了 1m 的垂直崖壁。

规模：16×16 格 ≈ 512 顶面三角 + 最多 512 崖壁三角 ≈ 1024 tri/chunk（`CHUNK_SIZE = 32`m，`TERRAIN_CELL_SIZE = 2`m）。

### 3.3 一步模拟（两端逐字共用）

```text
stepCharacter(state, input, dt, physics, params):
  1. 水平速度：grounded → 趋向 输入方向 × speed
              airborne → 按 airControl 趋向，保留既有动量
  2. 跳跃：grounded 且本 tick 有按下沿 → vy = impulse, grounded = false
  3. grounded ? vy = -SNAP_PROBE : vy = max(-maxFall, vy - g * dt)
  4. controller.computeColliderMovement(collider, { x: vx*dt, y: vy*dt, z: vz*dt })
  5. body.setNextKinematicTranslation(pos + controller.computedMovement())
  6. physics.step()
  7. grounded = controller.computedGrounded(); if (grounded && vy < 0) vy = 0
```

autostep / snapToGround / maxSlopeClimbAngle 一次配好，三个缺陷全在 Rapier 内部解掉，这一层只剩速度积分。

### 3.4 要删除的东西

- `resolveTerrainMovement` / `footprintStepAllowed` / `traceTerrain` 整个删掉
- `CollisionWorld.resolveCircle` 的玩家路径删掉
- `PlayerJumpComponent` 的 `integrate` / `resolveGround` / `traversableStepHeight` 删掉，组件退化为参数容器
- `ServerScene.resolvePlayerMovement` 与 `SceneRenderer.resolveSimpleCollision` 两份 4 次迭代循环删掉
- `TopDownController` 现有六个能改位置的入口（`setPosition` / `setVerticalPosition` / `translate` / `translateVertical` / `resolveLanding` / `updateVerticalMotion`）收敛到控制器状态

## 4. 阶段索引

| 阶段 | 文档 | 交付 | 修掉 |
| --- | --- | --- | --- |
| 1 | `player-collision-rewrite-01-rapier-runtime.md` | Rapier 运行时 + `PhysicsWorld` 门面 + 异步 boot | — |
| 2 | `player-collision-rewrite-02-terrain-collider.md` | 地形三角网抽取 + chunk trimesh 生命周期 | — |
| 3 | `player-collision-rewrite-03-character-controller.md` | 物件 collider 映射 + `stepCharacter` + 两端切换 | **缺陷 A / B / C** |
| 4 | `player-collision-rewrite-04-netcode.md` | 固定步长 + 批量输入 + rewind & replay | 预测抖动与瞬移残余 |
| 5 | `player-collision-rewrite-05-polish.md` | 相机悬臂、authoring 补齐、真实速度上报 | 穿树冠、动画抖 |
| 6 | `player-collision-rewrite-06-tests.md` | 回归与一致性测试 | — |
| 后续 | `player-collision-rewrite-07-followups.md` | 上线后的四项修正 | 悬停、免费台阶、预算追赶、客户端玩家碰撞 |

**Phase 3 结束时三个已上报缺陷即全部修复**，Phase 4–5 是质量与手感收尾。

## 5. 已知代价

1. **客户端包体 +2.0MB**（wasm）。这是方案 B 相对自研控制器最实在的成本，无法绕开。
2. **服务端 boot 变异步**：`server/rooms/room-worker.mjs:29` 构造 `ServerScene` 前要 `await RAPIER.init()`，现有 40 个 `node --test` 文件中凡构造 `ServerScene` 的同样要改。
3. **每 tick 必须 `world.step()`**（探针实证），即使没有动态刚体。20Hz + 少量玩家没问题，但不能省。
4. **`sampleTerrain` 不再是玩家 Y 的权威**，但仍被草地、物件落点、水面、WASM 跨后端比对使用，必须保留并保证与 trimesh 拓扑一致（Phase 6 加 parity 测试）。
5. **角色控制器 offset 0.02m**：脚底会停在 1.02 而不是 1.00，上报权威 Y 与渲染时要统一扣除，否则玩家悬空 2cm。

## 6. 适用的项目规则

- `.cursor/rules/large-world-compatibility.mdc`：collider 数量必须由 `ChunkResidency` 的 keep 半径界定，不得随世界面积增长；负坐标、chunk 边界、远距离传送要显式处理。
- `.cursor/rules/module-boundaries.mdc`：新代码按职责落在 `shared/physics/` 与 `shared/world/`，不塞进 `ServerScene` 或 `SceneRenderer`。
- `.cursor/rules/ue-inspired-not-unreal.mdc`：Actor / Component / 权威等术语指本项目实现。
