# Phase 1：Rapier 运行时与 PhysicsWorld 门面

> 上下文见 `player-collision-rewrite-00-overview.md`
> 依赖：无（首个阶段）
> 玩法行为变化：**无**。本阶段结束后游戏表现与现在完全一致，只是多了一个尚未被使用的物理世界。

## 1. 目标

把 Rapier 引入两端，并用一个门面把它包起来，使后续阶段只依赖门面而不直接触碰 Rapier API。本阶段刻意**不接管任何玩法逻辑**，以便单独验证「引入 Rapier 不破坏现有东西」。

## 2. 交付物

### 新增

| 文件 | 职责 |
| --- | --- |
| `shared/physics/RapierRuntime.mjs` | `initRapier()` 单例；缓存已初始化的 RAPIER 句柄；两端各自注入自己的包 |
| `shared/physics/PhysicsWorld.mjs` | `World` 门面，见 §4 |
| `shared/physics/characterParams.mjs` | 两端共用的控制器常量 |
| `shared/physics/index.mjs` | 子系统公共入口（遵循 `module-boundaries` 规则） |
| `server/tests/rapierRuntime.test.mjs` | init 幂等、门面增删、step 后查询可见 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `package.json` | 新增 `@dimforge/rapier3d-compat@0.20.0`（与已有 `@dimforge/rapier3d` 同版本） |
| `server/rooms/room-worker.mjs:29` | `initialize()` 改异步，构造 `ServerScene` 前 `await initRapier()` |
| `server/scene/ServerScene.mjs` | 构造函数接收已初始化的 physics 句柄；**不**在内部做异步初始化 |
| `server/tests/*.test.mjs`（构造 `ServerScene` 的那些） | 测试前 `await initRapier()` |
| `src/scenes/GrasslandScene.ts` | 场景装载路径上 `await initRapier()` |

## 3. 详细任务

1. **依赖**
   - `npm i @dimforge/rapier3d-compat@0.20.0`。锁死精确版本，与 `@dimforge/rapier3d` 保持一致——两者内嵌的 wasm 逐字节相同，版本一旦漂移这个前提就没了。
   - 提交 lockfile 时确认 npm 版本不低于生成该 lockfile 的版本，避免可选依赖的 `libc` 字段被旧 npm 抹掉。

2. **`RapierRuntime.mjs`**
   - 导出 `initRapier(loader)`：接收一个返回 RAPIER 模块的 loader，内部缓存 `Promise`，重复调用返回同一个实例。
   - 客户端 loader：`() => import('@dimforge/rapier3d')`（bundler 版，wasm 由 Vite 单独产出，可流式编译与缓存）。
   - 服务端 loader：`() => import('@dimforge/rapier3d-compat').then(async (m) => { await m.init(); return m; })`。
   - 各端在自己的 bootstrap 里注入 loader，`shared/` 内部不出现任何具体包名——否则服务端会把 bundler 版拖进来直接崩。
   - 导出 `getRapier()` 供同步路径使用；未初始化时抛出明确错误，不要静默返回 `undefined`。

3. **`characterParams.mjs`**
   - 常量取自探针验证过的值，两端共用，禁止任一端本地覆盖：

     | 常量 | 值 | 依据 |
     | --- | --- | --- |
     | `CHARACTER_OFFSET` | `0.02` | 皮肤间隙；探针中脚底停在 1.02 |
     | `AUTOSTEP_MAX_HEIGHT` | `0.35` | 见 `07-followups.md`：原定的 `1.05` 让 1m 崖壁和一切矮物件都变成免费台阶 |
     | `AUTOSTEP_MIN_WIDTH` | `0.15` | 台阶上方需要的净空 |
     | `SNAP_TO_GROUND_DISTANCE` | `0.25` | 走下小坡不弹跳，超过即离地下落 |
     | `MAX_SLOPE_CLIMB_ANGLE` | `60°` | 地形斜坡实际约 26.6°，留足余量 |
     | `MIN_SLOPE_SLIDE_ANGLE` | `50°` | 低于爬升角，避免在斜坡上自动下滑 |
     | `GROUND_SNAP_PROBE` | `0.1` | 贴地时每步的小下压量 |

   - 同时导出玩家胶囊/圆柱尺寸的换算：现有 `createSimpleCollisionFromRender` 对 `line-art-player-slime` 产出 `cylinder(radius=0.42, minimumY=0, maximumY=0.84)` → Rapier `ColliderDesc.cylinder(halfHeight=0.42, radius=0.42)`，刚体原点在**几何中心**，脚底 = `translation.y - 0.42`。这个换算只此一处，别在调用点重复。

