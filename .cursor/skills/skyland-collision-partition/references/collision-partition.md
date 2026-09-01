# SkyLand 旧式 Simple-Collision 空间划分参考

这份文档只描述仍在服务非玩家 Actor simple-collision 的二维均匀网格。生产玩家移动、地形接地和相机 shape cast 已由 `shared/physics/PhysicsWorld.mjs` 的 Rapier 路径接管；不要把这里的圆形 XZ 推出重新接回玩家控制器。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `shared/collision/CollisionGrid.mjs` | 均匀网格宽相：插入、删除、局部查询、stamp 去重、oversized 列表。 |
| `shared/collision/CollisionWorld.mjs` | 静态分组与动态条目的生命周期，对非玩家调用窄相。 |
| `shared/collision/collisionBox.mjs` | 有向盒世界 AABB 和旧式扫掠辅助。 |
| `shared/collision/collisionLayers.mjs` | `MOVEMENT` / `CAMERA` authoring 位；Rapier mapper 也复用这些位。 |
| `shared/actor/simpleCollision.mjs` | 圆/有向盒窄相和 simple-collision authoring。 |
| `shared/world/chunkColliders.mjs` | 从确定性世界物件放置记录派生 authoring 实例。 |
| `src/actors/ClientActorSystem.ts` | 维护客户端 Actor simple-collision，并把同一 authoring 映射进 Rapier。 |
| `server/actors/ActorColliderIndex.mjs` | 维护 DS Actor simple-collision 索引。 |

## 唯一宽相规则

宽相只选择候选，不改变窄相答案。`CollisionWorld` 的结果必须与相同输入的全量 `resolveCircleAgainstSimpleCollisions` 一致。改变 cell size、query margin、layer filter、vertical profile 或去重方式后，必须保留 grid-vs-brute-force 等价测试。

网格仍适合当前非玩家路径，因为普通 collider 尺寸相近、动态条目按 Actor id 原地更新，空 cell 会立刻回收。三个资源上界不能破坏：

1. 单 collider 最多进入 `maximumCellsPerEntry` 个 cell，超大条目进入数量有界的 `oversized`；
2. 去重使用 entry stamp，不为每次查询创建 `Set`；
3. `CollisionWorld` 复用 candidate 数组，不把查询成本变成总世界面积的函数。

## 生命周期

| 类型 | key | 添加者 | 删除时机 |
| --- | --- | --- | --- |
| 静态组 | chunk key | `ChunkStreamer` / `ServerChunkColliders` | chunk 离开 keep radius |
| 动态条目 | actor id | `ClientActorSystem` / `ActorColliderIndex` | Actor 消失或 Component 卸载 |

同一个 authoring 实例可以同时进入 legacy grid 和 Rapier mapper，但两者职责不同：legacy grid 服务尚未迁移的 Actor-vs-Actor System；Rapier collider 服务玩家 KCC/相机。不要在 resolve 时临时扫描 ActorWorld 或新建第三条 collider 来源。

Actor collider 同步时序仍要覆盖“移动 System 之后、查询之前”。一个移动 Actor 的索引若落后一 tick，宽相会漏掉新位置，表现为高速物体穿透或从旧位置推出。

## Shape 与 layer authoring

`simpleCollision` 的盒/圆柱尺寸、局部中心、Y 区间和 yaw 是唯一 authoring 约定。物件模型改变时核对这里，再由 `simpleCollisionToPhysics.mjs` 翻译到 Rapier；不要维护两套手写尺寸。

Layer 要分别决定：树干一般属于 `MOVEMENT + CAMERA`，树冠可仅属于 `CAMERA`，草没有 collider。多部件支撑面（如蘑菇菌盖）由 Rapier mapper 生成额外薄 collider，legacy grid 不应靠放大整个外接盒模拟。

## 何时编辑这里

- 修改非玩家 Actor simple-collision 的 broad-phase 性能或等价性；
- 调整 cell 回收、oversized 纪律或动态 Actor 索引时序；
- 维护仍调用 `CollisionWorld.resolveCircle` 的 System。

下列任务改用主技能的 Rapier 路径：玩家跳跃/落地/台阶/斜坡、服务端位置校正、地形 trimesh、相机防穿模、玩家与 Actor 的碰撞结果。

## 验证

运行 `server/tests/collisionWorld.test.mjs` 中的去重、回收、grid-vs-scan 等价和动态更新覆盖，再运行 `npm run test:server`。若 authoring 同时影响 Rapier，追加主参考中的 `stepCharacter`、camera 和 collider residency 回归。
