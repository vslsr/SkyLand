# SkyLand 流式大世界参考

场景配置里出现 `renderer.world` 就表示这张地图是流式大世界：地面与物件不再摆在场景里，而是由世界种子确定性推导、按 chunk 加载。房间创建时分配 32 位 `worldSeed`，随房间摘要下发，客户端据此算出与服务端一致的世界。

网络上因此只需要传活动实体，静态内容一个字节都不用同步。这也是后续做范围同步（AOI）的前提。

## 模块地图

| 模块 | 职责 |
| --- | --- |
| `shared/world/worldConfig.mjs` | 世界与 chunk 的尺寸约定、放置格划分、物件种类、默认种子。所有流式场景共用。 |
| `shared/world/hash.mjs` | 整数哈希与定点值噪声。全程不碰浮点。 |
| `shared/world/chunkKey.mjs` | 世界坐标、chunk 坐标与 chunk key 之间的换算，以及半径查询。 |
| `shared/world/chunkContent.mjs` | 放置算法的 JS 参考实现。输出整数放置记录。 |
| `shared/world/chunkStream.mjs` | 加载/卸载计划。纯函数，没有 WASM 对应实现。 |
| `shared/world/chunkGenerator.mjs` | 生成后端接口定义 + 纯 JS 后端（参考实现与降级路径）。 |
| `shared/world/chunkGeneratorWasm.mjs` | WASM 后端包装，负责模板上传与结果切片。 |
| `shared/world/wasm/chunkgen.wasm` | 签入仓库的编译产物。改了 Rust 必须重新构建并一起提交。 |
| `native/chunkgen/` | `no_std` Rust crate：放置算法 + 逐顶点合批。 |
| `src/world/ChunkStreamer.ts` | 场景系统。按焦点规划加载、限额构建、释放显存。 |
| `src/world/ChunkView.ts` | 单个 chunk 的 Three.js 对象与释放。 |
| `src/world/loadChunkGenerator.ts` | 取生成后端：WASM 优先，失败降级 JS。 |
| `src/models/chunkTemplates.ts` | 把 `src/models/` 的线稿模型拍平成模板并注册。 |
| `src/models/chunkMesh.ts` | 合批结果 → BufferGeometry，以及逐场景的填充材质。 |

## 确定性契约

放置算法在两处实现，必须逐位一致：`shared/world/chunkContent.mjs` 与 `native/chunkgen/src/placement.rs`。

保证一致的手段是**全程整数运算**：

- 坐标用毫米、朝向用毫弧度、缩放用千分数，全部是 `i32` / `u32`。
- JS 的 `Math.imul` 与 Rust 的 `wrapping_mul` 是同一个 32 位截断乘法；`>>>` 与 u32 的 `>>` 都是逻辑右移；`>>` 与 i32 的 `>>` 都是算术右移。
- 除以 1000 只发生在最后的消费端，两边都是同一个 IEEE 754 结果。

`server/tests/chunkGenerator.test.mjs` 在 81 个 chunk 上比对两个后端的放置记录，逐位不一致就报红。**只改一侧、或者忘了 `npm run build:wasm`，都会被它抓住。**

顶点数值允许有约 1e-6 的差异：Rust 侧用的是自己实现的多项式三角函数（`native/chunkgen/src/math.rs`），与 `Math.sin` 有极小偏差。这只影响朝向的呈现，不影响放置，测试对这一项用的是容差而不是逐位比较。

## 必须成对修改的常量

| JS | Rust | 说明 |
| --- | --- | --- |
| `CHUNK_SIZE_MM`（`worldConfig.mjs`） | `CHUNK_SIZE_MM`（`placement.rs`） | chunk 边长（毫米）。 |
| `PROP_GRID` | `PROP_GRID` | 每个 chunk 每轴的放置格数。 |
| `PROP_KIND` / `PROP_KIND_COUNT` | `KIND_*` / `KIND_COUNT` | 物件种类。数值写进放置记录，不能重排。 |
| `SCALE_RANGE`（`chunkContent.mjs`） | `SCALE_MINIMUM` / `SCALE_MAXIMUM` | 各种物件的缩放范围（千分数）。 |
| `PROP_MARGIN_MM`、`DENSITY_SHIFT`、各路 `*_SALT`、`BASE_OCCUPANCY`、`OCCUPANCY_FROM_DENSITY`、`BASE_TREE_SHARE`、`TREE_SHARE_FROM_DENSITY`、`ROCK_SHARE`、`TWO_PI_MRAD` | 同名常量 | 放置算法的全部参数。 |
| `MAXIMUM_FILL_VERTICES` / `MAXIMUM_LINE_VERTICES`（`chunkGenerator.mjs`） | `MAX_FILL_VERTICES` / `MAX_LINE_VERTICES`（`lib.rs`） | 单个 chunk 合批后的顶点上限。 |
| `TEMPLATE_ARENA_CAPACITY` | `TEMPLATE_ARENA_F32` | 模板顶点暂存区容量。 |
| `TEMPLATE_FILL_STRIDE` | `TEMPLATE_FILL_STRIDE` | 单个填充顶点占用的 f32 数：位置、法线、颜色各三个。 |
| `GROUND_TEMPLATE_INDEX` | `TEMPLATE_GROUND` | 地面模板下标，紧跟在物件种类之后。 |

