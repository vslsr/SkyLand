# SkyLand 角色物理与碰撞参考

这份参考描述当前生产路径：Rapier 为碰撞查询和 Kinematic Character Controller 提供真实几何解算，`stepCharacter` 明确积分玩家速度，浏览器预测和房间 DS 重放同一固定步。旧的二维网格仍服务部分非玩家 simple-collision System，但不再决定玩家 Transform。

## 模块地图

| 模块 | 职责 |
| --- | --- |
| `shared/physics/RapierRuntime.mjs` | 每个 JS realm 只初始化一次 Rapier，并把浏览器/Node 包差异隔离在入口。 |
| `server/physics/rapierRuntime.mjs` | Node 房间进程加载 `@dimforge/rapier3d-compat`。 |
| `src/main.ts` | 浏览器入口加载 `@dimforge/rapier3d`，初始化完成后才创建游戏。 |
| `shared/physics/PhysicsWorld.mjs` | 唯一 Rapier ownership boundary：角色、地形、静态组、Actor、KCC、射线、相机 shape cast、debug render。 |
| `shared/physics/characterParams.mjs` | 角色尺寸转换和 KCC 默认参数。 |
| `shared/physics/characterState.mjs` | 可复制/回滚的 feet-space 状态。 |
| `shared/physics/stepCharacter.mjs` | 两端唯一角色模拟步：加减速、空中控制、重力、跳跃、碰撞法线投影、grounded。 |
| `shared/physics/simulationClock.mjs` | 60 Hz 累加器与后台恢复补步上限。 |
| `shared/physics/collisionGroups.mjs` | simple-collision layer 到 Rapier interaction group 的映射。 |
| `shared/physics/simpleCollisionToPhysics.mjs` | 复用 Actor/世界物件 collision authoring，并按需生成多枚 Rapier collider。 |
| `shared/world/terrainCollisionMesh.mjs` | 渲染/物理共享顶面三角形，生成含垂直断崖的 chunk trimesh。 |
| `src/world/ChunkStreamer.ts` | 客户端随 chunk 装卸地形和世界物件 collider。 |
| `server/scene/ServerTerrainColliders.mjs` | DS 地形 trimesh 常驻与 terrain patch 重建。 |
| `server/scene/ServerChunkColliders.mjs` | DS 世界物件静态 collider 常驻。 |
| `src/controllers/TopDownController.ts` | 固定步输入采样、本地预测、渲染插值。 |
| `src/player/PlayerEntity.ts` | 角色 physics handle、未确认输入队列、权威状态入口。 |
| `src/player/PlayerReconciler.ts` | 按 `ackTick` 回滚并重放未确认步，输出仅供渲染的纠正量。 |
| `server/scene/ServerScene.mjs` | 输入限额/排序/去重、固定步权威执行和快照确认。 |

完整设计来源在 `doc/player-collision-rewrite-00-overview.md` 至 `06-tests.md`。文档解释阶段目的；代码和回归测试决定当前事实。

## Runtime 边界

Rapier WASM 初始化是异步且 realm-local 的。浏览器和 Node 使用不同包，但初始化后共享相同 API：

- 浏览器：`@dimforge/rapier3d`，Vite 使用 `vite-plugin-wasm` 发出 WASM 资源；
- Node 房间进程和测试：`@dimforge/rapier3d-compat`；
- 模拟模块只调用 `getRapier()` 或接受已初始化 runtime，不自行 import 某一个包。

`initRapier` 必须幂等。入口若在 runtime 未完成前构建 `PhysicsWorld`，失败应该明确暴露，而不是退回旧碰撞路径。

## 坐标和角色体

网络、Gameplay 和 `CharacterState` 使用 feet-space：`x/y/z` 中的 `y` 是脚底。Rapier 的 position-based kinematic cylinder 使用中心坐标：

```text
bodyCenterY = feetY + halfHeight + CHARACTER_OFFSET
feetY       = bodyCenterY - halfHeight - CHARACTER_OFFSET
```

