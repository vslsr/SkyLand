# 动作状态机：让所有人都看得见同一段动画

一条给**动作表现**用的复制通道，加上它两端各一半的状态机。

**现状：第一步、第二步已落地**（吃东西、弹弓拉弓与发射），第三步（世界物件）按
§7 的理由暂缓。下面写的是已经跑着的东西，不是计划。

起因：吃东西那段抖动曾经**只有自己看得见**——它由本地那次按住驱动，从来没过网。
别人眼里那个人只是站着不动，然后手上的果子凭空少了一个。

弹弓把这个问题变得更硬：拉弓要拉将近一秒，这一秒里**别人必须看见他在拉**，否则
「谁要打我」这件事在多人对局里没有任何前摇可读。

这份设计说的就是那条通道：**过网的是「谁在做什么、从什么时候开始」，不是每一帧的
姿态**；两端各自按同一份曲线把它演出来。

状态是本文档要新增的唯一网络概念；曲线、部件、枢轴仍然是渲染侧的代码（这个项目没有
骨骼动画，见 `.cursor/skills/skyland-dsl-designer/references/gameplay-prompts.md` 的
「动画字段 A 落到哪」）。

## 0. 四条不变量

1. **过边界的是状态，不是动画。** 「这个人在吃东西，从服务端时刻 T 开始，要 1.2 秒」
   是玩法量；「身体上下抖 3 下、食物一口口缩到 0.35」是渲染侧的事。
2. **相位由权威开始时刻推导，不逐帧过网。** 两端跑同一个 `holdRatio`，和长按那圈
   圆形倒计时是同一个公式。10Hz 的快照抖动因此不会抖到模型上。
3. **一次性动作靠自增 revision 触发，不靠 bool。** bool 在两帧之间翻回去就会被漏掉；
   revision 变了就是变了（蘑菇松手回弹已经这么做）。
4. **状态是权威已有状态的投影，不是第二份真相。** 它由 `ItemAbilityRuntime` 在授予、
   激活、收回那三个点写入，不额外维护一套「现在该播什么」的判断——两份真相迟早会在
   某条路径上分家（用光了、被打断、切走手持物）。

## 1. 为什么是状态机，不是「播放一次」的事件

发一条 `play('eat')` 事件是最直觉的做法，也是最先坏掉的做法：

- **丢一帧就永远错过。** 快照是全量状态、允许丢，事件不是。
- **中途进入的人看不到。** 半路加载进 AOI 的玩家收到的是当前状态；事件已经发过了，
  他看到的是一个站着不动、却在扣血或扣货的人。
- **打断没有对应的事件。** 「吃到一半被切走手持物」要再发一条 `stop`，而 `stop` 同样
  会丢。状态机里这件事就是「状态变回 Idle」，下一帧快照自然收敛。

状态 + 开始时刻是**可收敛**的：任何一帧快照到达，客户端都能算出「现在应该演到哪一
拍」，不需要知道之前发生过什么。这和位置、天气、昼夜、箱盖用的是同一条原则。

而「状态机」这个词在这里不是新造一套东西——**它就是 GAS**。能力被授予 / 激活 /
结束就是转移，`ownedTags` 就是状态。这份设计只是把它的一个投影发出去。

## 2. 状态长什么样

```ts
/** 一个 Actor 正在做的那件事。没在做什么时整个字段不下发。 */
export interface SnapshotActionState {
  /** `<动词>.<相位>`，例如 `eat.hold`、`shoot.charge`、`shoot.fire`。 */
  state: string;
  /** 这次动作用的是哪件物品；手上那件按它挑曲线。没有物品的动作不带。 */
  itemType?: string;
  /** 权威开始时刻，毫秒，和 `RoomSnapshot.serverTime` 同一条时间轴。 */
  startedAt: number;
  /** 走完一整轮多久，秒。0 = 没有确定长度（拉满了等松手那一段）。 */
  duration: number;
  /** 每进入一次新状态 +1。一次性动作靠它触发，也靠它区分「连着做了两次」。 */
  revision: number;
}
```

**`<动词>.<相位>` 两段式**是刻意的：渲染侧的注册表先按整条 id 找曲线，找不到就退回
只按动词找。这样「弹弓拉弓」有专门的曲线，而「一切 charge 的通用蓄力抖动」可以只写
一份，新物品不写曲线也不会一动不动。

相位就是使用能力那三个已经存在的时刻，不新造：

