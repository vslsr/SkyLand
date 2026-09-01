# Phase 4：固定步长、批量输入与 rewind & replay 和解

> 上下文见 `player-collision-rewrite-00-overview.md`
> 依赖：Phase 3（两端跑同一份 `stepCharacter`）
> 玩法行为变化：预测抖动与残余瞬移消失；正常网络下本地预测与权威结果应逐位一致。

## 1. 目标

消除缺陷 A 的第 3、4 条根因——**时基不同**与**和解器不重放输入**。Phase 3 让两端算法一致，本阶段让两端的**输入序列**也一致。

## 2. 现状问题

1. 客户端按渲染帧 dt 逐帧预测（`TopDownController.update`），上行每 50ms 一条（`src/scenes/GrasslandScene.ts:480`），服务端用**一条**输入推进 50ms。这 50ms 内客户端可能换过方向、跳跃按下沿落在中间某一帧，服务端却在窗口开头就施加冲量 → 抛物线起点天然对不齐。
2. `PlayerReconciler` 只把误差按指数拉回、历史整体平移，**不重放未确认输入**。任何持续性分歧都会单调累积，超过 `RECONCILE_SNAP_DISTANCE = 2.5` 就瞬移。

## 3. 交付物

### 新增

| 文件 | 职责 |
| --- | --- |
| `shared/physics/simulationClock.mjs` | 固定步长累加器，两端共用 |
| `tests/PlayerReconciler.replay.test.ts` | 重放和解的收敛性与幂等性 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `shared/networkTuning.mjs` | 新增 `SIMULATION_STEP_SECONDS = 1/60`；调整输入相关常量 |
| `src/network/protocol.ts:122` | `PlayerInputFrame` 增加 `tick`；上行消息改为携带输入数组 |
| `src/scenes/GrasslandScene.ts:473` | 上行改为发送本窗口内累积的全部输入步 |
| `server/scene/ServerScene.mjs` | `applyInput` 逐条重放；时间预算按**步数**扣而非自报 dt |
| `src/player/PlayerReconciler.ts` | 改为 rewind & replay |
| `src/player/PlayerEntity.ts` | 维护未确认输入队列 |

## 4. 详细任务

1. **固定步长**

   - `SIMULATION_STEP_SECONDS = 1/60`。50ms 上行窗口 = 3 步，整除，不留余数。
   - 客户端累积渲染帧时间，每满一步跑一次 `stepCharacter`；不足一步的余量留到下一帧。
   - 渲染位置 = 上一步与当前步之间按余量插值，**不要**直接用逻辑位置，否则高刷屏会看到 60Hz 的台阶感。
   - 单帧最多补跑的步数要封顶（建议 5 步），防止标签页切回来时一次跑几百步卡死。

2. **输入按 tick 成批上行**

   - 每一步产生一条 `{ tick, move, sprint, jump, yaw }`，进本地队列。
   - 上行包携带这一窗口内的全部步（正常 3 条），而不是一条合并输入。
   - 丢包时下一包会带上更早的未确认步（队列直到收到 ack 才裁剪），天然获得冗余，不需要额外重传机制。
   - 包大小：3 条 × 约 20 字节，相比现状增加约 40 字节/包、每秒 20 包，可忽略。

3. **服务端逐条重放**

   - `applyInput` 收到数组后按 tick 升序逐条 `stepCharacter`，每条固定推进 `SIMULATION_STEP_SECONDS`。
   - **反作弊保留**：`tick` 必须严格递增（沿用现有 `sequence` 的丢弃规则）；时间预算 `INPUT_TIME_BUDGET_SECONDS` 改为按**允许的步数**扣减，客户端谎报 dt 的入口直接消失——因为 dt 不再由客户端提供。
   - 单包内步数上限 = `MAXIMUM_INPUT_DELTA_SECONDS / SIMULATION_STEP_SECONDS`，超出部分丢弃。
   - 快照回带 `ackTick` 与权威 `{x, y, z, vx, vy, vz, grounded}`。

4. **快照状态扩展**

   `ServerScene.mjs:827` 附近的玩家快照字段，从 `{x, y, z, verticalVelocity, grounded}` 扩展为带 `vx / vz`。量化精度与现有 `roundCoordinate` 对齐；速度用于和解重放的初值与远端动画，缺了它重放的第一步就会错。

5. **rewind & replay 和解**

   ```
   收到 ackTick + 权威 state
   → 本地 characterState = 权威 state（含速度与 grounded）
   → 刚体 setTranslation（立即生效）
   → 从队列里取出 tick > ackTick 的输入，逐条 stepCharacter 重放
   → 得到新的当前状态
   → 裁剪队列（丢弃 <= ackTick 的）
   ```

   - 重放期间**不推进渲染插值**，一次性算完。
   - 正常情况下重放结果与原预测逐位相同（探针已验证 collider 顺序无关，最大偏差 0），玩家看不到任何变化。
   - 残差只进**渲染偏移量**做指数平滑，**不再直接改逻辑位置**——这是与现状最本质的区别。逻辑位置永远是「权威 + 重放」的结果。
   - `RECONCILE_SNAP_DISTANCE` 的瞬移分支保留作为兜底（长时间断线后），但正常游玩不应触发。

6. **重放成本**

   最坏情况：RTT 200ms → 未确认约 12 步 → 每次收快照重放 12 次 `stepCharacter`，每次含一次 `computeColliderMovement` + `world.step()`。快照 10Hz，即每秒 120 次。可接受，但要实测；若成为瓶颈，可让 `world.step()` 在重放期间跳过 broad-phase 全量重建（Rapier 对静止 collider 有增量优化）。

## 5. 验收标准

- [ ] 本地零延迟环境下，`PlayerReconciler` 的重放结果与原预测**逐位相同**（误差恒为 0）。
- [ ] 人为注入 150ms 延迟 + 5% 丢包，跳上 1m 高台与走出悬崖**全程无瞬移、无回拉**。
- [ ] 标签页切后台 10 秒再切回，不会一次补跑数百步（步数封顶生效）。
- [ ] 高刷屏（120Hz+）与 30Hz 下运动轨迹一致。
- [ ] 客户端谎报 dt 的路径已不存在（协议里没有 dt 字段）。
- [ ] `npm run test:server` / `test:client` / `build` 全绿。

## 6. 风险与注意

- **渲染插值不做就会看到 60Hz 台阶感**，尤其在高刷屏上。这一条容易被漏，因为开发机常常正好 60Hz。
- **`jump` 的按下沿必须在 `stepCharacter` 内按步取**（Phase 3 §3.4 已约定）。如果仍在输入采集处取，重放时边沿会消失，重放结果与原预测分叉。
- 输入队列要有长度上限，长时间收不到 ack 时按上限裁剪并触发一次兜底瞬移，否则队列会无界增长。
- 本阶段不改变任何碰撞行为，若试玩发现手感问题，先确认是不是 Phase 3 的 `airControl` 调优遗留，而不是本阶段引入。
