# Phase 3：角色控制器接管（修掉三个缺陷）

> 上下文见 `player-collision-rewrite-00-overview.md`
> 依赖：Phase 1（门面）、Phase 2（地形 collider）
> 玩法行为变化：**这是关键阶段**。三个已上报缺陷在本阶段全部修复。

## 1. 目标

把物件碰撞体接入同一个 Rapier 世界，用 `stepCharacter` 取代现有的全部玩家移动/碰撞/落地逻辑，客户端与服务端同时切换。

本阶段结束时：
- 缺陷 A（跳上高台后卡在接缝、被瞬移）→ `enableAutostep` 解决
- 缺陷 B（走出悬崖被吸附）→ `enableSnapToGround` + 真实水平速度解决
- 缺陷 C（跳上石头/蘑菇被拉下来）→ 物件与地形进同一个 collider 集合解决

## 2. 交付物

### 新增

| 文件 | 职责 |
| --- | --- |
| `shared/physics/stepCharacter.mjs` | 唯一的一步模拟 |
| `shared/physics/characterState.mjs` | 角色运动状态容器（位置、速度、grounded） |
| `server/tests/stepCharacter.test.mjs` | 三个缺陷的回归用例 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `server/scene/ServerScene.mjs` | `applyInput` 改调 `stepCharacter`；删除 `resolvePlayerMovement`；`playerSupportHeightAt` 退出玩家 Y 权威路径 |
| `src/controllers/TopDownController.ts` | 只保留输入采集/朝向/相机；六个改位置的入口收敛 |
| `src/player/PlayerEntity.ts` | 接线改为 physics 句柄，不再传 `resolveCollision` / `sampleGroundHeight` |
| `src/rendering/SceneRenderer.ts:169` | 删除 `resolveSimpleCollision` 的玩家路径 |
| `shared/actor/components/PlayerJumpComponent.mjs` | 删除 `integrate` / `resolveGround` / `traversableStepHeight`，退化为参数容器 |
| `server/actors/ActorColliderIndex.mjs` | 同步维护 Rapier Actor collider |

### 删除

- `shared/world/terrainMovement.mjs` 的 `resolveTerrainMovement` / `footprintStepAllowed` / `traceTerrain`
  （`terrainMovementHeight` 保留：浮力支撑与水面逻辑仍在用）
- `shared/playerMovement.mjs` 的 `applyPlayerMovement` 位移职责
  （`sanitizeMoveInput` / `clampToPlayArea` / 角度工具保留）

## 3. 详细任务

1. **物件 collider 映射**

   `createSimpleCollisionFromRender` 的输出直接翻译，**不新增一套 authoring**：

   | 现有定义 | Rapier |
   | --- | --- |
   | `box` | `ColliderDesc.cuboid(halfWidth, (maxY - minY) / 2, halfLength)` |
   | `cylinder` | `ColliderDesc.cylinder((maxY - minY) / 2, min(halfWidth, halfLength))` |

   - 盒子中心 Y = `transform.y + (minimumY + maximumY) / 2`，别直接用 `transform.y`。
   - yaw 转成绕 Y 轴的四元数。注意现有 `simpleCollision.mjs` 的局部坐标换算里 Z 轴符号与常规右手系相反（`worldZ = transform.z - sinYaw * centerX + cosYaw * centerZ`），转换时要核对方向，写一个双向往返测试锁住。
   - `centerX/centerZ` 偏移进 collider 的局部平移。

   **顶面自动成为可站立表面**——缺陷 C 到这里就没了，无需任何额外代码。

2. **`ActorColliderIndex` 同步**

   现有实现每 tick 把 Actor 盒子刷进 `CollisionWorld`。改为同时（或改为）刷进 `PhysicsWorld.setActorCollider`。Actor 数量上限 256，成本可控。

   移动中的 Actor（木筏、掉落物）每 tick 更新 collider 位置；静止的跳过，避免无谓的 broad-phase 重建。

3. **`characterState.mjs`**

   ```js
   { x, y, z,            // y 是脚底高度（不含 offset）
     vx, vy, vz,
     grounded,
     jumpPressed }       // 上一步的按下状态，用于取边沿
   ```

   Rapier 刚体原点在几何中心，脚底 = `translation.y - halfHeight`，并且控制器保留 `CHARACTER_OFFSET = 0.02` 皮肤间隙。**对外暴露的 y 一律是扣掉 offset 的脚底高度**，换算只在 `stepCharacter` 内部做一次。做不到这一点玩家会稳定悬空 2cm。

