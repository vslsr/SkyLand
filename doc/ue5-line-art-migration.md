# 线稿风格迁移到 Unreal Engine 5 的方案

> 文档定位：**评估与方案**，不是本仓库的实施计划。
> SkyLand 本身仍是 Web / TypeScript / Three.js 项目（见 `.cursor/rules/ue-inspired-not-unreal.mdc`）；
> 本文讨论的是「如果另起一个 UE5 目标，如何复刻这套线稿风格，并让它跑在移动端」。
> 相关文档：[`engine-migration-roadmap.md`](engine-migration-roadmap.md)（自研引擎方向）——
> 两份文档共享同一批前提：**只服务「块状地形大世界 + 线稿风格」这一种玩法**。

核心主张：迁移的**不是资产，是六条规则**。这套风格没有一张贴图、没有一个 glTF、没有一根骨骼，
全部是程序化几何加两支手写着色器。所以「迁移」的实质是把规则翻译成 UE 的材质与实例化设施，
而移动端优化的一半工作量是**关掉 UE 默认打开的东西**，不是写新东西。

---

## 1. 先把风格拆成可移植的配方

| # | 规则 | 出处 |
| --- | --- | --- |
| 1 | 平涂填充 + 硬边墨线两个 pass：每个物件 = `Mesh(fill)` + `LineSegments(EdgesGeometry, thresholdAngle)` | `src/models/outlinedObject.ts` |
| 2 | 墨线是全场**共享的一支材质**，颜色是唯一调节量（WebGL 改不了线宽） | `src/materials/lineMaterials.ts` |
| 3 | 墨色随环境换：夜里从 `0x171614` 提亮到 `0xc4cedd`，否则纸面沉下去后轮廓消失 | `applyEnvironmentInk()` |
| 4 | 填充不是 PBR，是手写 GLSL：half-lambert + 半球环境光 + 云影 + 手写距离雾 + 手写点光源数组 | `src/materials/createFillMaterial.ts`、`src/shaders/environmentLighting` |
| 5 | 角色墨记（腿 / 眼 / 嘴）是**另一层**：不受光、不受雾、不受色调映射，永远纯黑 | `src/materials/createCharacterInkMaterial.ts` |
| 6 | 全局不做的事：无阴影贴图、无 PBR/IBL、无纹理、无骨骼、无资产导入、无 LOD | 路线图 §4 的「不做清单」 |

**第 6 条才是移动端优化的真正抓手。** 这份「零」清单在当前仓库里逐条核实过：
`castShadow` / `shadowMap` = 0，`MeshStandardMaterial` = 0，`SkinnedMesh` / `AnimationMixer` = 0，
`TextureLoader` = 0。UE5 默认把对应的能力全打开了，把这份清单原样带过去写成项目设置，
比任何单点优化都更值钱。

---

## 2. UE5 里怎么画这套线稿

### 2.1 描边：三条路线，选反转外壳

| 方案 | 能画内部折边 | 移动端成本 | 与 SkyLand 的一致度 |
| --- | --- | --- | --- |
| **反转外壳（推荐）** | ✗（只有剪影） | 低：多一个 unlit draw，无 RenderTarget 依赖 | 高，且**白送可调线宽** |
| 后处理 Sobel（Depth + Normal） | ✓ | 中高：移动 Forward 下 `SceneTexture:WorldNormal` 不可用，得自己写一张 normal RT，多一遍全屏带宽 | 中 |
| 真线段（对应 `EdgesGeometry`） | ✓ | 最差：线图元批次差、对 GPU 不友好 | 最高 |

推荐组合：**主体用反转外壳，地形折边用几何生成**（见 §2.4）。落地要点和三个必踩的坑：

- **材质配置**：`Shading Model = Unlit`、`Two Sided = true`、`Blend Mode = Masked`；
  World Position Offset 输出 `VertexNormalWS * Thickness`；
  像素里判断 `TwoSidedSign > 0`（正面）时令 `Opacity Mask = 0`，等价于 cull front。
- **线宽必须屏幕空间恒定**：`Thickness = k * PixelDepth * tan(FOV/2)`。
  SkyLand 的墨线是固定 1 像素的，直接用世界空间厚度会让远景的线糊成一片。
- **硬边法线会把外壳撑裂**：本项目是 low-poly 硬边模型（`computeVertexNormals` + `EdgesGeometry` 阈值角），
  直接沿法线挤出会在每条折边处开口。必须在建模阶段把**平均法线烘进 vertex color / UV2**，
  材质里读它作为挤出方向。**这是这套风格迁 UE 最容易翻车的一步。**
