# 软体形变管线

## 一张图

```
                     玩法侧 (Game World)              │      渲染侧 (Render World)
                                                      │
自己的鼠标  指针/相机 ─────────────────────────────────┼──▶ ThreeSlimeSurfaceDrag ──▶ HybridSlimeSimulation
            readSlimeSurfaceDrag ◀────────────────────┤        (拾取射线、命中点、位移都在这一侧)
                 │                                    │                    ▲
                 ▼  player:slime-drag (10Hz)          │                    │ applyReplicated
        ┌──────────────────┐                          │                    │
外力 ──▶│ SoftBodyDeformation                         │            readSlimeDragParams
        │   Component      │─ snapshot.slimeDrag ─▶ RemotePlayer/PlayerEntity ─▶ 参数段 SoA
        └──────────────────┘                          │
              ▲                                       │
      每 tick │ pullToward(施力方位置, 抓握点)          │
        SoftBodyBiteSystem（之后：倒刺 / 抓手）        │
```

## 文件

| 文件 | 归属 | 职责 |
| --- | --- | --- |
| `src/slime/hybrid/HybridSlimeSimulation.ts` | 渲染 | 核心弹簧 + 逐顶点蒙皮，所有硬约束与休眠 |
| `src/slime/hybrid/HybridSlimeRestShape.ts` | 渲染 | 静止外形比例（穹顶、贴地软底） |
| `src/render/three/ThreeSlimeSurfaceDrag.ts` | 渲染 | 本地鼠标拾取 + 复制过来的重放 |
| `src/render/RenderSlimeDrag.ts` | 两侧共用 | 形变参数的读写口，不 import three |
| `src/render/RenderSlimeMotion.ts` | 两侧共用 | 运动参数（速度、离地、碰撞位移）的读写口 |
| `shared/actor/components/SoftBodyDeformationComponent.mjs` | 服务端 + 共享 | 一块外壳当前那一个形变来源 |
| `shared/actor/components/BiteComponent.mjs` | 服务端 + 共享 | 「咬住谁」与判定阈值 |
| `shared/softBodyDeformation.mjs` | 共享 | 净化、坐标换算、命中点求解 |
| `server/actors/SoftBodyBiteSystem.mjs` | 服务端 | 咬住期间每 tick 推进与拉断 |

## 线上格式

快照里被捏的一方带 `slimeDrag`：

```ts
{ revision, contactX, contactY, contactZ, pullX, pullY, pullZ }
```

加一个 `pinch`（0 整团跟随 / 1 命中处拔尖）。全部是**被捏者的外壳坐标**——
Actor 原点 + **世界轴向**，不转 yaw（`worldToShellOffset`）。所以接收端不需要
知道施力方的世界坐标或相机。

这里为什么不是 Actor 本地坐标：外壳不跟着 Actor 转身。`ThreeHybridSlimeVisual`
给 rig 反着转了 `-yaw`（「外壳的弹簧坐标保持世界朝向」），免得转身时整团软体被
当成刚体甩过去，于是求解器的顶点就落在世界轴上。按 Actor 本地坐标算出来的形变
会整体绕 Y 偏掉一个 yaw：两人面对面时正好 180°，尖从被咬者的**背面**冒出来。
两侧都是三个 f32，类型和单元测试都拦不住，只有画面会告诉你。

被拴住的一方还带 `leash`：

```ts
{ anchorX, anchorZ, slack, stiffness, damping }
```

世界坐标，进的是共享固定步 `stepCharacter`，客户端预测与服务端重放算同一件事。
`revision` 是抓取身份，见 SKILL.md 的不变量。坐标取整到 1e-3，重新抓取的判定阈值
（`SLIME_DRAG_REGRAB_DISTANCE` = 0.02）比它大一个数量级，取整不会被误判成换抓取。

咬人的一方另带 `bitingPlayerId`，只为了让交互键知道该松口了。它是离散状态，不插值。

## 参数段布局

`PARAM_SLIME_DRAG_REVISION` 起共 8 个 f32（见 `RenderVisualParams.ts`）：revision、
命中点三个、位移三个、pinch。`revision` 用 f32 存整数：渲染侧只比较「和上一帧
一样吗」，不做算术，一次会话到不了 2^24。

## 可调参数在哪

