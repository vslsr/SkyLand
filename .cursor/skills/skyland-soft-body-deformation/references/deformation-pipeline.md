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
        │ SoftBodyDeformation │─ snapshot.slimeDrag ─▶ RemotePlayer/PlayerEntity ─▶ 参数段
        │   Component（只有关系与缰绳）│                │                    │
        └──────────────────┘                          │                    │ setBiteTip
              ▲                                       │                    │
      每 tick │ updateHold(施力方位置)                 │            readSlimeBiteParams
        SoftBodyBiteSystem（之后：倒刺 / 抓手）        │                    ▲
                 │                                    │                    │
                 └─ snapshot.bitingPlayerId ─▶ slimeBiteTip.ts（按两边位置当场算）
```

被咬成什么样**不过网络**：只有「谁咬着谁」这一个离散状态过去，两边的位置本来就
是权威复制过来的，所以每个客户端自己算那个向量——省六个数，而且算的是当前渲染帧
的插值位置，尖不会比位置慢一个快照。

## 文件

| 文件 | 归属 | 职责 |
| --- | --- | --- |
| `src/slime/hybrid/HybridSlimeSimulation.ts` | 渲染 | 核心弹簧 + 逐顶点蒙皮，所有硬约束与休眠 |
| `src/slime/hybrid/HybridSlimeRestShape.ts` | 渲染 | 静止外形比例（穹顶、贴地软底） |
| `src/render/three/ThreeSlimeSurfaceDrag.ts` | 渲染 | 本地鼠标拾取 + 复制过来的重放 |
| `src/render/RenderSlimeDrag.ts` | 两侧共用 | 形变参数的读写口，不 import three |
| `src/render/RenderSlimeMotion.ts` | 两侧共用 | 运动参数（速度、离地、碰撞位移）的读写口 |
| `shared/actor/components/SoftBodyDeformationComponent.mjs` | 服务端 + 共享 | 一块外壳当前那一个来源：自报拖拽的转发 + 外力的关系与缰绳，**没有形状** |
| `src/player/slimeBiteTip.ts` | 客户端玩法 | 按两边位置算出那个突起向量 |
| `src/render/RenderSlimeBite.ts` | 两侧共用 | 突起向量的读写口，不 import three |
| `shared/actor/components/BiteComponent.mjs` | 服务端 + 共享 | 「咬住谁」与判定阈值 |
| `shared/softBodyDeformation.mjs` | 共享 | 净化、坐标换算、命中点求解 |
| `server/actors/SoftBodyBiteSystem.mjs` | 服务端 | 咬住期间每 tick 推进与拉断 |

## 线上格式

自己上报的鼠标拖拽仍然过网络（别人无从知道你的指针在哪）：

```ts
{ revision, contactX, contactY, contactZ, pullX, pullY, pullZ }
```

被捏者的**外壳坐标**——Actor 原点 + **世界轴向**，不转 yaw（`worldToShellOffset`
那条注释解释了为什么）。

**被别人咬住的形状不过网络。** 关于「咬」，快照里只有咬人的一方带一个
`bitingPlayerId`，离散状态，不插值。突起向量由每个客户端按两边位置自己算
（`slimeBiteTip.ts`）：方向是「被咬者身体中心 → 咬人者的嘴」，长度是嘴离外壳多远、
保底 `bite.gripDepth`。两边喂同一份权威输入，算出来一样；也没人能伪造，因为根本
没人发。

被拴住的一方还带 `leash`：

```ts
{ anchorX, anchorZ, slack, stiffness, damping }
```

世界坐标，进的是共享固定步 `stepCharacter`，客户端预测与服务端重放算同一件事。
坐标取整到 1e-3，重新抓取的判定阈值（`SLIME_DRAG_REGRAB_DISTANCE` = 0.02）比它大
一个数量级，取整不会被误判成换抓取。

## 参数段布局

`PARAM_SLIME_DRAG_REVISION` 起 7 个 f32 是鼠标拖拽（revision、命中点三个、位移
三个），紧接着 `PARAM_SLIME_BITE_X/Y/Z` 三个是咬住的突起向量。`revision` 用 f32
存整数：渲染侧只比较「和上一帧一样吗」，不做算术，一次会话到不了 2^24。

## 可调参数在哪

| 量 | 位置 | 说明 |
| --- | --- | --- |
| `maximumDistance` / `pullForce` / `falloffExponent` / `influenceRadius` | `config/actors/*.actor.json` 的 `slimeSurfaceDrag` | 求解器手感：能拉多远、多硬、越拉越松的速度、影响圈 |
| `breakDistance` / `selfReportTimeoutMs` | 同一份 JSON 的 `softBodyDeformation` | 外力拉多远脱手、自报形变多久过期 |
| `range` / `facingDot` / `gripDepth` | 同一份 JSON 的 `bite` | 嘴够得着多远、要多正对着、贴身咬至少捏起多深的一块皮（客户端算向量时用） |
| `leashSlack` / `leashStiffness` / `leashDamping` | 同一份 JSON 的 `bite` | 能挣多远、拉多紧、会不会来回荡 |
| `BITE_TIP_EXPONENT` / `BITE_TIP_NARROWING` / `MAX_BITE_TIP_RADIUS_RATIO` / `BITE_TIP_FOLLOW_RATE` | `HybridSlimeSimulation.ts` | 锥的张角、侧面收多紧、最长多少（按半径缩放）、咬上与松口的生长速率 |
| 全局跟随权重、质心跟随比例与速率 | `HybridSlimeSimulation.ts` 顶部常量 | 「整团跟着走」而不是只鼓一个包，全部按半径缩放 |

## 加一种外力：地上的倒刺

倒刺和咬人只差「抓握点是谁」：

1. `config/actors/barbed-spike.actor.json` 给它一个 `snag` Component（半径、拉断距离、
   抓握深度）。
2. `shared/actor/components/SnagComponent.mjs`：`hookedActorId` + 判定参数。
3. `server/actors/SnagSystem.mjs`：踩上去时
   `deformation.grab(spike.id, { grabDistance, leashSlack, leashStiffness, leashDamping })`，
   之后每 tick `deformation.updateHold(spike.id, player, spikeWorld)`——不传速度，
   于是拖带项是 0，倒刺只拴不拖。返回 false 就 `release` 两边。服务端到此为止：
   一行形状的代码都没有。
4. 客户端：`slimeBiteTip.ts` 那条路上多一种来源——「谁被什么钩着」以及那个东西的
   抓握点在哪。`resolveGripTip(半径, 被钩者, 倒刺世界坐标, gripDepth, out)` 是同一个
   函数，剩下的（参数段、求解器、静止外形）一个字都不用改。

当前这组值（slack 0.2 / k 90 / damping 14 / carry 40 / gripDepth 0.35）的实测：
站着不动的咬人者面前，被咬者冲刺挣脱停在 1.64m；被拖着走时间距 2.06m。两者的
突起长度分别是 0.35m 与 0.69m，都在求解器 1.09m（半径 × 1.15）的量程内。

三个要点：

- 方向永远是「身体中心 → 抓握点」，当场算。绕过去、从身上越过去都只是这个向量在
  转，没有固定的命中点，也就没有「皮还留在原来那一面」。
- 长度是「抓握点离外壳多远」，保底 `gripDepth`。倒刺贴着皮的时候也一样要有一个
  保底，否则踩上去什么都看不见。
- 倒刺该多尖？锥的张角与收紧程度是求解器常量（`BITE_TIP_*`），今天所有来源共用
  一套。真要让吸盘钝一些，就把指数做成来源的一项参数，而不是回去按一块皮做位移。
