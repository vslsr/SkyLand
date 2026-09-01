# Phase 2：地形三角网与 chunk collider 生命周期

> 上下文见 `player-collision-rewrite-00-overview.md`
> 依赖：Phase 1（`PhysicsWorld` 门面可用）
> 玩法行为变化：**无**。地形 collider 建起来了但还没有人查询它。

## 1. 目标

让 Rapier 世界里出现与**玩家看到的地形完全相同**的碰撞面，并让它随 chunk 流式加载/卸载与地形编辑正确增删。

核心命题：**碰撞面 = 渲染面**。现在两者是两套独立推导（渲染是三角网，碰撞是高度采样 + 启发式规则），这正是缺陷 A 的温床。

## 2. 交付物

### 新增

| 文件 | 职责 |
| --- | --- |
| `shared/world/terrainCollisionMesh.mjs` | 由地形格数据产出纯拓扑三角网（顶面 + 崖壁） |
| `server/scene/ServerTerrainColliders.mjs` | 服务端 chunk trimesh 常驻策略 |
| `server/tests/terrainCollisionMesh.test.mjs` | 拓扑正确性、崖壁闭合、边界所有权 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/models/terrain/createTerrainChunkGeometry.ts:223` | 顶点拓扑改为调用共享模块，自身只负责颜色/法线/描边/水面 |
| `src/world/ChunkStreamer.ts:318,349` | 除现有 `setStaticGroup` / `removeStaticGroup` 外，同步维护 trimesh collider |
| `server/scene/ServerScene.mjs` | 装配 `ServerTerrainColliders`，在 `update()` 里随玩家 `sync()` |
| `shared/world/terrainPatches.mjs` 的订阅方 | 编辑落地后重建受影响 chunk 的 trimesh |

## 3. 详细任务

1. **抽取共享拓扑**

   `createTerrainChunkGeometry` 已经在生成需要的东西，逐格：
   - 2 个顶面三角形，对角线由 `usesNorthWestSouthEastDiagonal(shape)` 决定；
   - 东边与北边共享边上的崖壁 quad（`southEast/northEast` 与邻格 `east[0]/east[3]` 高度不等时生成）。

   把这部分搬进 `shared/world/terrainCollisionMesh.mjs`：

   ```js
   buildTerrainCollisionMesh(chunkX, chunkZ, cellCodeAt)
   // → { vertices: Float32Array, indices: Uint32Array, triangleCount: number }
   ```

   - 顶点角高度用现成的 `terrainCellCornerHeight(code, cornerX, cornerZ)`。
   - **对角线选择必须与渲染逐字一致**，否则玩家会站在与看到的斜面差半格的位置。渲染侧改为调同一函数拿索引，从源头杜绝漂移。
   - 崖壁的边所有权规则沿用现状：每条共享边只由西侧或南侧格负责，跨 chunk 同样适用。这条规则不能改，否则相邻 chunk 会重复生成崖壁面，Rapier trimesh 出现重面会导致角色卡顿。

2. **崖壁必须向下闭合**

   渲染只需要看得见的那一片崖面，物理不同：角色从侧面撞过来时，如果崖壁只有相邻两格高度差那一段，脚底低于该段时会直接穿进去。崖壁 quad 的下边界要延伸到**相邻格的顶面高度**（现状即如此），并额外确认负高度层（水底 `heightLevel < 0`）也被覆盖。

   本阶段要显式验证：站在水底格与陆地格交界处，不会从崖壁下方钻进山体。

3. **不要用 Rapier Heightfield**

   `ColliderDesc.heightfield` 共享顶点，无法表达 1m 的垂直崖壁——它会把崖壁退化成一个跨越整格的陡三角面，玩家能直接走上去。必须用 `ColliderDesc.trimesh(vertices, indices)`。这条决策写进模块头注释，避免后来者「优化」回去。

4. **服务端常驻策略**

   照抄 `server/scene/ServerChunkColliders.mjs` 的结构，复用 `server/scene/ChunkResidency.mjs`：

   ```js
   new ChunkResidency({
     residentRadius, keepRadius,
     onLoad: (chunkX, chunkZ, key) => physics.setChunkCollider(key, buildTerrainCollisionMesh(...)),
     onUnload: (key) => physics.removeChunkCollider(key),
   })
   ```

   - 半径取值与 `ServerChunkColliders` 对齐（`residentRadius = 1`、`keepRadius = 2`），保证玩家脚下与前方一圈始终有地形碰撞。
   - `ServerScene.update()` 里在 `chunkColliders.sync()` 旁边调 `terrainColliders.sync()`。
   - **`applyInput` 里也要 `ensureAround()`**：现有代码已经为静态碰撞这么做了（`ServerScene.mjs:566` 附近的 `chunkColliders.ensureAround`），地形 trimesh 必须同样处理，否则刚跨过 chunk 边界的那一步会踩空。

5. **客户端常驻策略**

   `ChunkStreamer` 已经在 `setStaticGroup`/`removeStaticGroup` 的同一位置管理 chunk 生命周期，在那里挂上 trimesh 的增删即可，不要新起一套 residency。

   注意两端的 keep 半径不同：服务端是 `ServerChunkColliders` 的 `DEFAULT_KEEP_RADIUS = 2`，客户端由场景定义 `SceneDefinition.keepRadius` 给出（`chunkStream.mjs:46` 以 `CHUNK_KEEP_RADIUS = 3` 为下限）。两端 collider 集合因此不同——探针已验证**插入顺序与集合差异不影响结果**（最大偏差 0），因为角色控制器只取最近命中。但玩家附近那一圈必须两端都有，这是正确性前提。

6. **地形编辑重建**

   `shared/world/terrainPatches.mjs:171` 已有 `subscribe(listener)`。订阅后：
   - 一次编辑改的是单格 → 重建该格所在 chunk 的 trimesh；
   - 格子位于 chunk 边界时，**相邻 chunk 的崖壁也会变**（边所有权规则决定崖壁挂在西/南侧格上）→ 要一并重建东侧与北侧邻居。漏掉这一条会留下一堵看不见的墙。
   - 重建是整块替换（`setChunkCollider` 幂等），不做增量。1024 tri 的重建成本远低于维护增量的复杂度。

## 4. 大世界约束

遵循 `.cursor/rules/large-world-compatibility.mdc`：

- collider 数量上界 = `(2 × keepRadius + 1)²` 个 chunk，与世界面积无关。测试中断言这个上界。
- 负坐标：`Math.floor` 的取整方向已在 `terrainCellCodeAtMillimeters` 中处理，新模块沿用同一约定，不要重新实现。
- 远距离传送：`ChunkResidency` 的 `focusSignature` 会整体换掉常驻集合，验证不会残留旧 chunk 的 collider。

## 5. 验收标准

- [ ] 新增 `terrainCollisionMesh.test.mjs`：给定固定 seed 的 chunk，三角数与预期一致；每条崖壁边只出现一次（无重面）；跨 chunk 边界的崖壁不重复。
- [ ] 渲染回归：改造后地形外观与改造前逐像素无差异（或至少肉眼无差异 + 顶点数一致）。
- [ ] `PhysicsWorld.colliderCount` 在长距离跑图后保持有界，不随行走距离增长。
- [ ] 编辑一格地形后，受影响 chunk 及其东/北邻居的 collider 都被重建。
- [ ] `npm run test:server` / `test:client` / `build` 全绿。

## 6. 风险与注意

- **渲染与物理的对角线不一致**是本阶段最容易踩的坑，且症状隐蔽（玩家轻微悬空或陷入斜面）。用「渲染侧改为调用共享模块」从结构上消除，而不是靠两边各写一遍再比对。
- **trimesh 重面**会让角色控制器在接缝处抖动。边所有权规则是唯一防线，测试必须覆盖跨 chunk 的情况。
- `sampleTerrain` 在本阶段仍是玩家 Y 的权威（Phase 3 才切换），所以本阶段的 trimesh 即使有错也不会立刻表现出来——**必须靠测试而不是靠试玩来验收**。
