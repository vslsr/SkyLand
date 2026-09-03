# 模型维度的 if-else 分派：现状清点与重构建议

> 起因：`createSimpleCollisionFromRender` 全是 `if-else`，物品/模型一多就会继续膨胀。
> 结论：那个函数不是孤例，它是**同一份模型清单在仓库里的第 8 份拷贝**。只重写它，
> 新增一个模型仍然要改 7 个文件。
> 状态：本文只做清点与方案，不含代码改动。

---

## 1. 一句话结论

问题不在 `if-else`，在于**「渲染模型」这一维度没有自己的注册点**。

这个仓库对其它维度都已经做对了：

| 维度 | 注册点 | 新增一项要改的代码 |
| --- | --- | --- |
| Actor 原型 | `config/actors/*.actor.json` | 0 处 |
| 物品 | `config/items/item-catalog.json` + `shared/items/ItemCatalog.mjs` | 0 处（`resolveHeldItemAction` 注释里明写「加一件新道具不改这里的代码」） |
| 世界物件种类 | `PROP_KIND_BY_NAME`（`shared/world/generatedProp.mjs:27`） | 1 处 |
| **渲染模型** | **没有** | **7 处（玩家外壳 17 处）** |

于是每加一个模型，那份清单就要在 8 个地方各抄一遍，而没有任何机制保证 8 份一致。
`createSimpleCollisionFromRender` 只是其中最显眼的一份。

---

## 2. 实测：新增一个模型要改哪些文件

对现有模型反查（排除 `tests/`）：

**`line-art-campfire`（普通道具）— 7 个文件**

```
config/actors/actor.schema.json              ← 登记
config/actors/campfire.actor.json            ← 真正的新内容
server/actors/ActorCatalog.mjs               ← 登记
shared/actor/simpleCollision.mjs             ← 登记
src/models/actors/createActorVisualModel.ts  ← 登记
src/models/actors/createCampfireModel.ts     ← 真正的新内容
src/scenes/data/SceneDefinition.ts           ← 登记
```

7 个里只有 2 个是新内容，**5 个是纯登记**。

**`line-art-wood-log`（走合批的堆叠物）— 9 个文件**，多出
`src/actors/ClientActorSystem.ts`、`src/actors/systems/HighCountActorBatchSystem.ts`。

**`line-art-legged-slime`（能当玩家外壳）— 17 个文件**，再多出
`src/player/PlayerEntity.ts`、`RemotePlayer.ts`、`playerVisualShape.ts`、
`src/render/RenderScene.ts`、`RenderSlimeLegs.ts`、`three/ThreeRenderScene.ts`、
`three/ThreeSlimeAnimator.ts`、`src/models/slimeSoftBody.ts`。

---

## 3. 全部同类代码清点

### A 类：模型维度的重复分派（8 处，建议收敛）

| # | 位置 | 分派键 | 分支数 | 决定什么 |
| --- | --- | --- | --- | --- |
| A1 | `shared/actor/simpleCollision.mjs:34-174` | `render.model` | 9 个 `if`（覆盖 16 个模型） | 碰撞盒 authoring |
| A2 | `src/models/actors/createActorVisualModel.ts:21-71` | `definition.model` | 15 个 `if` + 兜底 | 选模型工厂 |
| A3 | `server/actors/ActorCatalog.mjs:625-862` | `render.model` | 16 个 `if`，约 237 行 | 逐模型字段校验 |
| A4 | `config/actors/actor.schema.json:428-707` | `model` const | 16 个 `oneOf` | 同一套字段规则，第二遍 |
| A5 | `src/scenes/data/SceneDefinition.ts:60-219` | 判别式联合 | 16 个成员 | 同一套字段清单，第三遍 |
| A6 | `src/actors/systems/HighCountActorBatchSystem.ts:34-46, 215-227` | `definition.model` | `PILE_RENDER_MODELS` + 3 个 `if` | 哪些走合批、每种堆怎么摆 |
| A7 | `src/player/playerVisualShape.ts:19-50` | `definition.model` | 3 个 `\|\|` + 2 个 `if` | 哪些能当玩家外壳、胶囊尺寸 |
| A7b | `src/render/RenderScene.ts:92-95` | 判别式联合 | 3 个模型名 | `PlayerRenderDefinition`，玩家外壳清单的第三份（清点时漏记，Step 2 时补上） |
| A8 | `src/render/three/ThreeRenderScene.ts:183-191, 214-240` | `desc.render.model` | 4 个 `if` | 建哪套 rig（软体蒙皮/骨骼腿/动画器） |