转换只允许出现在 `PhysicsWorld.createCharacter`、`setCharacterTranslation` 和 `getCharacterTranslation`。若别处再次加半高，客户端与服务端会稳定相差一个角色高度，看起来像 reconciliation 不断拉扯。

当前参数的唯一来源是 `characterParams.mjs`：

| 参数 | 当前值 | 含义 |
| --- | ---: | --- |
| `CHARACTER_OFFSET` | 0.02 m | KCC skin/脚底间距 |
| `AUTOSTEP_MAX_HEIGHT` | 1.05 m | 可自动跨越的台阶高度 |
| `AUTOSTEP_MIN_WIDTH` | 0.15 m | 可站稳台阶的最小宽度 |
| `SNAP_TO_GROUND_DISTANCE` | 0.25 m | 已接地沿坡移动的贴地范围 |
| `MAX_SLOPE_CLIMB_ANGLE` | 60° | 最大爬坡角 |
| `MIN_SLOPE_SLIDE_ANGLE` | 50° | 开始滑落角 |

这些数值必须两端共用。角色 collider 摩擦为零，水平减速由 `stepCharacter` 明确控制，避免 Rapier 摩擦成为不可见的第二套移动参数。

Rapier world 的重力是零。玩家不是 dynamic rigid body；重力、终端速度和跳跃冲量都在共享 step 中积分。这样才能让回滚重放只依赖明确状态和输入。

## PhysicsWorld 生命周期

| 类别 | API | key | 生命周期所有者 |
| --- | --- | --- | --- |
| 玩家 | `createCharacter/removeCharacter` | player id | `PlayerEntity` / `ServerScene` |
| 地形 trimesh | `setChunkCollider/removeChunkCollider` | chunk key | `ChunkStreamer` / `ServerTerrainColliders` |
| 静态世界物件 | `setStaticColliderGroup/removeStaticColliderGroup` | `props:<chunk key>` | `ChunkStreamer` / `ServerChunkColliders` |
| Actor collider | `setActorCollider/removeActorCollider` | actor id | `ClientActorSystem` / DS Actor collider同步 |

每个 `set*` 是按 key 替换，适用于 chunk patch 或 Actor Transform 更新。删除路径必须与添加路径成对；快速传送或长距离跑图后，数量仍只能由 keep radius/AOI 决定。

创建或删除 collider 后，Rapier query pipeline 会被标记 dirty。`prepareQueries()` 在需要时执行一次 `world.step()`，使 collider 对 KCC、射线和 shape cast 可见。测试里若刚 `set*` 就直接访问底层查询而没有 prepare，得到的旧结果不是几何错误。

### Rewind 的双目标陷阱

position-based kinematic body 同时保存当前 translation 和下一步 target。回滚、出生修正或传送若只调用 `setTranslation`，下一次 `world.step()` 会把身体恢复到旧预测 target。`setCharacterTranslation` 因此必须同时：

1. `body.setTranslation(center, true)`；
2. `body.setNextKinematicTranslation(center)`；
3. propagate collider position，并标记 query dirty。

症状通常是“当前帧看似校正成功，下一物理步又跳回旧位置”，很容易被误判为服务端快照有问题。

## 地形拓扑

SkyLand 有一米高的垂直块边，Rapier heightfield 无法表达，必须用 trimesh。`terrainTopTriangles(shape, corners)` 同时驱动 Three.js 顶面与 Rapier 顶面；物理层不能自己选择另一条对角线。

每个 cell 固定两枚顶面三角形。断崖只由当前 cell 的 east 和 north 边负责，避免相邻 chunk 重复生成共面墙。生成使用全局 cell 坐标，因此负坐标、chunk 接缝和 terrain patch 与渲染读取同一份 `cellCodeAt`。

`TriMeshFlags.FIX_INTERNAL_EDGES` 用于减小角色跨过三角形内部边时的假法线/卡顿。修改拓扑后必须同时验证：

