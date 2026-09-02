# 后续修正：悬停、免费台阶、预算追赶与客户端玩家碰撞

> 上下文见 `player-collision-rewrite-00-overview.md`
> 依赖：Phase 1–5 已经落地（两端共用 `stepCharacter`、固定 1/60 步、rewind & replay）
> 玩法行为变化：客户端掉线不再悬停；1m 崖壁必须走坡道或起跳；玩家之间在本地预测里也挡得住。

## 1. 权威模拟不再由输入包独占驱动

**问题**：`ServerScene.applyInput` 是 `stepCharacter` 在服务端唯一的调用点，`update()`
只补预算。客户端一旦停止上行——标签页被节流、网络中断，或者干脆故意静默——玩家的
权威状态连重力都停下来，人停在半空。实测跳起来后不再发包，三秒后 `vy` 仍是 7.0、
`y` 一动不动。

**改动**：

- 把 `applyInput` 里的单步循环体抽成 `ServerScene.stepPlayerOnce(player, input)`，
  客户端输入和服务端补步走同一条路径，权威状态只有这一个改动入口。
- 新增 `server/scene/PlayerIdleSimulation.mjs`：在房间 tick 上，对**静默超过
  `MOVEMENT_IDLE_TIMEOUT_MS` 且仍在运动**的玩家补中性输入。站在地上不动的玩家一步
  都不跑，所以挂机的人不会白白吃掉 `world.step()`。
- 补步同样扣 `stepBudget`，且单个 tick 有 `MAXIMUM_IDLE_CATCH_UP_STEPS` 上限；收到
  真实输入时清空补步余量，同一段真实时间不会被模拟两次。
- 补步不推进 `ackTick`：它是客户端的输入编号，和解仍然以客户端自己的输入序列为准。

**成本上界**：房间人数 × 6 步／tick，与世界面积无关。

## 2. autostep 从 1.05 降到 0.35

**问题**：Phase 1 把 `AUTOSTEP_MAX_HEIGHT` 定在 1.05，理由是「略高于
`TERRAIN_HEIGHT_STEP = 1.0`」。但 Rapier 的 autostep 对所有 collider 一视同仁，不区分
「地形接缝」和「一块石头」。结果是角色总高只有 0.84m，却能自动走上 1.04m 的垂直墙：
所有地形崖壁、货箱、石头都退化成免费台阶，跳跃对地形传送失去意义。

仓库里唯一红着的那个测试（`server/tests/ServerActorReplication.test.mjs` 的「玩家移动
由房间 DS 按 Actor 模型生成的简易碰撞权威推出」）就是这个：玩家没有被货箱挡住，而是
爬到了 0.63m 高的箱顶。

**改动**：`AUTOSTEP_MAX_HEIGHT = 0.35`，约为角色身高的三分之一。

**接缝为什么不需要单独兜底**：地形是每 chunk 一张 trimesh，同高相邻格共面，跨 chunk
的边界顶点由同一份 cell 高度算出；落在台地上时 2cm 的 `CHARACTER_OFFSET` 由
`SNAP_TO_GROUND_DISTANCE = 0.25` 吸回去。实测把 autostep 关掉、设成 0.35 或 1.05，在
平坦地形上走 16m 的位移与卡顿次数完全一致——接缝行为和 autostep 无关。

`server/tests/characterAutostep.test.mjs` 锁住这组边界：矮台阶迈得过去、刚过上限的台阶
挡得住、1m 崖壁走不上去、台地顶面能连续走过 cell 与 chunk 接缝、直坡仍可上、贴近崖壁
起跳仍能踩上 1m 台地（冲量 7 / 重力 22 的抛物线顶点约 1.11m）。

## 3. `stepBudget` 留出追赶余量