4. **`PhysicsWorld.mjs` 门面**（API 见 §4）
   - 内部持有 `RAPIER.World`（重力设 `{x:0,y:0,z:0}`——重力由 `stepCharacter` 自己积分，不交给 Rapier）。
   - 维护 `Map<key, ColliderHandle[]>`（chunk 分组）与 `Map<id, ColliderHandle>`（Actor），语义对齐现有 `CollisionWorld` 的 `setStaticGroup` / `setDynamic`，方便 Phase 2–3 平移。
   - `step()` 内部调 `world.step()`。**探针已证实：不 step 则新插入的 collider 对查询不可见。** 这条要写成代码注释，别让后来者以为可以省。
   - `dispose()` 释放 World 与所有句柄。

5. **异步 boot**
   - `room-worker.mjs` 的 `initialize()` 变 `async`，`process.on('message')` 里对它做 `void initialize(message).catch(...)`，失败要 `send({type:'room:error'})` 而不是静默吞掉。
   - 注意 `initialize()` 现有的 `if (scene) return` 早退：改异步后要防重入（加 `initializing` 标志），否则并发两条 `room:initialize` 会建出两个 scene。
   - `room:ready` 必须在 init 完成后才发，否则网关会向尚未就绪的房间投递输入。

6. **测试适配**
   - `server/tests/` 中构造 `ServerScene` 的文件统一在 `before()` 里 `await initRapier(serverLoader)`。
   - 客户端 `tests/` 暂不受影响（Phase 3 才切换 `TopDownController`）。

## 4. `PhysicsWorld` API 契约

```js
class PhysicsWorld {
  constructor(rapier)                       // 注入已 init 的 RAPIER 句柄

  // 角色
  createCharacter(id, { x, y, z, radius, halfHeight })  // → { body, collider, controller }
  removeCharacter(id)

  // chunk 静态几何（Phase 2 用）
  setChunkCollider(key, { vertices: Float32Array, indices: Uint32Array })
  removeChunkCollider(key)

  // Actor 盒子（Phase 3 用）
  setActorCollider(id, { shape, halfWidth, halfLength, minimumY, maximumY,
                         x, y, z, yaw })
  removeActorCollider(id)

  step()                                     // 每 tick 必调，见 §3.4
  dispose()

  get colliderCount()                        // 调试面板与 large-world 上界断言用
}
```

设计约束：

- 门面**不**暴露 `RAPIER.World` 本体。所有 Rapier 类型止步于 `shared/physics/`。
- `setXxxCollider` 是幂等替换语义（先删后建），与现有 `CollisionWorld.setStaticGroup` 一致。
- 角色刚体用 `kinematicPositionBased`，通过 `setNextKinematicTranslation` 推进。

## 5. 验收标准

- [ ] `npm run test:server` 与 `npm run test:client` 全绿。
- [ ] `npm run build` 通过；确认 Vite 产物里 wasm 是单独 chunk 而非内联 base64。
- [ ] 手动跑 `npm start`，进游戏走动/跳跃，**行为与重构前完全一致**（本阶段不接管任何玩法）。
- [ ] 新增测试覆盖：`initRapier()` 重复调用返回同一实例；`setChunkCollider` 后 `step()` 再查询能命中，不 `step()` 查不到（把探针结论固化成回归用例）。
- [ ] 房间进程冷启动日志中 `room:ready` 晚于 Rapier init 完成。

## 6. 风险与注意

- **别在 `shared/` 里直接 import 具体的 rapier 包名。** 服务端一旦拉到 bundler 版会因 `.wasm` 无法作为 ESM 加载而崩溃，且报错信息很不直观。
- **别用 Rapier 的重力。** 重力必须由 `stepCharacter` 自己积分，否则客户端预测与服务端重放的浮点路径会分叉。
- **`world.step()` 的 timestep** 设为固定值（Phase 4 会统一到 1/60），本阶段先设 `1 / SERVER_TICK_RATE`，并在注释里标记待 Phase 4 收敛。
- 客户端包体会因此增加约 2.0MB，如果这一条不可接受，应在本阶段结束前回退到方案 A，而不是继续往下做。
