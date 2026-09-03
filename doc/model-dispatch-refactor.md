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
| A8 | `src/render/three/ThreeRenderScene.ts:183-191, 214-240` | `desc.render.model` | 4 个 `if` | 建哪套 rig（软体蒙皮/骨骼腿/动画器） |

零散单点（同一维度，散落各处）：
`src/actors/ClientActorSystem.ts:882`（`singleModels` 集合）、`:1028`（腿部地面探针）、
`src/player/PlayerEntity.ts:192`、`src/player/RemotePlayer.ts:93`。

**两份同名常量各自维护：**

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

**Step 0 · 先钉住现状（半天，必须先做）**

`tests/SimpleCollision.test.ts` 现在只断言了 **2 个模型**（cargo-crate、pbf-slime）的碰撞数值，
另外 14 个没有任何测试。先补齐 16 个模型的数值快照。
这是后面每一步「行为不变」的唯一证据；不做这步，后面全是靠肉眼比对。

**Step 1 · 只搬碰撞这一面（1 天，风险最低）**

建 `shared/actor/models/`，把 A1 的 16 段分支体**原样**搬进各自文件，
`createSimpleCollisionFromRender` 改成查表。**签名不变，调用方一个不改**
（`ServerActorFactory`、15 个 `createXModel.ts`、`ClientActorSystem:973` 全部照旧）。
Step 0 的测试必须一行不改地继续绿。

这一步就已经解决了用户问到的那个文件。

**Step 2 · 收掉重复常量（1 天）**

加 `traits`，删掉两份 `PILE_RENDER_MODELS` 和 `isPlayerRenderDefinition`/`PLAYER_RENDER_MODELS`，
改为派生。

**Step 3 · 字段规格与 schema 生成（2-3 天，收益最大）**

加 `fields`，`validateRender` 改写成通用遍历器，`actor.schema.json` 改为生成物 + CI 漂移检查。
这一步一次性干掉 A3 和 A4 两份，也是唯一能消除「schema 没人验证」这个现存漏洞的做法。

**Step 4 · 渲染侧注册表（1 天）**

建 `src/models/actors/registry.ts` + 键一致性测试，`createActorVisualModel` 改为查表并抛错。
**建议排在 `engine-migration-roadmap-vlqccr` 合并之后**——那条分支新增的
`src/render/renderModelFacts.ts` 正好该并进这张表，先做会撞车。

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