零散单点（同一维度，散落各处）：
`src/actors/ClientActorSystem.ts:882`（`singleModels` 集合）、`:1028`（腿部地面探针）、
`src/player/PlayerEntity.ts:192`、`src/player/RemotePlayer.ts:93`。

**同一份清单的多处副本：**

- `PILE_RENDER_MODELS` 同时存在于 `server/actors/ActorCatalog.mjs:16` 和
  `src/actors/systems/HighCountActorBatchSystem.ts:41`，内容相同，互不引用。
- `PLAYER_RENDER_MODELS`（`ActorCatalog.mjs:27`，注释里明说「导出是有意的，避免三处独立改动」）
  和 `isPlayerRenderDefinition`（`playerVisualShape.ts:19`）是同一个判断的两份实现。
  第一份已经意识到问题，第二份还是抄了一遍——因为客户端不能 import 服务端模块。

### B 类：会随玩法长大，但只有一两处（建议中期处理）

| # | 位置 | 分派键 | 说明 |
| --- | --- | --- | --- |
| B1 | `server/scene/ServerScene.mjs:709-820` `interactWithActor` | `interactable.action` | 4 个动作各一段 `if`，每加一个交互动词就长一段 |
| B2 | `shared/actor/ActorActionTable.mjs:89` `resolveActorAction` | `target.action` | 同一个键的 `switch`，决定提示与许可 |

B1 和 B2 **对同一个键分派两次**：共享层已经把动作解析成 `ACTOR_ACTION_IDS` 里的 id，
服务端却没照那个 id 选 handler，而是把 `interactable.action` 又判了一遍。
`ActorActionTable.mjs` 的文件注释正是为了消除「客户端提示和服务端分派各写一遍」这种漂移
而写的——那次只做了一半，服务端这一半没接上。

### C 类：不该动（明确列出，避免顺手一起重构）

- `collision.shape === 'cylinder'`（`shared/collision/collisionBox.mjs:39,42,105,232`、
  `simpleCollision.mjs:247,291,343`、`shared/physics/PhysicsWorld.mjs:496`、
  `src/models/actors/createSimpleCollisionHelper.ts:15`）——闭集二值几何图元，
  加第三种形状是物理决策不是内容决策。**保持 `if`。**
- `src/scene/components/createSceneRuntimeComponent.ts:8`、
  `InteractiveParticleEffectSceneComponent.ts:264`——单点 `switch` + `never` 穷尽检查，
  **已经是正确形态**，别改。
- `server/scene/ServerScene.mjs:602`（`command.kind`）、
  `server/rooms/room-worker.mjs:113`、`server/network/RoomConnectionHub.mjs:103`——
  协议解复用，单点，`switch` 就是对的。
- `src/abilities/AttributeSet.ts:28`、`shared/abilities/runtime.mjs:113`——数学算子，闭集。
- 各 catalog / parser 里的 `value === '...'`（`ActorCatalog.mjs`、`SceneCatalog.mjs`、
  `ItemCatalog.mjs`、`InputSchemeParser.ts`）——枚举校验，不是分派。

---

## 4. 为什么「把 if 换成 switch 或 Map」解决不了

在 `simpleCollision.mjs` 内部换成 `Map<model, fn>` 只让**那一个文件**好看，
A2–A8 一个都不受影响：新增一个道具仍然要改 7 个文件。

16 个模型 × 8 张表 = 128 个格子，其中真正有内容的不到 40 个。剩下的是「这个模型在这张表里没有特殊之处」，
但因为没有注册点，这句话没法只说一次。