`shared/world/chunkStream.mjs` 与 `chunkKey.mjs` 没有 Rust 对应实现，改动不需要重建 WASM。

## 放置算法

每个 chunk 划成 `PROP_GRID × PROP_GRID` 个放置格（当前 8 × 8，每格 4 米）。对每一格：

1. 用**密度噪声**决定这一带是密林还是空地。噪声在全局放置格坐标上取值，格点间距 2⁴ = 16 格，约 64 米一片林子，所以相邻 chunk 的疏密是连续的。
2. 用一次哈希决定这一格有没有物件，概率随密度上升。
3. 用同一次哈希的高位选种类：树的占比随密度从 16/255 升到 120/255，岩石固定 32/255，其余是草。
4. 另外两次哈希给出格内抖动、朝向和缩放。抖动留了 `PROP_MARGIN_MM` 的边距，物件不会骑在 chunk 接缝上。

结果写成 `PROP_STRIDE = 5` 的整数记录：`[kind, x_mm, z_mm, rotation_mrad, scale_thousandths]`。缓冲区由调用方复用，避免流式加载过程中持续产生 GC 压力。

## WASM ABI

`native/chunkgen` 编译到 `wasm32-unknown-unknown`，`no_std`、无分配器、全部状态是静态数组，产物约 3.4 KB。

> 静态数组必须**全部零初始化**。只要有一个字段非零，链接器就会把整块 1.6 MB 的静态区写进 wasm 的数据段，产物从 3 KB 涨到 1.6 MB。

导出函数：

| 导出 | 作用 |
| --- | --- |
| `memory` | 线性内存。JS 侧按下面的指针建立视图。 |
| `template_arena_ptr()` / `template_arena_capacity()` | 模板顶点暂存区。JS 把模板写进这里再注册。 |
| `register_template(index, fillOffset, fillCount, lineOffset, lineCount)` | 注册一个模板。返回 0 成功，负值表示下标越界或超出暂存区。 |
| `template_count()` / `ground_template_index()` | 供 JS 侧核对两边常量是否一致，不一致直接抛错。 |
| `set_seed(seed)` | 设置世界种子。 |
| `build_chunk(chunkX, chunkZ)` | 生成并合批一个 chunk。返回 0 成功，-1 表示顶点缓冲不够。 |
| `prop_ptr()` / `prop_count()` / `prop_stride()` | 放置记录。 |
| `fill_position_ptr()` / `fill_normal_ptr()` / `fill_tint_ptr()` / `fill_vertex_count()` | 合批后的填充顶点。 |
| `line_position_ptr()` / `line_vertex_count()` | 合批后的轮廓线顶点。 |

输出视图指向 wasm 内存，下一次 `build_chunk` 就会被覆盖，所以 JS 侧必须切片拷贝出来。

模板几何体由 Three.js 在 JS 侧生成后一次性上传，Rust 不重复实现三角化——线稿模型的定义只有 `src/models/` 一处。模板注册进的是**实例**的线性内存，而每个场景配色不同，所以 wasm 模块只编译一次、每个流式场景实例化一份。

## 模板格式

- 填充顶点：`[px, py, pz, nx, ny, nz, r, g, b]`，`TEMPLATE_FILL_STRIDE = 9`。
- 轮廓线顶点：`[px, py, pz]`。

颜色随顶点走而不是随模板走，因此一棵树的树干与树冠能保留各自配色，而整个 chunk 仍然只用一种材质。`createFillMaterial` 的 `vertexTint` 选项打开这条路径。

关掉某一类内容（`renderer.content.trees` 等）的做法是**注册空模板**，不是改放置算法——放置必须与场景配置无关，否则两个后端就不再一致。

## 渲染开销

一个 chunk 固定三次 draw call：合批填充、合批轮廓线，以及同场景全部 chunk 共用的地面网格线。视野内 25 个 chunk 合计 75 次。

填充与轮廓的顶点已经是世界坐标，承载它们的对象留在原点，Three.js 自动算出的包围球就落在正确位置，视锥剔除按 chunk 生效。

