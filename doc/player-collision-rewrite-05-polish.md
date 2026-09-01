# Phase 5：收尾——相机、authoring 补齐、真实速度

> 上下文见 `player-collision-rewrite-00-overview.md`
> 依赖：Phase 3（角色控制器已接管）、Phase 4（网络已收敛）
> 玩法行为变化：镜头不再穿模；蘑菇等物件可站立；动画不再抖。

## 1. 目标

清理前四个阶段刻意推迟的遗留项，并把最后一处仍在使用旧碰撞路径的系统（相机悬臂）迁走，使 `CollisionWorld` 可以整体退休或降级为纯查询工具。

## 2. 任务清单

### 5.1 相机悬臂迁移到 Rapier

现状：`src/camera/CameraBoom.ts` 通过 `SceneRenderer.sweepCameraProbe` 调 `CollisionWorld.sweepSphere`，走 `COLLISION_LAYER.CAMERA` 层。

改为 `PhysicsWorld` 上的 `castShape`：

```js
world.castShape(shapePos, shapeRot, shapeVel, shape, targetDistance,
                maxToi, stopAtPenetration, filterFlags, filterGroups, ...)
```

- 用 Rapier 的 `InteractionGroups` 表达现有的 `COLLISION_LAYER`（MOVEMENT / CAMERA 等），映射关系集中定义一处。
- 地形 trimesh 也要参与相机遮挡——现状相机只避让物件不避让地形，镜头会切进山体。迁移后这个老问题顺带修掉。
- 保留现有的悬臂收缩平滑逻辑，只换查询后端。
- `tests/CameraBoom.test.ts` 相应改写。

迁移完成后 `CollisionWorld` / `collisionBox.mjs` / `simpleCollision.mjs` 的推出路径已无调用方：
- `resolveCircleAgainstSimpleCollisions` 可删；
- `createSimpleCollisionFromRender` **保留**——它仍是 collider 尺寸的 authoring 来源，Phase 3 只是改了消费方；
- `CollisionGrid` 若无其它使用者可删，删前全仓搜索确认（交互查询、调试绘制可能还在用）。

### 5.2 物件 authoring 补齐

| 物件 | 现状 | 改动 |
| --- | --- | --- |
| `line-art-elastic-mushroom` | 只有 `halfWidth: radius * 0.4` 的细根，菌盖无碰撞 | 增加菌盖 collider（薄圆柱，位于 `height` 附近），使其可站立 |
| `line-art-fruit-tree` / `generated-tree` | 树冠是否可站需确认 | 按玩法意图决定：可站则加顶面 collider，不可站则维持 |
| `line-art-raft` | `minimumY: -0.24, maximumY: 2.3` | 确认玩家能站上甲板而不是被 2.3m 的盒子整个挡住——这个高度值在旧的「只挡不踩」语义下合理，在新语义下需要重新审视 |

**注意**：`createSimpleCollisionFromRender` 里注释写着菌盖不加碰撞是为了「不形成隐形墙」。在旧语义下这是对的（盒子只挡不踩）；新语义下盒子顶面可站，原顾虑消失。改动时更新该注释，说明语义已变。

这一项直接关系到缺陷 C 的完整验收——Phase 3 只用石头验证过，蘑菇要在这里复验。

### 5.3 真实速度上报

- 服务端 `player.speed = distance / granted`（位移反推）改为 `Math.hypot(state.vx, state.vz)`。撞墙时速度不再假性掉到 0，行走动画不抖。
- 客户端 `TopDownController.movementSpeed` 同样改用 `characterState` 的速度，删掉现有的指数平滑（`currentSpeed += (speed - currentSpeed) * ...`）——那是为了掩盖位移反推的抖动而存在的，根因消失后它只会引入延迟。
- `PlayerEntity.update` 传给 `visual.update` 的 `velocityX/velocityZ` 改用真实速度分量，而不是 `input.move.x * movementSpeed`。

### 5.4 浮力与水中运动融合

Phase 3 刻意保持水面行为不变。本阶段处理：

- 水中时角色控制器的 grounded 语义模糊（浮在水面不算站在地上）。方案：水中禁用 `snapToGround`，改由 `PlayerBuoyancyHeightController` 提供垂直支撑，水平仍走 `computeColliderMovement`。
- `WaterMovementEffectController` 的 `inWater` 判定继续用 `terrainMovementHeight` / `isWaterAt`，不依赖 Rapier。
- 验收：在水里游动、上岸、从岸上跳进水里三个过渡都平顺。

### 5.5 天花板与头顶

Rapier 的角色控制器已经处理了向上的碰撞，但要确认：
- 跳跃撞到盒子底面时 `vy` 归零（不要靠 grounded 判定，那是向下的）；
- 从 `computedCollision(i)` 读法线判断是否为顶部接触。

### 5.6 调试可视化

`src/debug/` 下增加物理世界的调试绘制，用 Rapier 的 `world.debugRender()` 输出线段。这是后续排查碰撞问题的基础设施，值得在这一阶段建起来。注意受 `large-world-compatibility` 约束：只绘制玩家周围一圈，不要全世界。

## 3. 验收标准

- [ ] 镜头不再穿进地形与树冠；悬臂收缩平滑无跳变。
- [ ] 跳上蘑菇菌盖能站住（缺陷 C 完整验收）。
- [ ] 贴墙行走时行走动画不抖。
- [ ] 水中/岸边三个过渡平顺。
- [ ] 跳跃撞头顶时立即下落，不粘在天花板上。
- [ ] 调试绘制可开关，且 collider 数量有界。
- [ ] `npm run test:server` / `test:client` / `build` 全绿。

## 4. 风险与注意

- **相机迁移会改变镜头手感**（地形开始参与遮挡）。这是修 bug 而非回归，但需要试玩确认收缩不过于激进；必要时给地形层单独的 `targetDistance`。
- **删 `CollisionGrid` 前务必全仓搜索**。交互系统、调试面板、草地互动都可能在用，误删会在运行时才暴露。
- 5.4 的浮力融合是本阶段最不确定的一项。若时间紧张，可以只做「水中禁用 snapToGround」这一条最小改动，其余留作后续，但要在文档里记下欠账。