**同时要注意两个真实约束**，方案必须绕开它们：

1. **`shared/` 与 `server/` 不允许 import `three`**（实测：两个目录里 0 处 three 引用；
   `tests/RenderSceneBoundary.test.ts:144,172` 按源码文本盯住这条）。
   碰撞 authoring 之所以被从模型文件里剜出来贴进 shared 的 if 链，就是因为这条。
   任何方案不能把 three 拉进 shared。
2. **`shared/` 和 `server/` 是 `.mjs` + JSDoc，没有编译期穷尽检查。**
   `createActorVisualModel.ts` 那个 reef 兜底其实是**类型安全**的——TS 收窄后
   剩余类型正好是 `ReefRender`，联合里多一个成员而这里不加分支会直接编译失败。
   但 `simpleCollision.mjs:34` 的 `render` 是 `Record<string, unknown>`，
   **没有任何编译期检查**：模型加进了 TS 联合、schema、`ActorCatalog`，唯独漏了这里，
   构建照过，spawn 时客户端和服务端一起抛 `无法为模型 X 生成简易碰撞`。

顺带一个已经存在的漏洞：**`config/actors/actor.schema.json` 没有任何运行时消费者**
（全仓只有各 `*.actor.json` 的 `$schema` 引用它，编辑器用；运行时校验走 `ActorCatalog.mjs`），
也**没有任何测试比对它和 `validateRender`**。它是一份 280 行、纯手工维护、没人验证的重复品。

---

## 5. 建议方案：每个模型一个注册单元

按依赖约束切成两半，两半用一个测试钉在一起。

### 5.1 共享半边（不 import three）

```
shared/actor/models/
  index.mjs            ← 注册表：唯一一处「有哪些模型」
  woodLog.model.mjs
  cargoCrate.model.mjs
  ...（16 个）
```

每个文件导出一个描述符：

```js
// shared/actor/models/woodLog.model.mjs
import { color, number } from './fieldSpec.mjs';

export const woodLogModel = {
  id: 'line-art-wood-log',

  /** 字段规格。ActorCatalog 校验、actor.schema.json 生成、TS 类型推导都读它。 */
  fields: {
    woodColor: color(),
    cutColor: color(),
    inkColor: color(),
    radius: number({ exclusiveMinimum: 0, maximum: 1 }),
    length: number({ exclusiveMinimum: 0, maximum: 3 }),
  },

  /** 从 authoring 尺寸派生碰撞。纯函数，不碰 three。原分支体原样搬进来。 */
  collision: (render) => ({
    halfWidth: render.length * 0.5,
    halfLength: render.radius,
    minimumY: -render.radius,
    maximumY: render.radius,
  }),

  /** 可选事实，缺省即「没有」。PILE_RENDER_MODELS 这类集合由它派生。 */
  traits: { pile: true, batchedSingle: true },
};
```

`shared/actor/models/index.mjs` 只做一件事：把 16 个描述符收进 `Map`，导出
`actorModel(id)`、`actorModelIds()`、`modelsWithTrait(name)`。

### 5.2 渲染半边（可以 import three）

```
src/models/actors/registry.ts   ← id → { create, rig facts }
```

放在 `src/render`/`src/models` 侧，因为**答案由渲染侧的模型工厂决定**
（这正是 `engine-migration-roadmap-vlqccr` 分支上 `src/render/renderModelFacts.ts` 的理由，
那张表应当并进这里）。

### 5.3 一个测试钉住两半

```ts
test('两张模型注册表的键完全一致', () => {
  assert.deepEqual([...actorModelIds()].sort(), [...renderModelIds()].sort());
});
```

漏登记一半，这条先炸，而不是等到 spawn。

### 5.4 各处收敛成什么样