| 相位 | 什么时候进 | 什么时候出 | ratio 怎么算 |
| --- | --- | --- | --- |
| `hold` | `use:begin`（`mode: hold`） | 圈满激活 / 取消 | `elapsed / holdSeconds`，圈满 = 1 |
| `charge` | `use:begin`（`mode: charge`） | 松手 / 取消 | 同上，**满了停在 1** 等松手 |
| `fire` | 激活那一刻 | `duration` 走完 | `elapsed / duration`，播完回 Idle |

`tap` 没有 `hold` 相位，按下去直接是一次 `fire`。

放在两处，形状完全一样：

- `SnapshotPlayer.action?`——玩家。**发给所有人**（不像背包只发给本人）：别人在做
  什么本来就是看得见的事。
- `SnapshotActor.action?`——世界 Actor。**这一版没有落地这一半**，理由见 §7：
  今天没有一个世界物件的动作是它演得出来的。

**手上那件不带自己的状态。** 它是挂在玩家身上的纯表现体，动作是玩家的动作——它读
玩家那一份，用 `itemType` 挑自己那条曲线。给它单独发一份，两份在丢帧时会错开，
表现就是人在嚼、食物不动。

## 3. 服务端：一个组件，三个写入点

新增 `ActionStateComponent`（`shared/actor/components/`），只存上面那五个字段加一个
`priority`。它由 `ItemAbilityRuntime` 写，不自己判断任何事：

| 写入点 | 写成什么 |
| --- | --- |
| `beginItemUse` | `<action>.<mode>`，`duration = holdSeconds`，`startedAt = now` |
| `activateItemAbility` | `<action>.fire`，`duration = 该动词的表现时长` |
| `cancelItemUse` / `revokeItemAbility` | 清空（回 Idle） |

`fire` 的表现时长是**渲染常量**，不是物品目录里的字段：它说的是「这段表现演多久」，
和玩法判定无关（判定在圈满/松手那一刻就完成了）。写进物品目录会让人以为改它能改
玩法。放在 `shared/animation/actionStates.mjs` 的一张小表里，两端共读。

**为什么是组件而不是直接读 `player.itemAbility`**：itemAbility 里有「这次扣的是背包
还是物品栏第几格」这类不该过网的玩法细节，而将来受击、砍树、上下船这些动作根本不
经过物品能力。组件是那条通道的**唯一入口**，谁想让一个动作被别人看见，就往它写一次。

同一时刻只有一条状态：一个身体同时只演一件事。两条同时来时按 `priority` 取高的
（受击 > 使用物品），低的那条直接不进——不做队列，玩家看不出「排着队的动作」和
「被吃掉的动作」的区别，而队列会让表现比玩法晚上几百毫秒。

## 4. 客户端：一个采样器 + 一张曲线注册表

```
快照 action → ActionStateSampler → { state, ratio, elapsed, itemType, fired }
                                        ↓
                        ActionClipRegistry.find(state, role)
                                        ↓
                 role 'actor' → 玩家模型偏移      role 'held' → 手上那件的偏移/缩放
```

**姿态位移写在角色自己的坐标系里**（x 右、y 上、z 身前），读它的三处（本地玩家、
远端玩家、手上那件）各自按自己的 yaw 转一次。拉弓要往「身后」拉，而「后」只有在
角色朝向里才说得通——写成世界坐标的话，玩家一转身，弓就往错误的方向拉了。

**采样器**（`src/animation/ActionStateSampler.ts`）只做时间换算：

```ts
const serverNow = snapshots.serverTimeAt(now) - INTERPOLATION_DELAY_MS;
const elapsed = (serverNow - action.startedAt) / 1000;
const ratio = holdRatio(elapsed, action.duration);
```

延迟那一项很重要：远端玩家的**位置**是按 `renderTime = now - offset - 插值延迟` 采样
的，动作相位必须用同一个时刻，否则手上那件会在模型还没走到位时就先动起来。
**本地玩家不减这一项**——自己的动作不该比自己的输入晚 100 毫秒。

**曲线注册表**（`src/animation/ActionClipRegistry.ts`）和服务端的 `ItemUseActions`
是对称的一对：

```ts
registerActionClip('eat.hold', 'actor', (phase) => ({ offset: chewBodyOffset(phase.ratio) }));
registerActionClip('eat.hold', 'held',  (phase) => ({
  offset: chewBodyOffset(phase.ratio),
  scale: chewFoodScale(phase.ratio),
}));
```

- 曲线是**纯函数**，输入 `{ ratio, elapsed, itemType }`，输出一份姿态偏移。
- **两个部件读同一份曲线**：角色抖和食物变小共用 `chewAnimation.ts` 这条规矩不变，
  这正是它们能嚼在同一拍上的原因。