- 固定种子三角数量且无重复面；
- 四向斜坡和两类角坡对角线一致；
- east/west、north/south seam 只有一个 cliff owner；
- `sampleTerrain` 高度与 Rapier 向下射线一致；
- patch 只重建受影响的常驻 chunk；
- 长距离移动后旧 trimesh handle 已删除。

## 一次角色固定步

`stepCharacter(state, input, 1/60, physics, params)` 的顺序是行为合同：

1. 净化并归一化 move input；从 walk/sprint 得到目标水平速度。
2. grounded 使用 acceleration/deceleration，airborne 使用 `airAcceleration * airControl`，以限加速度逼近目标速度。
3. jump 只响应按下沿；起跳立即清 grounded。否则 grounded 施加很小的向下 probe，airborne 积分重力并钳制最大下落速度。
4. 对玩法 bounds 预钳制期望位移。
5. `prepareQueries()`，由 KCC 对期望三维位移做 autostep、slope、slide 和 collision 解算。
6. 用墙面法线移除“冲进墙”的速度分量，保留切线惯性；撞天花板时清正向 `vy`。
7. `physics.step(dt)` 后读取 feet-space 位置。
8. 上升中的角色即使 KCC 仍报告旧地面接触，也保持 airborne；真实落地后才把负 `vy` 清零。

这套顺序直接保证两个关键体验：

- 从高台走出后，`vx/vz` 不被清掉，`vy` 随重力连续变化，不能用下一格地形高度吸附；
- 跳到更高块时，KCC 使用完整 3D sweep 和共享 trimesh，不会让 XZ 推出与独立 Y 采样互相打架。

### 水面支持

水面不是 Rapier 实体地面。进入水面支持时：

- 吃水深度由各 Actor 原型的 `minimumDraft` / `maximumDraft` 独立配置；玩家可以深嵌水面，木筏可以保持较浅吃水；
- 临时关闭 snap-to-ground，避免海岸低地把玩家从水面向下吸；
- 由权威/预测双方提供同定义的 `buoyancyHeight` 作为弹簧目标，而不是直接写 Y；
- 岸边进入水域先按重力下落，浸入吃水线后由共享固定步的弹簧/阻尼改变 `vy`；
- 接近稳定吃水线时才获得可跳跃的浮力支撑状态；
- 波浪 bobbing 按输入 tick 调制浮力弹簧目标，客户端预测/回放与服务端必须使用同一相位；角色逻辑 Y 仍只能由固定步物理积分产生，禁止直接写入。

## Collider authoring 与 layer

既有 `simpleCollision` 仍是 Actor 和世界物件的 authoring 格式。`simpleCollisionToPhysics.mjs` 负责一次性翻译坐标、yaw、盒/圆柱和 layer，调用方不应手写第二套尺寸。

**yaw 三处同号。** 线稿合批（`chunkGenerator.mjs`）、`simpleCollision` 的世界→局部变换、`PhysicsWorld` 的 `yawQuaternion` 用的都是绕 +Y 的正向旋转（局部→世界是 `[[cos, sin], [-sin, cos]]`，与 Three.js 的 `rotation.y` 一致）。任何一处取反，Rapier 里的盒子就相对看得见的模型镜像过去：正方形足迹（树干、全部圆柱）看不出来，长方形会偏出可观的距离——流式世界那块 0.48 × 0.40 的石头实测最多偏 0.26 米，表现为「被不存在的墙挡住，又能踩进石头里」。`server/tests/stepCharacter.test.mjs` 里「长方形碰撞盒转成 Rapier 之后朝向不变」逐角度锁死这一条。

复杂外形可映射为多枚 collider。弹性蘑菇就是“细 stem + 薄 cap 支撑面”：只用 stem 会让角色从视觉菌盖被拉到细根顶；把整株放大成盒又会制造看不见的墙。木筏同理，支撑顶面要对齐甲板，不应使用模型最高装饰点作为整块实体墙。