4. **`stepCharacter.mjs`**

   ```js
   stepCharacter(state, input, dt, physics, params) {
     // 1. 水平速度
     //    grounded  → 趋向 输入方向 × speed（可加地面加/减速）
     //    airborne  → 按 airControl 趋向目标，保留既有动量  ← 缺陷 B 的惯性来源
     // 2. 跳跃：grounded 且本步有按下沿 → vy = impulse; grounded = false
     // 3. grounded ? vy = -GROUND_SNAP_PROBE
     //             : vy = max(-maxFallSpeed, vy - gravity * dt)
     // 4. controller.computeColliderMovement(collider, { x: vx*dt, y: vy*dt, z: vz*dt })
     // 5. body.setNextKinematicTranslation(pos + controller.computedMovement())
     // 6. physics.step()                      ← 不可省，见 Phase 1 §3.4
     // 7. grounded = controller.computedGrounded()
     //    if (grounded && vy < 0) vy = 0
   }
   ```

   - 纯函数式对待 `state`：读入、改写、返回，不在内部访问全局。
   - 跳跃按下沿在**这一步**取，不在输入采集处取——Phase 4 的输入重放依赖这一点。
   - `params` 全部来自 `characterParams.mjs` 与 Actor 原型，不接受调用方临时覆盖。

5. **服务端切换**

   `ServerScene.applyInput` 改为：

   ```
   校验 sequence / 时间预算（保留现状）
   → ensureAround（地形 + 静态碰撞 + 生成物件）
   → stepCharacter(...)
   → 写回 transform，更新 speed（改用真实 vx/vz 而非位移反推）
   ```

   删掉 `resolvePlayerMovement` 整个函数。`playerSupportHeightAt` **不再决定玩家 Y**，但保留给浮力与水面判定用（`isWaterAt` / `syncWaterMovementEffect` 仍需要它）。

   `update()` 里那段「非空中就把 y 重设为地表高度」的逻辑（`ServerScene.mjs:719` 附近）必须删除——它正是缺陷 B 的直接执行者。

6. **客户端切换**

   `TopDownController` 收敛为：输入采集 → 朝向解算 → 相机悬臂 → 把输入交给 `stepCharacter`。

   现有六个能改位置的入口按下表处理：

   | 入口 | 处置 |
   | --- | --- |
   | `setPosition` / `setVerticalPosition` | 仅保留给和解与传送，直接写 `characterState` 并同步刚体 |
   | `translate` / `translateVertical` | 同上，供 `PlayerReconciler` 使用 |
   | `resolveLanding` / `updateVerticalMotion` | **删除**，职责并入 `stepCharacter` |

   传送/瞬移时必须用 `body.setTranslation`（立即生效）而不是 `setNextKinematicTranslation`（下一步插值），否则会拖出一条穿墙轨迹。

7. **浮力与水**

   `PlayerBuoyancyHeightController` 与 `WaterMovementEffectController` 目前依赖「grounded + 地形支撑高度」。切换后 grounded 来自 Rapier，支撑高度不再由地形独占。本阶段先保持水面行为不变（仍用 `terrainMovementHeight` 判定是否在水里），水中浮力与角色控制器的融合留到 Phase 5，避免一次改动面过大。

## 4. 验收标准

对照三个缺陷逐条试玩验证，并固化为测试：

- [ ] **缺陷 A**：从低台走向 1m 高台，跳跃上去后**继续前进不卡在接缝**；全程无瞬移。
- [ ] **缺陷 B**：从高台边缘走出去，离地后**保留水平速度做抛物线下落**，不被吸附到下一格。
- [ ] **缺陷 C**：跳到石头/蘑菇上能**站住**，可在其顶面行走，走到边缘自然落下。
- [ ] 斜坡（`RAMP_*` 与 `CORNER_*` 形状）上下行走平顺，无抖动、无异常减速。
- [ ] 跳跃时头顶撞到盒子底面会停住，不穿过去。
- [ ] `npm run test:server` / `test:client` / `build` 全绿。

需要改写的现有测试：`tests/TopDownController.test.ts`、`server/tests/PlayerJumpComponent.test.mjs`、`server/tests/ServerScene.test.mjs`、`server/tests/ServerSceneWorldCollision.test.mjs`、`server/tests/playerMovement.test.mjs`。

## 5. 风险与注意

- **本阶段改动面最大**，建议拆成三个可独立回滚的提交：(a) 物件 collider 映射，(b) `stepCharacter` + 服务端切换，(c) 客户端切换。
- 客户端与服务端**必须在同一个提交里切换**（即 b 与 c 可以分提交但不能分别发布）。只切一端会让预测与权威跑在两套物理上，比现在更糟。
- **`airControl = 0.85` 的语义变了**：过去是缩放输入速度，现在是空中向目标速度收敛的强度。数值需要重新手感调优，不要直接沿用。
- 蘑菇菌盖此时仍无 collider（只有细根），所以「跳上蘑菇」在本阶段只对**有完整碰撞体的物件**（石头等）生效。菌盖 authoring 补齐排在 Phase 5，验收缺陷 C 时请用石头，并在 Phase 5 复验蘑菇。
- Rapier 的 `computedMovement()` 返回的是**允许的位移**而非目标位移，写回时要用它而不是原始 desired。