| 原处 | 之后 |
| --- | --- |
| A1 `createSimpleCollisionFromRender` | 约 12 行：查表 → 调 `collision(render)` → 过 `createSimpleCollisionDefinition` → 查不到就抛。**签名一字不改** |
| A2 `createActorVisualModel` | 查表 + 抛错，去掉 reef 兜底（错误信息从「reef 缺字段」变成「模型 X 没登记」） |
| A3 `validateRender` | 一个通用的 `fields` 遍历器，237 行 → 约 30 行 |
| A4 `actor.schema.json` | **由 `fields` 生成**，`npm run schema:check` 在 CI 里查漂移。手工维护的那一份消失 |
| A5 `SceneDefinition.ts` 联合 | 保留手写（TS 类型体验更好），但加一条「联合成员集合 == 注册表键集合」的测试 |
| A6 / A7 两份重复常量 | `modelsWithTrait('pile')` / `modelsWithTrait('playerShell')`，两份变零份 |
| A8 `ThreeRenderScene` rig 接线 | 由渲染注册表的 rig facts 驱动 |

---

## 6. 分步落地（每步独立可发布、可回滚）

**Step 0 · 先钉住现状 ✅ 已完成**

`tests/SimpleCollision.test.ts` 原来只断言了 **2 个模型**（cargo-crate、pbf-slime）的碰撞数值，
另外 14 个没有任何测试。现在补齐了：

- 覆盖检查：从 `SceneDefinition.ts` 的联合源码里读出声明了哪些模型，断言快照表一个不多一个不少。
  用源码文本而不是映射类型，是因为 `tsconfig.json` 的 `include` 里**没有 `tests`**，
  测试文件不过 `tsc`，写成类型也没人替我们检查；`RenderSceneBoundary.test.ts` 盯 import 用的是同一个办法。
- 16 个模型逐字段 `deepEqual`。合成 authoring 值用圆整数字而不是照抄 `config/actors/`，
  这样派生公式能从期望值里直接读出来（蘑菇 `radius: 1` 对上 `halfWidth: 0.4`，那个 0.4 就是分支里的 `radius * 0.4`），
  策划调数值也不会让用例变红。
- `dropMotion` 分支：有滚动半径时优先于模型分支；`wood-pile` / `stone-pile` 的 `dropMotion` 没有 `radius`，
  必须仍然走模型那一份。

变异验证：联合加一个成员而快照没跟上、箱盖外探量 `0.08→0.06`、蘑菇 `supportShape` `cylinder→box`，
三种改动分别被对应的用例挡下。

**Step 1 · 只搬碰撞这一面 ✅ 已完成**

建了 `shared/actor/models/`，16 个 `*.model.mjs` 各持一份描述符（`id` + `collision`），
`index.mjs` 收成注册表并在 id 重复时加载即抛。`createSimpleCollisionFromRender`
从 141 行的 16 分支 `if` 链变成一次查表，**签名一字未改**——`ServerActorFactory`、
15 个 `createXModel.ts`、`ClientActorSystem:973` 一个调用点都没动。

两处偏离原计划，都是为了不把「写过一次的东西」重新抄一遍：

- `authoringNumber.mjs`：`finiteNumber` / `positiveNumber` 原来是 `simpleCollision.mjs` 的私有助手，
  描述符也要用。抽成独立模块而不是从 `simpleCollision.mjs` 导出，是因为后者要 import 注册表——
  反过来导出会成环。
- `authoringShapes.mjs`：只收录**确实被不止一个模型用着**的轮廓
  （`uprightCylinder` 给假人/方尖碑，`uprightRadialBox` 给五种堆叠物）。
  原来这些模型是靠**共用一段 `if` 分支**来避免重复的，拆成逐模型文件后需要一个别的地方放它。
  各模型的默认值仍留在自己文件里——一种堆叠物改高度不该动到另外四种。

**验证**：Step 0 的快照一个数都没改地继续绿；另做了一次差分测试——把重构前的实现取出来，
与新实现在 16 个模型 + 未注册 + 空 id 上各跑 4000 组随机 authoring 值
（含 `undefined` / `0` / 负数 / `NaN` / `Infinity` / 字符串 / `null` / `1e-9`，覆盖每个分支的兜底路径），
**72000 组，0 处不一致**，连抛错信息都一致。`npm test` 666 项全绿，`npm run build` 通过。

