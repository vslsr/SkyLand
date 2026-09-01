# Phase 6：测试与验收

> 上下文见 `player-collision-rewrite-00-overview.md`
> 依赖：Phase 1–5
> 说明：各阶段自带的测试在各自文档里；本文收拢**跨阶段**的回归矩阵与一致性测试，并列出需要改写的既有用例。

## 1. 三个缺陷的回归用例（最高优先级）

固化在 `server/tests/stepCharacter.test.mjs`，用确定性的合成地形（不依赖世界种子）：

| 用例 | 场景 | 断言 |
| --- | --- | --- |
| `缺陷A-台阶接缝` | 低台 → 1m 高台，跳跃上去后持续输入前进 | 跨过接缝后 x 持续增长；任意连续 10 步内位移不为 0（不卡死） |
| `缺陷A-无瞬移` | 同上，比对两端逐步状态 | 逐步位置差 < 1e-6 |
| `缺陷B-走出悬崖` | 高台边缘持续前进 | 越过边缘后 `grounded === false`；水平速度保持；y 按 `-g·t²/2` 下降（抛物线而非阶跃） |
| `缺陷B-不吸附` | 同上 | 离地那一步的 Δy 不等于整格高度（排除瞬移吸附） |
| `缺陷C-站在物件上` | 石头顶面 y=0.6，跳上去 | 落地后 `grounded === true` 且脚底 ≈ 0.6；沿顶面行走 y 保持；走出边缘后下落 |
| `缺陷C-不穿模` | 从高处落向石头 | 中途不会出现脚底 < 石头顶面且仍在石头 XZ 范围内的帧 |

## 2. 地形几何

`server/tests/terrainCollisionMesh.test.mjs`：

- 固定 seed 的 chunk，三角数与快照一致。
- **无重面**：每条崖壁边只出现一次；跨 chunk 边界不重复（边所有权规则）。
- **崖壁闭合**：水底格（`heightLevel < 0`）与陆地格交界处，从侧面无法钻入山体。
- **渲染/物理拓扑一致**：同一格的对角线选择在 `createTerrainChunkGeometry` 与 `terrainCollisionMesh` 中相同。

`server/tests/terrainParity.test.mjs`（扩展现有文件）：

- **`sampleTerrain` 与 trimesh 一致**：随机采样若干点，`sampleTerrain(x,z).groundY` 与向下 raycast 命中 trimesh 的高度差 < 1e-4。
  这条很重要——`sampleTerrain` 不再是玩家 Y 的权威，但草地、物件落点、水面仍在用它，两者一旦漂移会出现「草长在悬空处」这类问题。

## 3. 两端一致性

参照现有 `terrainParity.test.mjs` 的跨后端比对结构：

- 同一串输入分别在「客户端配置」与「服务端配置」下跑 `stepCharacter`，断言逐步状态逐位相同。
- 两端 keep 半径不同（服务端 2，客户端由场景定义给出、下限 3），collider 集合不同 → 显式覆盖这个差异，验证结果仍一致（探针已验证插入顺序偏差为 0，此处固化为回归）。
- Actor collider 的 yaw 转换往返测试：`simpleCollision` 局部坐标 ↔ Rapier 四元数，来回转换后误差 < 1e-6（该处 Z 轴符号与常规右手系相反，容易写错）。

## 4. 网络（Phase 4）

`tests/PlayerReconciler.replay.test.ts`：

- 零延迟：重放结果与原预测逐位相同，`pending` 残差恒为 0。
- 注入延迟与丢包：位置连续，无超过 `RECONCILE_SNAP_DISTANCE` 的跳变。
- 输入队列在长时间无 ack 时按上限裁剪，不无界增长。
- 幂等：同一个 ackTick 重复到达不改变状态。

## 5. 大世界约束

遵循 `.cursor/rules/large-world-compatibility.mdc`，新增断言：

- `PhysicsWorld.colliderCount` 在长距离跑图（跨若干 chunk）后保持在 `(2 × keepRadius + 1)²` 的上界内，不随行走距离增长。
- 远距离传送后无残留 collider（`ChunkResidency.focusSignature` 换集合的路径）。
- 负坐标区域的 chunk collider 与正坐标对称正确。
- 地形编辑后，受影响 chunk 及其东/北邻居都被重建，且未泄漏旧句柄。

## 6. 需要改写的既有测试

| 文件 | 原因 |
| --- | --- |
| `tests/TopDownController.test.ts` | 控制器职责收缩，位置相关断言全部失效 |
| `tests/PlayerReconciler.test.ts` | 和解从「误差平滑」变为「重放」 |
| `server/tests/PlayerJumpComponent.test.mjs` | `integrate` / `resolveGround` / `traversableStepHeight` 已删除 |
| `server/tests/ServerScene.test.mjs` | `resolvePlayerMovement` 已删除；boot 变异步 |
| `server/tests/ServerSceneWorldCollision.test.mjs` | 碰撞后端更换 |
| `server/tests/playerMovement.test.mjs` | `applyPlayerMovement` 不再负责位移 |
| `server/tests/*`（构造 `ServerScene` 的全部） | 需要 `await initRapier()` |
| `tests/CameraBoom.test.ts` | Phase 5 换查询后端 |

**`package.json` 的 `test:client` 脚本是手写的文件列表**，新增测试文件必须同步加进去，否则不会被执行。这一点很容易漏。

## 7. 人工验收清单

自动化测试之外，以下必须实机试玩确认：

- [ ] 低台 → 高台：走、跑、跳三种方式上去都不卡接缝
- [ ] 高台 → 低台：走出边缘是抛物线，不是垂直坠落也不是吸附
- [ ] 跳上石头、蘑菇菌盖、木筏甲板，都能站住并行走
- [ ] 各种 `RAMP_*` / `CORNER_*` 斜坡上下平顺
- [ ] 贴着树林与岩石行走，滑动手感自然，无抖动无卡顿
- [ ] 水中游动、上岸、跳入水中三个过渡平顺
- [ ] 镜头不穿地形、不穿树冠
- [ ] 地形编辑后立即在新地形上正确行走
- [ ] 弱网（150ms + 5% 丢包）下上述全部项目无瞬移
- [ ] 长时间跑图（跨 20+ chunk）后帧率与 collider 数量稳定

## 8. 完成定义

本次重写视为完成，当且仅当：

1. 三个已上报缺陷的回归用例全绿，且实机复验通过；
2. `npm run test:server`、`npm run test:client`、`npm run build` 全绿；
3. §7 人工清单全部勾选；
4. `PhysicsWorld.colliderCount` 的大世界上界断言通过；
5. 旧碰撞路径（`resolveTerrainMovement` 等）已从仓库删除，而不是留着不调用。
