# Gameplay DSL prompts

Read this reference only when the task touches gameplay entries (`@i`, `@b`, `@w`, reserved `@e`), animation field `A`, configuration/code landing, or implementation status.

# 定义格式

## 物品定义
* @i <物品名称>: <说明>
    * M: <模型说明，手持、掉落时使用一套模型>
    * I: <物品Icon说明>
    * F: <物品使用功能>
    * G: <分类>
    * N: <堆叠上限>
    * R: <是否有耐久，有的话耐久度，0或不写为无>
    * AM: <弹药位：吃哪几种弹药、装几发，不写为不吃弹药>
    * A: <动画说明，见「动画定义」>

## 建筑定义
* @b <建筑名称>: <功能说明>
    * M: <建筑块模型说明>
    * I: <对应物品名称，当使用此物品时，进入建造模式，切换到其他物品时退出建造模式>
    * T: <建筑块类型: 地基、墙壁、物件>
    * L: <物件互斥表，某个吸附点只能容纳哪几个类型的物件>
        * <可容纳的物件名称>: <数量，如果为0或没有此条记录，则在放置了这个物件后不可容纳>
    * A: <动画说明，见「动画定义」>


## 武器、工具定义
* @w <武器、工具名称>: <功能说明>
    * M: <工具模型说明，手持、掉落使用同一套模型，但是手持模型会稍小一点>
    * I: <关联的物品>
    * B: <关联的建筑定义，如果没有或为0，则说明此武器是轻型武器>
    * D: <工具的数据>
        * Attack：<攻击力，如果是蓄力衰减会在这里说明，可以为0>
            * Tag：<说明该工具对某个物品标签的效果，对于不同的对象会产生不同的效果(比如斧子砍树会更快)>
        * CD: <攻击、使用频率，CD时间内的效果说明>
        * Effect: <击中后产生的效果>
        * EQS: <如何进行判定的，比如范围伤害>
    * A: <动画说明，见「动画定义」>

## 动画定义
* A: <这件东西在哪些状态下会动>
    * <状态>: <动哪个部件、怎么动、由什么驱动>

* 这个项目没有骨骼动画，动画一律是`程序化`的：写`哪个部件按什么曲线动`，不要写动作名或资产名
* 状态常用这些：待机、手持、蓄力、发射、使用、装填、命中、建造、拆除、交互、工作、冷却。
  不够用就加一个说得清楚的，这不是一份封闭清单
* 驱动量四选一，写在状态说明里：
    * `比例`: 跟着一个 0 到 1 的量走，圈走到哪动画就到哪。蓄力、长按使用都用它
    * `一次性`: 触发后自己走完，要写时长
    * `持续`: 只要处在这个状态就一直动，要写周期
    * `目标值`: 玩法只给一个目标，从当前值到目标那一段回弹由表现自己算，要写是否有回弹
* 同一件事里一起动的几个部件写在同一个状态下，它们读同一份曲线
* 默认是`纯表现`：不过网、不上报、不改玩法数值，代价是只有自己看得见。要让别人也看见就写`需复制`

## 实体
* 正在设计中

# 落地映射

每个字段最终写进仓库的哪里。**表里的「现状」一栏是实话**：这套 DSL 比实现跑得快，
有些字段今天还没有承接它的系统。

## `@i` → 物品目录

物品是**两份配置合起来**的：账上那一条在 `config/items/item-catalog.json`
（受 `item-catalog.schema.json` 约束），世界里那个看得见的实体在
`config/actors/<name>-pile.actor.json`。手持时挂在角色身上的那个是掉落物原型被
`heldItemArchetype()` 现场裁掉碰撞、掉落物理、生命期与可交互之后的纯表现体——
所以 `M` 只写一套模型说明，落地也只有一份模型。

