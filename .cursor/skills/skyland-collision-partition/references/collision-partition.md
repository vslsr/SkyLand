# SkyLand 碰撞空间划分参考

树、石头、船和玩家都在同一张均匀网格上做碰撞查询。这份文档记录这套东西的模块划分、每一条上界为什么成立、相机悬臂的三条不变量，以及它被接受时的实测数字。

## 模块地图

| 模块 | 职责 |
| --- | --- |
| `shared/collision/CollisionGrid.mjs` | 均匀网格宽相。插入、删除、AABB/圆查询，stamp 去重，oversized 列表。 |
| `shared/collision/CollisionWorld.mjs` | 场景碰撞世界。静态分组 + 动态条目，对外提供 `resolveCircle` 与 `sweepSphere`。 |
| `shared/collision/collisionBox.mjs` | 有向盒的世界包围盒与扫掠球求交。唯一做三维运算的地方。 |
| `shared/collision/collisionLayers.mjs` | `MOVEMENT` / `CAMERA` 位掩码。 |
| `shared/actor/simpleCollision.mjs` | **窄相**。先按玩家垂直轮廓/可跨越高度过滤，再做圆对有向盒的两轮 XZ 推出。 |
| `shared/world/chunkColliders.mjs` | 由整数放置记录派生静态碰撞盒。纯函数，没有 WASM 对应实现。 |
| `src/world/ChunkStreamer.ts` | chunk 装载/卸载时整组进出静态碰撞体。 |
| `src/actors/ClientActorSystem.ts` | 每帧把 Actor 的盒子刷进网格。 |
| `src/rendering/SceneRenderer.ts` | 推出与相机探针的统一入口。 |
| `src/camera/CameraBoom.ts` | 第三人称相机悬臂。 |
| `src/controllers/TopDownController.ts` | 把悬臂比例应用到机位。 |
| `server/scene/ServerChunkColliders.mjs` | 房间 DS 侧的静态碰撞常驻策略。 |
| `server/actors/ActorColliderIndex.mjs` | ActorWorld System，tick 内与 tick 末各同步一次。 |
| `server/scene/ServerScene.mjs` | 玩家推出与出生点推出。 |

## 为什么是均匀网格

不是四叉树，也不是 BVH：

- 这个世界的碰撞体尺寸相近、分布均匀，均匀网格的最坏情况和平均情况几乎一样。
- 插入与删除是 O(1)。每帧刷新的动态 Actor 不需要重建任何树，这是决定性的。
- 格子按需创建、空了立刻回收，内存跟着「已加载的碰撞体」走，不跟世界面积走。

三条上界纪律：

1. 单个碰撞体最多登记进 `maximumCellsPerEntry`（默认 16）个格子；更大的进 `oversized` 列表，每次查询无条件访问。列表长度因此是「异常大的碰撞体数量」，不是它们覆盖的面积。
2. 查询去重靠每条记录上的 `stamp`：查询前自增全局计数，访问过的打上当前值。没有 Set，没有临时数组。
3. `CollisionWorld.candidates` 是复用数组，推出查询不产生临时对象。

### 推出查询的外扩

`resolveCircle` 用 `radius × 3` 的范围取候选，而不是 `radius`。理由：推出会把点挪走，挪走之后可能贴上另一个原本不在范围里的盒子；一次推出的位移不超过一个直径，按半径两倍外扩足够覆盖两轮迭代，候选集合在整个解算过程中保持不变。这正是「网格结果必须等于全量遍历」的前提，改小了就会在盒子角落处出现网格漏判。玩家查询还会把同一份 `verticalProfile` 转交窄相：顶部不高于 `minimumY + maximumStepHeight` 的低台阶被忽略，垂直不重叠的悬空盒也不会形成隐形墙。

## 静态碰撞不走网络

`chunkColliders.mjs` 把 `shared/world/chunkContent.mjs` 已经算好的整数放置记录翻译成盒子，**不引入任何新的随机性**。因此浏览器与房间 DS 从同一个 `(worldSeed, chunkX, chunkZ)` 得到同一批盒子，静态碰撞和静态几何体一样一个字节都不用同步。客户端预测不会出现「本地被树挡住、服务端不知道有树」的反复拉扯。

房间 DS 需要 `worldSeed`：由 `RoomProcessManager` 随 `room:initialize` 下发，`room-worker` 传给 `ServerScene`。