Layer 语义：

- `MOVEMENT`：KCC 查询；
- `CAMERA`：相机 sphere cast；
- collider 可同时属于两者；
- 玩家 collider 不应互相阻挡当前单角色查询，KCC filter 会排除角色 handles。

树干通常同时阻挡移动和镜头；树冠仅阻挡镜头。新增物件时要分别作出这两个决定。

## 固定步预测与权威重放

固定步常量集中在 `shared/networkTuning.mjs`：模拟 60 Hz，单渲染帧最多补 5 步，单输入包最多执行 6 步，客户端最多保留 120 个未确认步。

```text
render frame
  -> SimulationClock 产生 0..5 个 60Hz step
  -> 每步生成 tick + input，并立刻调用 stepCharacter
  -> pendingInputs 保留所有未确认步
  -> RoomClient 周期性重发 pending 队列

server packet
  -> 丢弃 tick <= ackTick
  -> 排序、去重、按包上限与时间预算执行
  -> 每步同样调用 stepCharacter(..., 1/60, ...)
  -> snapshot 带 ackTick + 完整 CharacterState

client snapshot
  -> 忽略重复/倒序 ack
  -> PhysicsWorld rewind 到权威状态
  -> 删除 tick <= ackTick
  -> 按 tick 重放剩余 pending step
  -> 逻辑位置立即正确，误差仅作为 render offset 衰减
```

输入消息没有 `deltaSeconds`。客户端渲染帧率、网络发包间隔和服务器 20 Hz room tick 都不能改变每个玩家输入步的时间长度。提高 reconciliation tolerance 不能修复步数、碰撞集或状态不一致，只会延迟暴露。

## 相机和调试

`SceneWorld.sweepCameraProbe` 调用 `PhysicsWorld.castCameraSphere`，所以地形与 CAMERA-only authoring 使用同一 Rapier query world。可选 boom 仍遵守：

1. 每帧扫完整期望长度；
2. 遇遮挡立即收回，解除遮挡平滑伸长；
3. Scene 拥有完整 camera offset，只缩水平 reach，不覆盖场景高度；
4. 传送/硬校正重置 boom，不能把旧地点的收缩量带走。

`PlayerEntity` 默认不启用可选 boom，游戏 TopDown 会保留 Scene 构图；确实需要防穿模的控制器显式提供 `cameraCollisionEnabled` 与 probe。

Rapier 原生 `debugRender()` 只画当前常驻 collider，因此仍满足大世界上界。配合玩家 Transform 双端日志查看：输入 tick、预测前后、ack、rewind、replay、服务端执行前后。日志比肉眼位置更容易区分“几何不一致”和“网络步不一致”。

## 回归矩阵

| 风险 | 主要覆盖 |
| --- | --- |
| 1 m 高台接缝卡死 | `server/tests/stepCharacter.test.mjs` 缺陷 A |
| 高台边缘吸附、丢惯性 | 同文件缺陷 B |
| 石头/蘑菇顶面被拉下 | 同文件缺陷 C |
| 天花板保留上升速度 | 同文件 ceiling case |
| 渲染帧率影响步数、后台补步风暴 | `server/tests/simulationClock.test.mjs` |
| 初始化或 collider query 时序 | `server/tests/rapierRuntime.test.mjs` |
| 地形拓扑、接缝、常驻上界 | `server/tests/terrainCollisionMesh.test.mjs` |
| 地形采样和 Rapier 不同 | `server/tests/terrainParity.test.mjs` |
| rewind/replay 自己制造误差 | `tests/PlayerReconciler.replay.test.ts` |
| 相机 probe/layer | Rapier runtime test 与 `tests/CameraBoom.test.ts` |

任何碰撞改动至少运行命中的 focused test，然后运行全量 server/client/build。手工验收必须在真实房间完成，因为“客户端自己很顺”不能证明 DS 使用相同 collider 和输入步。