新增的常驻护栏：注册表键集合 == 快照表键集合 == `ActorRenderDefinition` 联合成员集合。
少登记一个模型、两个描述符抢同一个 id，都已变异验证会被挡下。

**Step 2 · 收掉重复常量 ✅ 已完成**

描述符加了 `traits`（白名单 `playerShell` / `pile` / `pileSingle`，拼错的 trait 名在加载时或
调用时就抛，而不是永远安静地返回 `false`）。四份手写清单删掉：

| 原处 | 之后 |
| --- | --- |
| `ActorCatalog.mjs` 的 `PILE_RENDER_MODELS` | `modelHasTrait(model, 'pile')` |
| `ActorCatalog.mjs` 的 `PLAYER_RENDER_MODELS` + `isPlayerRenderModel` | `modelHasTrait(model, 'playerShell')`，两个导出一并删掉，`ServerScene` / `SceneCatalog` 改为直接问注册表 |
| `HighCountActorBatchSystem.ts` 的同名 `PILE_RENDER_MODELS` | 同上；那个不安全的 `as PileRender['model']` 转换也没了 |
| `playerVisualShape.ts` 的三个 `\|\|` | 同上 |
| `ClientActorSystem.ts` 的 `singleModels` | `modelHasTrait(model, 'pileSingle')` |

清点时漏记的**第四份玩家外壳清单**：`src/render/RenderScene.ts` 的 `PlayerRenderDefinition`
也硬编码了那三个名字（原文档 §3 只数到两份，这里补上）。

**TS 类型没法从运行时值推导**，所以类型这一侧必然还要留字面量：`PLAYER_SHELL_MODELS`
和合批系统的 `PILE_MODELS`，各自用 `as const` 元组推出对应的 `Extract<>` 类型。
它们不再有各自的运行时副本——运行时判定一律走 trait，两份字面量由
`tests/ActorModelRegistry.test.ts` 钉住与注册表一致。合批系统里四个逐模型的
`*Render` 别名改成从 `PileRender` 再 `Extract`，这样 `PILE_MODELS` 仍是唯一的清单。

**验证**：与重构前那四份清单对拍，16 个模型 + 未注册 + 空串 + `undefined` / `null` / `0`
共 21 个探针 × 3 个 trait，0 处不一致。变异验证——给模型加了 `pile` 但合批类型清单没跟上、
`PLAYER_SHELL_MODELS` 少一项、`pileSingle` 脱开 `pile` 单独出现——三者分别被对应用例和加载期检查挡下。
`npm test` 672 项全绿，`npm run build` 通过。

**这一步之后，A6 / A7 两处以及 A8 的一半已经不再各自持有模型清单。**

**Step 3 · 字段规格与 schema 生成 ✅ 已完成**

描述符加了 `fields`（`color()` / `number(min,max)` / `positive(max)` / `integer(min,max)`）与
`constraints`（跨字段约束，pbf 史莱姆的内核必须在外壳内、骨骼腿必须够到站姿落脚点）。

- **A3**：`validateRender` 从 **240 行**十六段分支变成 **30 行**通用遍历器。校验实现留在
  `ActorCatalog`（要用它自己那套 `require*` 才能给出和其它 Component 一致的报错文案），
  `shared/` 那边只放声明。
- **A4**：`config/actors/actor.schema.json` 的 render 段改为生成物，
  `node scripts/generate-actor-schema.mjs` 重新生成，
  `server/tests/ActorSchemaGeneration.test.mjs` 每次 `npm test` 都重新生成并比对。
  生成器保留了文件原有排版（叶子对象一行放不下才展开），所以只替换 render 段，
  文件其余部分逐字节不动。