### 碰撞模板

尺寸取自 `src/models/` 的线稿模型，改了模型就要回来核对：

| 物件 | 盒子 | 层 | 依据 |
| --- | --- | --- | --- |
| 树干 | 半径 0.22 m、y 0–1.3 | MOVEMENT + CAMERA | `createTreeModel` 的圆柱底部半径 0.17，略放大避免贴着树皮抖动 |
| 树冠下半 | 半径 1.2 m、y 0.6–2.4 | CAMERA | 最宽的两层锥体；`ConeGeometry` 底面在下，所以最宽处就在 0.6 m |
| 树冠上半 | 半径 0.8 m、y 2.4–4.0 | CAMERA | 越往上越细，两段比一个大盒子贴合得多 |
| 岩石 | 0.48 × 0.40 m、y 0–0.46 | MOVEMENT + CAMERA | 二十面体 r=0.42 缩放 (1.15, 0.62, 0.94) 后上移 0.2 |
| 草 | 无 | — | 一片能推开玩家的草地不合理，也会让碰撞体数量翻几倍 |

放置记录里的 `scale` 会等比乘到所有尺寸上。

树冠不参与推出的理由和弹性蘑菇一样（见 `createSimpleCollisionFromRender` 里 `line-art-elastic-mushroom` 的注释）：放置格只有 4 米，两米多宽的树冠若也挡路，林子里会寸步难行。

## 常驻策略

| | 客户端 | 房间 DS |
| --- | --- | --- |
| 谁维护 | `ChunkStreamer` | `ServerChunkColliders` |
| 跟谁走 | 场景配置的 `loadRadius` / `keepRadius` | 每名玩家所在 chunk，`residentRadius=1` / `keepRadius=2` |
| 上界 | keepRadius 内的 chunk 数 | 玩家数 × 25 个 chunk |
| 何时重算 | 跨过 chunk 边界时 | 焦点 chunk 集合的签名变化时 |

两侧都必须 `keepRadius > loadRadius/residentRadius`，否则站在边界上来回走会让同一批碰撞体反复建了拆。

`ServerScene.applyInput` 会先 `chunkColliders.ensureAround(next.x, next.z)`：玩家刚加入、瞬移或刚跨界时，下一次 `sync` 之前就可能要查询。常驻时它只是一次 Map 查询——整块 3×3 是一起装载的，中心在就说明邻居也在。

出生点也走一次推出：按槽位算的固定圆周未必避得开树，不推一下新玩家会卡在树干里等第一条输入。

## Actor 碰撞体的同步时机

`ActorColliderIndex` 在 ActorWorld 的系统序列里出现**两次**：

1. `VesselMotorSystem` 之后、`ActorSimpleCollisionSystem` 之前 —— 船已经移动完，推出解算的宽相必须拿到这一 tick 的位置。
2. 全部系统之后 —— 玩家输入是在两个 tick 之间结算的，那时查询到的必须是 `AttachmentSystem` 解算完的最新位置。

漏掉第一次，船的宽相会用上一 tick 的包围盒选候选；漏掉第二次，玩家推出会比 Actor 慢一拍。两次都是同一个实例，缓存按 actorId 复用，重复执行幂等。

`ActorSimpleCollisionSystem` 用 `accept` 回调排除自己和挂在自己身上的货箱（靠实例上的 `actor` 字段识别），否则船会被自己的货推走。没有 `world.context.collision` 时退回逐个遍历，直接 `new ActorWorld()` 的单元测试因此照常可用。

## 相机悬臂

穿模的根源是机位 = 角色位置 + 固定偏移，这条表达式里没有世界。悬臂把它当成一根杆子，每帧扫掠一个球，撞上就收短。

三条不变量，不要「简化」掉：

1. **每帧按全长扫掠**，不是按当前收缩后的长度。否则收回去的悬臂再也不知道自己可以伸多远。
2. **收立即、放平滑。** 收晚一帧就是穿模一帧；放太快是画面猛跳，贴着树跑动时会变成来回抽搐。
3. **只改长度不改方向。** 相机三轴、`projectPointerToGameplayPlane` 的射线、朝向解算因此都不受影响。会转向的悬臂会把鼠标投影一起弄坏。