- 墨色接 Material Parameter Collection（见 §2.2），一处写、全场生效，
  语义上完全对应现在的 `applyEnvironmentInk`。

### 2.2 填充：一支 Unlit 母材质，把 GLSL 原样搬过去

不要用 `Default Lit`。`createFillMaterial.ts` 的片元着色器是自洽的——half-lambert、
`hemisphereTint`、`cloudShadowAt`、`scatteredFogColor`、点光源数组——在 UE 里就是
一个 **Unlit 母材质**，结果输出到 Emissive。

- **最大的一笔省**：移动端因此跳过整个光照 pass、shadow pass、反射捕捉与天光。
- `uColor` 与 `vTint`（`USE_VERTEX_TINT`）→ **Per-Instance Custom Data** 或 Vertex Color。
  一个母材质 + 一个 PSO 覆盖整个世界。
- 所有环境量（`inkTint`、`daylight`、`sunDirection`、`skyTint`、`cloudShadowOffset`、雾参数）
  → 一个 **Material Parameter Collection**。天气 / 昼夜系统每帧写 MPC，零 draw call 代价，
  与现在的 `SceneEnvironmentRuntime` 共享 uniform 是同一个设计。
- **篝火点光源继续手写**（`MAX_ENVIRONMENT_POINT_LIGHTS`，取离视点最近的几盏），塞进 MPC 的向量数组。
  不要用 UE 的动态点光源：移动端每盏都是实打实的开销，而这里只需要一个衰减球。
- 角色墨记层：Unlit + `Disable Depth Test`（对应 `depthTest: false`）+ 不接雾节点 + 不参与色调映射。

### 2.3 材质总数控制在 4 支

`fill` / `outline` / `character-ink` / `water + grass 的 WPO 变体`。

移动端的隐形杀手是 **shader permutation 数量与 PSO 编译卡顿**。
母材质越少，打包出的 PSO cache 越小、首次遇到新材质时的掉帧越少。

### 2.4 地形轮廓白拿

路线图 §4.1 已经点破：`TERRAIN_SHAPE` 是 13 项封闭枚举，
**平面与斜坡的交界在枚举里是已知的**，不需要跑拓扑边提取。

UE 里把它做成地形网格生成时直接输出的一条边条带（或在填充材质里按 cell code 的 UV 画硬边），
比反转外壳更准也更省。

---

## 3. 移动端：一份「关掉什么」清单

### 3.1 渲染路径

| 设置 | 取值 | 理由 |
| --- | --- | --- |
| Mobile Renderer | **Forward / Mobile shading path**（ES3.1 或 Vulkan） | Deferred 的 GBuffer 带宽对这个零 PBR 项目是纯浪费 |
| Nanite / Lumen / Virtual Shadow Maps | **全关** | low-poly 枚举几何 + 零阴影，一项都用不上，且移动端不可用或极贵 |
| Ray Tracing / SSR / SSAO / GI | 全关 | 同上 |
| Virtual Texture / 纹理流送 | 关 | 全程序化，零贴图 |
| 阴影 | 全关，改用一张接触阴影贴片 | 对应现有的 `createContactShadowMaterial` |
| Skeletal Mesh 相关 | 不用 | 史莱姆是程序化形变（`slimeSoftBody.ts`），在 UE 里就是 WPO |

### 3.2 抗锯齿：TAA 是线稿的敌人

**用 MSAA 4x，不要 TAA。** 两条理由都致命：

1. TAA 会把 1–2 像素的墨线糊掉，并在相机移动时让细线**抖动、闪烁**——线稿最显眼的地方恰好在这里。
2. Forward + MSAA 在移动端 TBDR 架构上是 tile 内解析的，带宽代价远低于桌面直觉，
   而它解决的正是「硬边锯齿」这个本风格的核心痛点。

FXAA 同样不要用：它会把墨线当成锯齿抹平。

### 3.3 色彩：必须关掉色调映射

`createCharacterInkMaterial` 的注释里已经写明这件事：**曝光调整会把纯黑抬成深灰**
（这正是那句 `toneMapped: false` 的由来）。UE 默认的 ACES 色调映射 + 自动曝光
会同时毁掉纸面的浅色和墨线的黑。

- Post Process Volume：曝光固定（Min = Max）；关 Bloom（或压到 0.05 以下）、Motion Blur、
  Vignette、Chromatic Aberration、Lens Flare。