**顺手修掉了那处已经发生的漂移**（§4 里记的「没人验证的重复品」不是假设）：木筏的
`length`/`width`、货箱的 `length`/`width`/`height`、礁石的 `radius`/`height` —— 七个字段在
schema 里**没有上限**，`ActorCatalog` 里有（30/10/10/10/10/20）。编辑器放行 `width: 500`，
服务端启动时才报错。规则统一从运行时那一份（真正执行的那份）来。

**验证**：

- 生成后的 `actor.schema.json` diff **恰好只有那 7 个字段**——其余 16 个分支、
  全部字段顺序与规则逐字节重现。这同时证明了 `fields` 声明与原 schema 完全等价。
- 新旧 `validateRender` 对拍：16 个模型 + 未注册模型各 3000 组随机 render
  （字段缺失、边界值、越界 ±0.0001、`NaN` / `Infinity` / 字符串 / 对象 / 数组、多余字段），
  共 51000 组，其中 4779 组通过校验。**接受/拒绝判定 0 处不一致，通过时净化结果
  逐字段逐键序 0 处不一致。**
- 另以真实 authoring 值为基准逐字段破坏（559 组单错用例），报错文案只有 3 处不同：
  pbf 史莱姆那条 `particleCount、constraintIterations 和 bubbleCount 必须是整数`
  的分组信息，现在指名道姓说是哪一个。没有测试断言过旧文案。
  多错并存时先报哪一处确实变了（旧实现把三个整数字段提前到 `radius` 之前校验，
  新实现按声明顺序走）——那不是契约。
- 变异验证：改字段上限却没重新生成、手改 render 段内的上限、手删 render 段里的字段，
  三者都被挡下。
- `npm test` 675 项全绿，`npx tsc --noEmit` 干净，`npm run build` 通过。

**范围说明**：生成器只拥有 render 段。`playerMovement`、`buoyancy` 等其它 Component 的
schema 仍是手写的，和各自的 `validate*` 之间仍然没有比对——那是同一类问题的另一片，
不在本步范围内。

**一次不明失败**：中途有一批 `npm run test:server` 里 2/3 次在
`SceneInteractionE2E` 的「流式树砍伐」用例上失败，改动前 2/2 通过。此后 17 次连续全绿，
无法复现。该用例起真实 HTTP 服务并拉起房间子进程，对负载敏感；
render 字段校验与套接字时序之间也没有可解释的通路。记在这里，不当作已解决。

**Step 4 · 渲染侧注册表 ✅ 已完成**

`src/models/actors/registry.ts` 取代了 `createActorVisualModel.ts`（后者已删除，
唯一的调用方 `ThreeRenderScene` 改导入新路径）。

关键在于这张表的类型：

```ts
type ActorModelRenderers = {
  [M in ActorRenderDefinition['model']]: (
    environment: FillMaterialEnvironment,
    definition: Extract<ActorRenderDefinition, { model: M }>,
  ) => ActorVisualModel;
};
```

于是**漏登记一种模型是编译错误**，而且每个条目的 `definition` 参数按自己那一种
模型收窄，工厂接错键也是编译错误。变异验证：

- 删掉 `'line-art-dry-hay'` 一项 → `TS2741 Property "line-art-dry-hay" is missing`
- 把礁石工厂接到篝火键上 → `TS2322`，并逐字段说明哪两个类型对不上

对比原来那条 `if` 链：它最后一支是 `return createReefModel(...)`，类型上勉强成立
（联合里正好只剩礁石），但新增模型时作者看到的报错是「礁石缺字段」而不是
「你忘了登记」；而拿别的模型的字段去建一个礁石，画出来是什么样没人说得准。

**验证**：新旧实现对 16 种模型（用 `config/actors/` 里的真实 authoring 值）建出来的
东西逐项比对——完整节点树（到 4 层）、`simpleCollision`、`length`/`width`、
`interactionAnchorY`，以及六个可选 rig 是否存在——**全部相同**。
另加一条「两半注册表键集合一致」的用例，删掉 shared 一侧任一模型即变红。
`npm test` 677 项全绿，`npx tsc --noEmit` 干净，`npm run build` 通过。