窄相是「线段 vs 按探针半径外扩的有向盒」的 slab 求交。外扩后的盒子在角上是方的不是圆的，贴着盒角掠过时会比真实的球早一点判定命中——这个误差方向对镜头是安全的。

参数与取舍：

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `probeRadius` | 0.32 | 决定镜头离墙留多少空隙，要和 `PerspectiveCamera` 的 near 匹配 |
| `minimumRatio` | 0.25 | 树冠最宽处就在离地 0.6 m，贴树站着确实站在枝叶底下，悬臂会一路收到下限；下限太小会贴脸 |
| `extendSpeed` | 2.4 | 每秒恢复的比例 |
| `CAMERA_PIVOT_HEIGHT` | 0.25 | 史莱姆胸口。再抬高会把支点送进树冠里 |

**已知的手感取舍**：密林里贴树行走会比较频繁地把镜头拉到下限。要缓解，两个旋钮是抬高树冠盒子的 `minimumY`（容忍擦过树冠边缘）或调 `minimumRatio`。另一条路是让遮挡的树淡出而不是拉近镜头，那是另一套方案，不在这套东西的范围内。

瞬移（`RECONCILE_SNAP_DISTANCE` 触发的和解）会调 `ReconcilerTarget.resetCamera`，不把上一处的收缩量带到新位置。

## 实测数字

取数环境：Node 22，`shared/collision` 单独压测，非游戏内。

**查询成本与世界大小无关。** 查询点固定在原点附近 32 米见方，只放大世界：

| 世界 | 碰撞体 | 网格推出 | 逐个遍历 |
| --- | --- | --- | --- |
| 96 × 96 m | 295 | 843 ns | 8.1 µs |
| 224 × 224 m | 1 084 | 725 ns | 27.6 µs |
| 544 × 544 m | 7 678 | 793 ns | 254 µs |
| 1568 × 1568 m | 66 512 | 403 ns | 2.4 ms |
| 3872 × 3872 m | 406 843 | 610 ns | 15.2 ms |

**实际驻留量：**

| 场合 | 驻留 | 碰撞体 | 格子 | 备注 |
| --- | --- | --- | --- | --- |
| 客户端 keepRadius=3 | 49 chunk | 1 084（挡走路 466） | 473 | 平均每格 2.3 个 |
| DS，16 人散开 | 144 chunk | 3 465 | 1 488 | 堆约 1.7 MB |

推出查询的候选数：平均 0.1 个、最坏 2 个，而全量是 466 个。

**新增开销：**

| 项 | 成本 | 占比 |
| --- | --- | --- |
| 网格推出 | 0.70 µs/次 | — |
| 相机扫掠 | 1.17 µs/次 | — |
| chunk 装载碰撞体（客户端，放置记录已存在） | 25 µs/chunk | 每帧限额 1 个，约帧预算 1.5% |
| 16 人同时跨界的一次重算 | 873 µs | 20 Hz tick 预算的 1.7%，不跨界的 tick 直接返回 |

改动可能影响成本时请重新测，不要照抄这张表。

## 已知缺口

- **网格是二维的（XZ）。** 现在的世界是一张平地插物件，二维是对的。多层建筑或洞穴出现时，同一格会堆上所有楼层，那时才需要 Y 方向的划分。
- **服务端没有客户端那样的每 tick 构建限额。** 873 µs 是一次性尖峰而不是摊平的。玩家更多或密度更高之后，补法和 `CHUNK_BUILD_BUDGET_PER_FRAME` 一样。
- **格子 key 是 `${cellX}:${cellZ}` 字符串**，每访问一个格子分配一个。每次查询 1–12 个短字符串，与世界大小无关，但确实是 GC 抖动。要压掉就把 key 换成整数编码。
- **世界当前被 `WORLD_CHUNK_RADIUS = 8` 封在 512 × 512 m。** 上表里 1568 m、3872 m 的数据是把碰撞世界单独拿出来压的，游戏没跑过那个尺寸。这个常量只存在于 `shared/world/worldConfig.mjs`，Rust 侧没有对应物（放置算法不对世界边界分支），所以调大它不需要重建 WASM。
- **调试菜单只画 Actor 碰撞盒**（`ThreeObjectComponent` 的 helper），没画 chunk 静态盒子。验收碰撞形状时看不见盒子，只能靠走位试。