实测（约 4700 顶点/chunk）：

| 路径 | 单个 chunk |
| --- | --- |
| WASM 生成 + 合批（不含拷贝） | 45 µs |
| WASM 全流程（含切片拷贝） | 74 µs |
| JS 全流程 | 82 µs |

端到端只快约 10%：V8 对紧凑的 TypedArray 循环优化得很好，而且 39% 的开销是两条路径都要付的切片拷贝。WASM 现阶段的价值是把逐顶点工作移出 JS 堆（无 JIT 预热与 GC 抖动），以及为调大视距和密度留余量。要继续压缩，下一步是把位置、法线、颜色交错进同一份 `InterleavedBuffer`，把三次拷贝并成一次。

## 流式加载策略

`ChunkStreamer` 是一个 `SceneVisualSystem`，随场景创建与销毁。两条纪律：

1. **只在跨过 chunk 边界时重新规划。** 在同一个 chunk 里走动不做任何集合运算。
2. **每帧最多构建 `CHUNK_BUILD_BUDGET_PER_FRAME` 个 chunk。** 玩家高速穿越时补齐会晚几帧，但这段延迟被雾效盖住。

加载半径与保留半径必须不同，否则站在边界上来回走会让同一批 chunk 反复构建又销毁。焦点由 `GrasslandScene` 通过 `SceneUpdateContext` 提供：有玩家时是玩家，没有玩家时是相机，所以大厅背后看到的也是一片正常的世界。

## 场景字段：`renderer.world`

| 字段 | 格式/范围 | 作用 |
| --- | --- | --- |
| `loadRadius` | 1–6 的整数 | 以焦点所在 chunk 为中心向外加载几圈。 |
| `keepRadius` | 2–8 的整数，且必须大于 `loadRadius` | 走出几圈之外才卸载。 |
| `rockColor` | `#RRGGBB` | 岩石填充色。地面、草、树的颜色沿用 `renderer.palette`。 |

世界尺寸不在这里配置：它是生成算法的固有属性，写在 `shared/world/worldConfig.mjs`，对所有流式场景一致。

`SceneCatalog` 在启动时校验三条约束，并指出是哪一个文件的哪一项：

| 约束 | 违反后的现象 |
| --- | --- |
| `keepRadius > loadRadius` | chunk 在边界上反复构建与销毁。 |
| `fog.far <= loadRadius × CHUNK_SIZE` | 视野越过最近的未加载 chunk，玩家看见地块凭空出现。 |
| `gameplay.bounds ⊆ WORLD_PLAY_AREA` | 玩家能走到还没有内容的世界边缘旁边。 |

## 降级路径

`shared/world/chunkGenerator.mjs` 里的 JS 后端与 WASM 行为完全一致，WASM 加载或实例化失败时自动接管，世界照样是同一个。用 `?chunkgen=js` 打开页面可以强制走 JS 后端做对照——两条路径看起来不一样，就说明它们已经分裂，而测试没覆盖到。

## 草地不走 chunk

草叶数量比物件高两个数量级，按 chunk 分配既撞顶点上限、又要在每次跨界时重填一批实例。所以草独立于 chunk 系统，由 `GrassFieldSystem` 配一块跟着焦点滚动的实例网格负责（`src/grass/RollingGrassLayout.ts`）：

- 实例属性只有一个整数格下标，一次上传后永不更新；位置、朝向、高矮由「世界格下标」哈希导出，每帧只改视野原点一个 uniform。
- 格下标全程走整数加法。换成 `origin + aCell * cellSize` 这种浮点累加，同一块地在不同原点下可能差 1 ulp，而哈希会把它放大成完全不同的草——玩家一移动草地就闪烁。`tests/RollingGrassField.test.ts` 守着这条不变量。
- 踩踏形变场用真·环形寻址：取样是 `fract(bladeXZ / fieldSize)`，与视野原点无关，所以同一块地永远落在同一个纹素上。视野滚动后被重新指派的纹素由片元着色器比对新旧原点下代表的世界位置来识别并清零，不需要额外的 pass 或条带几何。

因此流式场景的 chunk 模板里草是关掉的（`content.grass` 传 false），否则两套草会叠在一起。chunk 的放置记录中仍保留 `PROP_KIND.GRASS`，将来想要显眼的草簇点缀时现成可用。

默认参数：格边长 0.32 米、网格 250 格（80 米见方，62500 实例、约 438k 顶点），近处约 7 株/㎡，20 米内满密度、40 米处淡完。视野半径与消隐距离相等，草在边缘之前刚好淡完，也就没有一圈注定退化的实例。嫌重就调大格边长或调小网格，都是 `RollingGrassLayout` 的构造参数。