- 找不到曲线就不动，不报错：目录里先有一件新物品、曲线后补是常态。

**本地玩家不等快照。** 和背包里点「使用」同一个理由：快照 10Hz，等它回来再进状态，
自己按下去那一下会晚 100 毫秒才动。所以本地在发 `use:begin` 的同一刻就本地进状态；
快照到达后以服务端那份为准，但**状态相同时不重置相位**（重置会让本地每 100 毫秒
抖回去一次）。这是一次表现层的本地预测，它不改任何账。

## 5. 带宽

一条状态 ≈ 40 字节，只在非 Idle 时下发。10 个人同时在做动作 = 400 B/帧、10Hz =
4 KB/s，和现有的 `slimeDrag` 一个量级。不做增量、不做压缩：快照本来就是全量，
为一条只在动作期间出现的字段做增量不划算。

## 6. 落地要动的地方

「世界 Actor」那两行还没做（§7），其余都已经在跑。

| 去处 | 做什么 |
| --- | --- |
| `shared/animation/actionStates.mjs` | 状态 id 的拼法、`fire` 的表现时长表，两端共读 |
| `shared/actor/components/ActionStateComponent.mjs` | 那五个字段 + `priority`，快照与 `applySnapshot` |
| `server/actors/ItemAbilityRuntime.mjs` | 三个写入点（begin / activate / cancel-revoke） |
| `server/scene/ServerScene.mjs` | 玩家快照带上 `action`（发给所有人） |
| `src/network/protocol.ts` | `SnapshotPlayer.action`（`SnapshotActor.action` 暂缓） |
| `src/animation/ActionStateSampler.ts` | 快照 + 时钟 → `{ state, ratio, fired }` |
| `src/animation/ActionClipRegistry.ts` | `(state, role) → 曲线`；`eat` 那两条从现有代码迁进来 |
| `src/player/PlayerEntity.ts` / `RemotePlayer.ts` | 本地与远端玩家都读采样器，替掉 `setChewing` |
| `src/actors/systems/ActorInstanceSystem.ts` | 手上那件读同一份采样结果，替掉 `chewRatioOf` |
| `src/controllers/HotbarController.ts` | 按下的同一刻本地进状态（表现层预测） |

## 7. 分三步，走到了第二步

1. **通道 + 吃东西迁过去。**（已落地）两个客户端，一个人吃果子，另一个看得见他在
   嚼、手上那颗在变小。这一步没新增任何动画，只是把已有的那段搬上通道。
2. **弹弓接上。**（已落地）`shoot.charge` 往后拉、往下沉、拉满之后抖；`shoot.fire`
   一记后坐。武器系统只管弹丸飞出去，两边在 `ItemUseActions` 那条注册表上分开着。
   `shoot.fire` 现在演不出来——`shoot` 还没有执行器，**空转的一次不该有动作**。
3. **世界 Actor。暂缓，而且不是因为没时间。** 落地前面两步之后回头看，今天没有一个
   世界物件的动作是这条通道演得出来的：

   - **树、石头这些世界物件是按 chunk 烘进网格的**（只有一个「这一株被采掉了」的
     覆盖位，没有按物件的实例变换）。「被敲中晃一下」要先有一条按物件的实例通道，
     那是渲染侧的一个项目，比这条状态通道本身大得多。
   - **箱盖已经有更合适的做法**：过一个 0/1 的目标值，回弹在渲染侧用弹簧积分。
     状态机说的是「在做什么」，不是「现在开到几度」——把它改过来是降级。
   - 剩下的世界 Actor（篝火、方尖碑、货箱）今天没有要演的动作。

   所以 `SnapshotActor.action` 没有落地：一条没有人写的通道不是「留给将来」，是
   一个迟早和现实分家的空壳。第三个动作真的出现时，再按这份设计把它接上——
   要动的地方 §6 已经列清楚了。

## 8. 不做什么

- **不做骨骼动画、不做动作名。** 全仓库没有 `SkinnedMesh`、`AnimationMixer`，模型都是
  代码搭的。状态 id 是「在做什么」，不是「播哪个 clip 资源」。
- **不做过渡混合。** 没有骨骼就没有姿态可混；程序化曲线在 `ratio → 0` 处自己收敛。
- **不把姿态过网。** 一帧一个偏移量既贵又抖，而且它是渲染侧的推导结果，不是玩法。
- **不给每个物品配一条动画。** 曲线按 `<动词>.<相位>` 复用，物品只在真的长得不一样
  时才写自己那条。