| 字段 | 落到哪 | 现状 |
| --- | --- | --- |
| 名称 | `displayName`；同时取一个 kebab-case 英文 `id`（`木头` → `wood`） | ✅ |
| 说明 | `summary`（≤ 64 字） | ✅ |
| `M` | 掉落物原型的 `components.render`（`model` + 颜色 + 尺寸） | ✅ |
| `I` | `iconId` + `tint`；SVG 画进 `src/ui/icons/ItemIconSprite.ts` | ✅ |
| `F` | `use: { action, input, mode, holdSeconds, cooldownSeconds, value }`；**「不能使用」= 整个 `use` 不写** | ✅ 动词限 `eat` / `shoot` / `tool` / `throw`；`mode` 有 `tap` / `hold` / `charge`（蓄力松手才结算）。`shoot` 的执行器由**武器系统**注册，见 `server/actors/ItemUseActions.mjs` |
| `G` | `category` | ✅ 见下表 |
| `N` | `stackLimit`；另配 `slotCost`（占几个货位，`0` 走独立池） | ✅ |
| `R` | `durability`，`0` 或不写就不写这个字段 | ⚠️ 字段可配，还没有系统消耗它 |
| 冷却 | `use.cooldownSeconds`；落成能力自己的 `cooldown`，按**物品种类**分组 | ✅ 冷却中按不下去，圈都不开始画 |
| `AM` | 目录里一个 `ammo: { accepts, capacity }`（`accepts` 写**物品 id**，不写分类），加上格子上的一段弹药状态 | ✅ 只有 `slotCost: 0` + `stackLimit: 1` 的物品能写；装填 / 卸下走 `ammo:load` / `ammo:unload`。掉落物还记不住弹药，丢下时先卸回身上 |
| `A` | 渲染侧代码，不是 JSON。见[动画字段 A 落到哪](#动画字段-a-落到哪) | ⚠️ 吃东西那段已落地，其余靠一事一议 |

`G` 的取值对照 `category` 枚举：

| 设计稿写法 | `category` |
| --- | --- |
| 材料 | `material` |
| 补给 | `supply` |
| 投掷物 | `throwable` |
| 弹药 | `ammunition` |
| 价值货物 | `valuable` |
| 工具 / 轻型工具 / 重型工具 | `tool` |

`F` 写的是「按下去发生什么」，落地时拆成四件事：做什么（`action`）、
走哪个输入槽（`input`，目前只有 `primary`）、怎么触发（`mode` = `tap` / `hold` / `charge`，
后两种补 `holdSeconds`）、力度或个数（`value`）。`hold` 的圈满是结算，`charge` 的圈满
只是「攒到头了」，松手才打出去。兑现路径固定是
**授予玩家一条 Ability → 按 `mode` 激活 → 完成后收回**，见
[`shared/items/ItemAbility.mjs`](../../../../shared/items/ItemAbility.mjs)。
长按那圈倒计时画满的那一刻就是服务端判定激活的那一刻，两端读同一份 `holdSeconds`。

## `@b` → 建造件 Component

| 字段 | 落到哪 | 现状 |
| --- | --- | --- |
| 名称 | `buildPiece.label`（≤ 32 字）；文件名与 `id` 用 kebab-case | ✅ |
| `T` | `buildPiece.kind`：地基 → `foundation`（占一格）、墙壁 → `wall`（占一条格边）、物件 → `fixture`（占格中心一个槽） | ✅ |
| `M` | `components.render`。地基必须用 `line-art-build-foundation`，墙必须用 `line-art-build-wall`，物件**不能**用这两个；墙宽必须等于建造格宽 | ✅ 由 `ActorCatalog` 强制 |
| `L` | `buildPiece.slot`：**同槽互斥，异槽共存**。一格里篝火和棚子各占一个槽所以能同在，两个篝火不行 | ⚠️ `slot` 只有「有/没有」两态，`L` 表里 `数量 > 1` 目前落不了地 |
| `I` | 用某件物品进入建造模式 | ❌ 未兑现。现在建造栏列的是场景 `gameplay.runtimeActorArchetypes` 声明的件，与手持物品无关 |
| `A` | 渲染侧代码，不是 JSON。见[动画字段 A 落到哪](#动画字段-a-落到哪) | ⚠️ 箱盖开合、火焰已落地，建造/拆除还没有 |

`@b` 没写、但落地**必填**的字段——写新条目时按 `@design` 明确给出，别让实现方猜：

* `surface`：`floating`（水上建筑，吸附到船体的 `buildGrid`，件成为船的子 Actor）/
  `static`（静态建筑，吸附世界对齐的地形格）/ `any`（只有物件能用）。
* `reach`：角色到放置位的最大水平距离，米。
* `cost`：放一件扣多少材料，`[{ itemType, quantity }]`。拆除全额退回。
* `mass`：水上件进浮力结算的质量（静态件不写）；`buoyancy`：只有水上地基写；
  `hull`：水上地基放在开阔水面上时立起来的船体根节点原型 id。

规则本身（哪一格合法、吸附到哪、红绿怎么判）只有 `shared/build/` 一份，
客户端拿它画幽灵、服务端拿它做最终裁决。散文版设计在
[`doc/desinger-buildsys.md`](../../../../doc/desinger-buildsys.md)。

## `@w` → 物品目录里的 `weapon` 块

`@w` 落在**它 `I:` 指着的那件物品**上，不另开一份武器表：一件东西只有一条账。

* **轻型工具**（`B` 为空或 `0`）：玩家拿在手上。采集类走 `use.action: "tool"`
  （`use.value` 是采集力度）；打人的走 `use.action: "shoot"` + 同一条物品上的
  `weapon` 块，`use.mode` 必须是 `charge`（长按蓄力，松手开火）。没有 `weapon` 块的
  `shoot` 物品是一把打不响的武器：动词认得，兑现不了。
* **重型工具**（`B` 指向一条 `@b`）：玩家拿不住，放出来才能用。落地是**一条 `@i` 加一条 `@b`**：
  背包里那一摞是物品，放出去那个是 `fixture` 建造件。`@i 篝火物品` + 篝火建造件就是这个形状。

`D` 之下五项现在都有承接，判定内核在
[`server/actors/WeaponRuntime.mjs`](../../../../server/actors/WeaponRuntime.mjs)（它把物品系统
留出来的 `shoot` 动词认领下来），
两端共用的换算在
[`shared/items/weaponStrike.mjs`](../../../../shared/items/weaponStrike.mjs)：

| 字段 | 落到哪 | 现状 |
| --- | --- | --- |
| `Attack` | `weapon.attack`，乘上蓄力倍率之后走 `applyDamage` | ✅ |
| `Attack.Tag` | `weapon.tagMultipliers`，标签由 Component 推导（`shared/actor/actorTags.mjs`） | ✅ 按声明顺序取第一条命中的；建造件还没有生命值，所以打不到 |
| `CD` | `use.cooldownSeconds`（写在用法上，和别的动词同一处）→ `AbilityDefinition.cooldown`，分组按物品取 | ✅ |
| `Effect` | 命中即扣血；附加状态（点燃、减速）还要各自的 `EffectDefinition` | ⚠️ 伤害已通，别的效果一事一议 |
| `EQS` | `weapon.radius` + `weapon.range`：权威朝向 × 蓄力比例反解落点，落点半径内全中 | ✅ 只有这一种取法；单体与射线还没有 |

**抛物线不属于 `EQS`。** 它是 `A` 里的表现：判定只认落点与半径，客户端那条白线读
的是同一份 `weaponStrike` 换算，所以瞄的地方和打中的地方是同一处。

**`@w` 不假定射手是玩家。** 判定入口是 `fireWeaponFrom(scene, shooter, weapon, ratio)`，
只要求 shooter 带 Transform；`shoot` 这个使用动词只是它在物品那一侧的薄封装。所以同
一条 `@w` 既是玩家手上那把，也是 AI 手上那把——AI 侧写一条 `weaponUser` Component
（只写 `itemType` 加这个单位自己的交战距离与犹豫时长，**不写第二份数值**），开火、
扣血、复制走的都是同一条路径。AI 蓄到几成由目标有多远反解
（`weaponChargeRatioForDistance`）：弓手瞄的是人，不是最大射程。

`A` 在工具上尤其要写全：蓄力那一段是 `比例` 驱动（跟长按圈同一个量），开火那一下是
`一次性`，冷却是 `持续` 或 `比例`。重炮的蓄力抛物线细线也归 `A`——它是表现，不是判定，
判定写在 `EQS`。

标签用 `src/tags/` 的点分层级写法（`Item.Material.Wood`、`State.Item.Using`），
只能由字母数字下划线和点组成，区分大小写，`A.B` 匹配 `A.B.C`。

## 动画字段 A 落到哪

`A` 和别的字段有个根本差别：**它落地成代码，不落地成 JSON。** `M`/`G`/`N` 最后是
配置文件里的一行，`A` 最后是 `src/render/` 里的一个 Visual。所以不要指望给 `A` 加一个
schema 字段，也不要因为「配置里没有这一项」就以为它没落地。

写 `A` 之前先认下三条硬约束：

**一、这个项目没有骨骼动画。** 全仓库 `SkinnedMesh`、`AnimationMixer`、`GLTFLoader`
都是 0——一个美术资产都不加载，模型全是代码搭出来的。所以 `A` 写的是**哪个部件、绕哪个
枢轴、按什么曲线动多少**，不是「播 attack 这个动作」。史莱姆形变、腿、箱盖、火焰，
今天全是这么做的。写成动作名的 `A` 落不了地。

**二、驱动量优先写比例，不写秒数。** 已经落地的吃东西那段
（[`src/player/chewAnimation.ts`](../../../../src/player/chewAnimation.ts)）输入是 `ratio` [0, 1]
而不是秒：圈走到哪就嚼到哪，长按多久都自动对齐。凡是跟着蓄力或长按走的动画都这么写。

**三、过边界的是玩法量，不是动画量。** 储物箱只把「有几个人开着」这个目标值过网，
从关到开那段回弹在渲染侧用弹簧阻尼积分出来。把角度本身过网的话，10Hz 快照的抖动会
直接抖到盖子上。

| 驱动量 | 要一起写清楚的 | 已落地的例子 |
| --- | --- | --- |
| `比例` | 比例是谁给的 | 吃东西跟长按圈走同一个 `ratio` |
| `一次性` | 时长，以及**靠什么触发** | 蘑菇被松手弹回去那一下 |
| `持续` | 周期 | 篝火火焰、水面起伏 |
| `目标值` | 有没有回弹 | 箱盖：过网只有 0/1，回弹在渲染侧 |

`一次性`的触发用**一个自增的 revision**，不用 bool：bool 在两帧之间翻回去就会被漏掉，
revision 变了就是变了。蘑菇松手回弹走的就是这条（`PARAM_ELASTIC_RELEASE_REVISION`
一变，渲染侧踢一脚速度）。

落地去处：

| `A` 的一部分 | 落到哪 |
| --- | --- |
| 动画本身 | `src/render/three/Three*Visual.ts` 里一个 Visual |
| 曲线 | 一个纯函数模块。**两个以上部件读它时必须共用一份**——角色抖和食物变小共用 `chewAnimation.ts`，各写一套的话拍子迟早对不上，看起来像两件事 |
| 玩法侧那个驱动量 | 渲染边界上的一个 visual param |

**`纯表现` 是默认，`需复制` 要另付代价。** 今天吃东西那段抖动**只有自己看得见**，
因为它不在复制里。要让别人也看见，得让那个驱动量走上复制通道（像箱盖过一个目标值那样），
或者等角色动作有自己的通道。为一段抖动单开一条网络状态不值得——所以 `A` 里写 `需复制`
之前，先说清楚为什么别人必须看见。

# 从一条定义到一次改动

1. **在设计稿里写条目。** `@i` 写进 `doc/designer-inventory.md` 的物品表，
   `@b` / `@w` 写进对应设计稿。记法本身的改动才写这里。
2. **对着上面的映射表逐字段落地。** 每个字段都要有去处；没有去处的字段
   （今天是 `@b` 的 `I`）说明这次改动带的是**新系统**，不是新数据——
   先把系统的边界说清楚再动手。
3. **补齐 DSL 没写但 schema 必填的字段**，按上面各节的清单。
4. **改 schema 才算扩了 DSL。** 往 `category`、`use.action`、`buildPiece.kind`
   里加一个值，是往这门语言里加一个词：JSON Schema、服务端校验、客户端类型、
   渲染工厂、测试要一起改，缺一处就是运行期才炸。
5. **验证**：`npm run test:server`（目录与建造校验）、`npm run test:client`、
   `npm run build`。

# 完整示例

一件轻型工具，从设计稿到配置。设计稿里写：

```markdown
* @i 石斧: 敲得动树的一把粗糙斧头
    * M: 一根木柄顶端绑一块削尖的扁石头，手持时略小
    * I: 用斧头的侧影绘制 SVG
    * F: 点按敲击面前的可采集物件，采集力度 3
    * G: 工具
    * N: 1
    * R: 0
    * A:
        * 手持: 斧头贴在身侧，不动
        * 使用: 一次性 0.25 秒，斧头绕手腕下劈再回位，下劈占前 1/3；纯表现
```

落成 `config/items/item-catalog.json` 里的一条：

```json
{
  "id": "stone-axe",
  "displayName": "石斧",
  "category": "tool",
  "stackLimit": 1,
  "slotCost": 0,
  "iconId": "item-stone-axe",
  "tint": "#B9B4A8",
  "summary": "敲得动树的一把粗糙斧头。",
  "holdable": true,
  "use": { "action": "tool", "input": "primary", "mode": "tap", "value": 3 }
}
```

`R: 0` 所以不写 `durability`；`G: 工具` 落到 `category: "tool"`，它走独立池所以
`slotCost` 是 `0`；`M` 落到 `config/actors/stone-axe-pile.actor.json` 的
`components.render`；`I` 的 SVG 补进 `src/ui/icons/ItemIconSprite.ts`。