- 色调映射：用 Replace Tonemapper 后处理材质走 pass-through，或把 Film 曲线设成中性。
  要的是**所见即所得的平涂色**。
- `Mobile HDR`：若不需要 bloom 与 HDR 昼夜过渡，关掉可省一整遍带宽；
  需要保留时也无妨——昼夜 tint 本身是 MPC 乘色，LDR 路径一样做得到。

### 3.4 Draw call：按种类跨 chunk 实例化

这是路线图 §4.2 的结论，在 UE 里有现成载体：

- 4 类物件（tree / grass / rock / mushroom）→ **每类一个 HISM**，
  chunk 装卸只是增删 instance range，不是建 / 毁组件。
  加上 fill + outline 两 pass = **8 个 draw 覆盖整个可见世界**。
- 颜色走 **Per-Instance Custom Data**，不要为了换色拆组件。
- 草（`StreamingGrassSystem` / `GrassFieldSystem`）：移动端**建议放弃草的独立 outline pass**。
  每片草叶两个 batch 太贵；把墨边做进草叶几何（一个深色窄三角）或在材质里按 UV 画。
  视觉差异极小，成本减半。
- 相机 `far = 100`、`loadRadius = 2` → 常驻 5×5 chunk。**不要上 World Partition**：
  自己的 chunk 流送已经是精确解（路线图 §4.4），WP 的运行时开销在这里是负收益。
- 目标：移动端 **< 250 draw call、< 500k 三角面 / 帧**。

### 3.5 PSO 与启动卡顿

把「关掉的东西」写进项目级配置（而不是只在关卡里关），
能同时砍掉 shader permutation 数量、包体和 PSO 数量。

上线前跑一遍 **bundled PSO cache 收集**：移动端最常见的「偶发掉帧」
是首次遇到新材质时的 PSO 编译，不是渲染负载。

---

## 4. 逐系统迁移映射

| SkyLand | UE5 落点 |
| --- | --- |
| `createTerrainChunkGeometry`（475 行 CPU） | cell code → 程序化网格组件，或 code 纹理 + 顶点着色器展开；13 形状常量表 |
| `outlinedObject` 的两 pass | HISM × 2（fill + 反转外壳） |
| `createFillMaterial` 的 GLSL | Unlit 母材质 + Material Parameter Collection |
| `createCharacterInkMaterial` | Unlit + Disable Depth Test + 不接雾 / 不参与色调映射 |
| `slimeSoftBody` | World Position Offset 程序化形变，**不用骨骼** |
| `createLineArtFireVisual` | Niagara + 同一支 unlit 线稿材质 |
| `WeatherSystem` 的雾 | 材质内手写雾，**不要** Exponential Height Fog（它走的是贵的那条路） |
| 海面 / 水面 | grid mesh + WPO，复用同一张 code 纹理 |

**物理不要动。** `shared/physics/PhysicsWorld.mjs` 是浏览器与房间进程共用的同一份 Rapier WASM，
6 厘米的和解容差（`RECONCILE_TOLERANCE`）靠的就是「两端逐位一致」这件事（路线图 §5）。
渲染迁到 UE 不意味着模拟也要跟着迁；换成另一套物理会直接击穿预测与和解。

---

## 5. 落地顺序（每步都能看到画面）

1. **一个球 + 一个斜坡**：跑通 Unlit 母材质 + 反转外壳 + MPC 换墨。
   先把「硬边法线撑裂外壳」和「屏幕空间线宽」这两个坑填了，后面才有意义。
2. **一块 chunk**：13 形状地形 + 4 类物件的 HISM，量 draw call 与帧时间。
3. **环境**：昼夜 tint、云影、雾、篝火点光源数组，对照 Web 版逐帧比色。
4. **移动端体检**：真机上看渲染统计，确认 MSAA 开、TAA 关、色调映射中性、PSO cache 已收集。

---

## 6. 一件必须重新做决定的事

WebGL 改不了线宽，所以这套美术是围绕「1 像素固定墨线、只调墨色」长出来的——
`lineMaterials.ts` 开头那段注释把这个前提写得很清楚：**线宽在 WebGL 里改不了，
所以墨色是线稿唯一的调节量。**

UE 给了真正可变的线宽。但如果一上来就放开它，现在这套靠墨色浓淡撑起来的夜景与雾景层次会整个失衡
（夜里把墨提亮、网格让出不透明度，这些补偿都是在「线宽恒定」的前提下调出来的）。

**建议第一版把线宽锁死成屏幕空间恒定值**，先复刻现有手感；等画面稳定后，再决定要不要动它。
