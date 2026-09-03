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
      每 tick │ pullToward(anchorLocal)               │
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

加一个 `pinch`（0 整团跟随 / 1 命中处拔尖）。全部是**被捏者的 Actor 本地坐标**，
所以接收端不需要知道施力方的世界坐标或相机。

被拴住的一方还带 `leash`：

```ts
{ anchorX, anchorZ, slack, stiffness, damping }
```

世界坐标，进的是共享固定步 `stepCharacter`，客户端预测与服务端重放算同一件事。
`revision` 是抓取身份，见 SKILL.md 的不变量。坐标取整到 1e-3，重新抓取的判定阈值
（`SLIME_DRAG_REGRAB_DISTANCE` = 0.02）比它大一个数量级，取整不会被误判成换抓取。

咬人的一方另带 `bitingPlayerId`，只为了让交互键知道该松口了。它是离散状态，不插值。

## 参数段布局

`PARAM_SLIME_DRAG_REVISION` 起共 7 个 f32（见 `RenderVisualParams.ts`）。`revision`
用 f32 存整数：渲染侧只比较「和上一帧一样吗」，不做算术，一次会话到不了 2^24。

## 可调参数在哪

| 量 | 位置 | 说明 |
| --- | --- | --- |
| `maximumDistance` / `pullForce` / `falloffExponent` / `influenceRadius` | `config/actors/*.actor.json` 的 `slimeSurfaceDrag` | 求解器手感：能拉多远、多硬、越拉越松的速度、影响圈 |
| `breakDistance` / `selfReportTimeoutMs` | 同一份 JSON 的 `softBodyDeformation` | 外力拉多远脱手、自报形变多久过期 |
| `range` / `facingDot` / `pinch` | 同一份 JSON 的 `bite` | 嘴够得着多远、要多正对着、咬出来的尖有多尖 |
| `leashSlack` / `leashStiffness` / `leashDamping` | 同一份 JSON 的 `bite` | 能挣多远、拉多紧、会不会来回荡 |
| `PINCH_INFLUENCE_NARROWING` / `PINCH_WEIGHT_EXPONENT` | `HybridSlimeSimulation.ts` | pinch=1 时影响圈收多少、权重profile 多陡 |
| 全局跟随权重、质心跟随比例与速率 | `HybridSlimeSimulation.ts` 顶部常量 | 「整团跟着走」而不是只鼓一个包，全部按半径缩放 |

## 加一种外力：地上的倒刺

倒刺是「锚点固定在世界里」的那一类，和咬人只差锚点怎么来：

1. `config/actors/barbed-spike.actor.json` 给它一个 `snag` Component（半径、拉断距离）。
2. `shared/actor/components/SnagComponent.mjs`：`hookedActorId` + 判定参数。
3. `server/actors/SnagSystem.mjs`：踩上去时 `resolveSurfaceContact(radius, player, spikeWorld)` →
   `deformation.grab(spike.id, contact, { pinch, grabDistance, leashSlack, leashStiffness, leashDamping })`；
   之后每 tick `deformation.pullToward(spike.id, player, spikeWorld)`——不传速度，
   于是拖带项是 0，倒刺只拴不拖。返回 false 就 `release` 两边。抓住之后要立刻兑现
   一次，否则那一小段窗口里的缰绳锚点还是 (0,0)。
4. 客户端一行不用改。

当前这组值（slack 0.2 / k 90 / damping 14 / carry 40）的实测：站着不动的咬人者面前，
被咬者冲刺挣脱停在 1.64m（形变 0.44m，振幅 0.004，不来回荡）；被拖着走时间距 2.13m、
形变 0.93m，落在求解器可见量程 1.05 之内；全力反抗仍会被拖走咬人者六成以上的距离。
调参时这三条一起看，只盯一条会顾此失彼。

两个要点：

- 倒刺不动，所以是**玩家自己走开**把外壳拉长的。位移永远是「被捏者 → 施力方」的
  方向乘上多分开的距离，两种来源用的是同一个式子。
- 倒刺该多尖？牙齿是 `pinch: 1`。钝的东西（吸盘、泥潭）调低它，就会从「拔出一个尖」
  连续过渡到「整团被拽着走」。