**问题**：补充速率是 `elapsed / SIMULATION_STEP_SECONDS`，正好等于客户端每真实秒产出
60 个固定步。速率相等意味着**没有任何追赶余量**：一次卡顿堆起来的积压永远排不掉，
服务端排一步、客户端又生一步，权威状态一直落后那一段，直到客户端未确认队列顶到
`MAXIMUM_PENDING_INPUT_STEPS` 开始丢最旧的输入。

**改动**：新增 `INPUT_STEP_BUDGET_CATCH_UP_RATE = 1.2`，补充时乘上它。上限仍由
`INPUT_TIME_BUDGET_SECONDS` 封住，所以作弊客户端拿不到额外的加速空间。

**收敛速度**：突发额度 15 步先吃掉一截，其余按 12 步／秒排。一次 2 秒（120 步）的卡顿
大约 9 秒排干净。想更快就调大这个系数，代价是允许的瞬时超速窗口变宽。

## 4. 玩家碰撞：删掉失效的过滤，补上客户端形体

**先纠正一个判断**：服务端玩家其实一直是互相阻挡的。`PhysicsWorld` 里那句
「排除所有角色 collider」的过滤谓词从来没生效过——在 Rapier 的回调里
`collider.handle` 恒为 `0`，而 `#characterColliderHandles` 里存的是另一套值，
`!has(0)` 永远为真。真正的问题在客户端。

**问题**：客户端只给本地玩家建角色，远端玩家在本地物理世界里没有任何形体。本地预测
直接从别人身上穿过去，再被每一份快照拉回来——贴身时就是持续的橡皮筋。

**改动**：

- `PhysicsWorld.computeCharacterMovement` 去掉那个失效的谓词。Rapier 的角色控制器
  内部就排除了正在移动的 collider，不需要自定义谓词避免自撞；过滤只靠 MOVEMENT 层的
  InteractionGroups。行为不变，只是代码不再骗人。
- 新增 `PhysicsWorld.setCharacterProxy` / `removeCharacterProxy`：远端玩家的运动学
  碰撞代理，位置由快照插值直接写入。移动代理不销毁重建 collider，宽相不必每帧重排。
- `src/player/RemotePlayerColliders.ts` 按 `RemotePlayerGroup` 的增删改维护这组代理。
- `separateSpawnFromPlayers`（`shared/playerMovement.mjs`）：玩家实心之后，出生点必须
  避开已经在场的人。角色控制器不会把已经嵌在一起的两具身体分开，出生在别人身上的人
  会当场卡住，只能等对方走开。

**已知近似**：代理位置比权威落后一个插值延迟，而且是被瞬移过去的——角色控制器不会把
已经嵌进去的身体推开。但代理位置来自权威模拟，那边两名玩家本来就隔着一个半径和，
真正会发生的重叠只有预测误差那么大，随下一份快照的和解一起消掉。

## 5. 这一轮没有处理的

- **相机遮挡在生产路径上是关的**（`PlayerEntity.ts` 的 `cameraCollisionEnabled: false`），
  经确认是有意为之：玩法 TopDown 要保持 Scene 配置的完整构图。`castCameraSphere` 与
  CAMERA 层因此只有测试在跑。
- **移动 Actor 的 collider 每 tick 删了重建**（`ActorColliderIndex`），且没有移动平台
  承载：站在移动的筏／船甲板上会被甩下去。
- **`world.step()` 按「玩家 × 步」调用**，房间里 N 个玩家就是 N×60 次全世界 step／秒。
  实测 16 人、5×5 chunk 的空地形约 45ms／模拟秒，其中 15/16 是重复工作。
- **两套碰撞世界仍并存**：Rapier 管玩家与相机，`CollisionWorld` / `CollisionGrid` 仍在
  跑 Actor 推出与交互宽相，Phase 5 计划的退休没做。
- **平坦地形上偶发的单步顿挫**：角色控制器在 trimesh 内部边上会丢掉约 1.6% 的位移，
  与 autostep 取值无关（关掉 autostep 也一样），需要单独排查。