**与 `engine-migration-roadmap-vlqccr` 的合并注意**：该分支新增的
`tests/RenderProxyCollisionParity.test.ts` 从 `src/models/actors/createActorVisualModel`
导入，而这个文件已删除——合并时需要把那一行改成 `src/models/actors/registry`。
该分支的 `src/render/renderModelFacts.ts`（`FIRE_VISUAL_MODELS`）也应当并进
`registry.ts`，作为渲染侧的第二类事实。这两处都是合并时的小改动，但**不会产生
文本冲突**，需要有人记得——所以记在这里。

**登记点现状**：新增一个普通道具模型现在要手改 **6 个文件**（原来 7 个）——
但真正变了的不是数量，是**没人核对的登记点从 5 处降到 0 处**：

| 要改的地方 | 漏改会怎样 |
| --- | --- |
| `config/actors/X.actor.json` | 真正的新内容 |
| `src/models/actors/createXModel.ts` | 真正的新内容 |
| `shared/actor/models/x.model.mjs` | 登记：碰撞、字段、trait |
| `shared/actor/models/index.mjs` | **测试变红**（两半键集合不一致） |
| `src/models/actors/registry.ts` | **编译错误** |
| `src/scenes/data/SceneDefinition.ts` | **测试变红**（联合与注册表不一致） |
| ~~`config/actors/actor.schema.json`~~ | 生成物，`npm test` 挡住漂移 |
| ~~`server/actors/ActorCatalog.mjs`~~ | 不用动 |

**Step 5 · 可选**

B 类：`ACTOR_ACTION_IDS` 加一张 `id → handler` 表，`interactWithActor` 改为查表，
让「加一个交互动词」不再是共享层和服务端各改一处、且没人保证两边一致。

---

## 7. 与 `claude/engine-migration-roadmap-vlqccr` 的关系

**那条分支没有在解决这个问题**，可以放心推进：

- `git diff origin/main...origin/claude/engine-migration-roadmap-vlqccr -- shared/actor/simpleCollision.mjs` 为空；
  该分支上这个文件仍然是 9 个 `if (model === ...)`。
- 相反，它**依赖**这条 if 链保持现状：`doc/engine-migration-implementation-plan.md` 里
  把 `simpleCollision` 定性为「一次纯粹的往返……一个输入只有 render 定义的 shared 纯函数」，
  据此删掉 `MeshProxyInfo` 的同步取回，并新增
  `tests/RenderProxyCollisionParity.test.ts` 把全部 16 种模型钉住。
- 它还**新增了第 9 张模型键表**：`src/render/renderModelFacts.ts`（`FIRE_VISUAL_MODELS`），
  以及那个 parity 测试里**手写的 16 份最小 render 定义**——又是一份要跟着改的清单。

所以：Step 1 保持 `createSimpleCollisionFromRender` 签名完全不变，两条分支互不冲突，
先后合并都行；Step 4 等它合并之后再做。

---

## 8. 明确不建议的做法

- **不要**给模型建类继承体系（`abstract class ActorModel` + 虚函数）。
  碰撞 authoring 不能碰 three，模型工厂必须碰 three——一个基类会把两者按回同一个模块，
  直接撞穿 `shared/` 的边界。描述符对象 + 两张表是唯一绕得开这条约束的形状。
- **不要**顺手把 C 类一起改了。`shape === 'cylinder'` 变成多态只会让物理代码变难读。
- **不要**一次性八张表齐改。回归了就没法二分定位是哪一张表搬错了一个数。
- **不要**为了消除 `SceneDefinition.ts` 的手写联合而去搞类型体操从 `fields` 反推 TS 类型。
  收益（少写一份字段清单）远小于成本（模型作者看到的类型提示会变成一团推导结果）。
  一条集合相等的测试就够了。

---

## 附：顺带发现（不在本次范围）

`package.json` 的 `test:client` 是一条手写的 54 个测试文件的清单——新增一个测试文件
不改它就不会被跑到。和上面是同一类「手工维护的注册清单」，可以改成目录 glob。