| 量 | 位置 | 说明 |
| --- | --- | --- |
| `maximumDistance` / `pullForce` / `falloffExponent` / `influenceRadius` | `config/actors/*.actor.json` 的 `slimeSurfaceDrag` | 求解器手感：能拉多远、多硬、越拉越松的速度、影响圈 |
| `breakDistance` / `selfReportTimeoutMs` | 同一份 JSON 的 `softBodyDeformation` | 外力拉多远脱手、自报形变多久过期 |
| `range` / `facingDot` / `pinch` / `gripDepth` | 同一份 JSON 的 `bite` | 嘴够得着多远、要多正对着、咬出来的尖有多尖、贴身咬也至少捏起多深的一块皮 |
| `leashSlack` / `leashStiffness` / `leashDamping` | 同一份 JSON 的 `bite` | 能挣多远、拉多紧、会不会来回荡 |
| `REANCHOR_ALIGNMENT` | `SoftBodyDeformationComponent.mjs` | 抓握点偏离命中处法线多少就把那块皮挪过去（cos 值） |
| `PINCH_INFLUENCE_NARROWING` / `PINCH_CONE_EXPONENT` / `PINCH_GRIP_BLEND_RATE` | `HybridSlimeSimulation.ts` | pinch=1 时影响圈收多少、锥的侧面收敛多快、位置约束淡入多快。影响圈比顶点间距（约 0.2 m）还小就只剩命中点自己动，那是一根针不是一个锥；淡入是为了换抓取时新的尖不要一帧戳出来 |
| 全局跟随权重、质心跟随比例与速率 | `HybridSlimeSimulation.ts` 顶部常量 | 「整团跟着走」而不是只鼓一个包，全部按半径缩放 |

## 加一种外力：地上的倒刺

倒刺是「锚点固定在世界里」的那一类，和咬人只差锚点怎么来：

1. `config/actors/barbed-spike.actor.json` 给它一个 `snag` Component（半径、拉断距离）。
2. `shared/actor/components/SnagComponent.mjs`：`hookedActorId` + 判定参数。
3. `server/actors/SnagSystem.mjs`：踩上去时 `resolveSurfaceContact(radius, player, spikeWorld)` →
   `deformation.grab(spike.id, contact, { pinch, gripDepth, grabDistance, leashSlack, leashStiffness, leashDamping })`；
   之后每 tick `deformation.pullToward(spike.id, player, spikeWorld)`——不传速度，
   于是拖带项是 0，倒刺只拴不拖；也不用给第五个参数，倒刺**自己就是抓握点**
   （嘴不是，所以咬人那条要多传一个 `mouthWorld`）。返回 false 就 `release` 两边。
   抓住之后要立刻兑现一次，否则那一小段窗口里的缰绳锚点还是 (0,0)，形变也要等一个 tick。
4. 客户端一行不用改。

当前这组值（slack 0.2 / k 90 / damping 14 / carry 40 / gripDepth 0.35）的实测：
站着不动的咬人者面前，被咬者冲刺挣脱停在 1.64m（形变 0.35m，不来回荡）；被拖着走
时间距 2.06m、形变 0.69m，都落在求解器可见量程 1.05 之内；全力反抗仍会被拖走
咬人者六成以上的距离。调参时这三条一起看，只盯一条会顾此失彼。

三个要点：

- 位移是「抓握点 − 那块皮现在在哪儿」：被抓住的皮就在抓握点上，所以**抓住的当下
  就有形变**。两种来源用的是同一个式子，倒刺只是抓握点不动，于是变长靠的是玩家
  自己走开。
- 沿法线不足 `gripDepth` 的那一段会被抬回去。倒刺和牙齿一样：贴着皮的时候不能把
  外壳往里压——压出来的是个凹包，不是被钩住。
- 抓握点绕到外壳另一面（偏离命中处法线超过 `REANCHOR_ALIGNMENT`，60°）时，那块皮
  跟着挪过去，并且**算一次新的抓取**（`revision` 加一，接收端重建影响权重）。
  没有这一步，从目标身上越过之后位移几乎整条朝里，被上一条砍掉之后只剩沿旧法线的
  一点点，尖就指向背对施力方的方向。倒刺同理：玩家从它上面走过去，钩住的那块皮
  也该换到脚下那一面。
- 倒刺该多尖？牙齿是 `pinch: 1`。钝的东西（吸盘、泥潭）调低它，就会从「拔出一个尖」
  连续过渡到「整团被拽着走」。
