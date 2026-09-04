# 建造系统实现说明

对应设计稿：[`desinger-buildsys.md`](./desinger-buildsys.md)。这份文档写的是设计稿在代码里落在哪、
哪些点按原文实现、哪些点留了接口、哪些还没做。

## 1. 设计稿 → 代码

| 设计稿里的概念 | 代码里的对应物 |
| --- | --- |
| 水上建筑 / 静态建筑 | `buildPiece.surface = 'floating' / 'static'`（物件可以写 `any`） |
| 水上地基（最初的一块板） | `config/actors/float-foundation.actor.json`；挨着已有甲板就接到那座船坞上，不挨着就按 `buildPiece.hull` 立起一座新的 `float-hull` |
| 连接在一起的模块形成一个可浮动的船体 | `float-hull` 是看不见的**船体根节点**：`buoyancy + vesselMotor + buildGrid`，每块地基是它的子 Actor 与浮力部件 |
| 外部动量驱动 / 玩家开船（留接口） | 根节点带 `vesselMotor`，走现有的载具接管（`actor:claim`）与 `VesselMotorSystem`，不另写一套 |
| 水上墙体 | `float-wall.actor.json`，吸附在甲板格的四条边上，一层、无天花板 |
| 静态地基（抬高地面） | `ground-foundation.actor.json`，放在陆地格或河床格中心；河床上的板浮在水面上，就是一座码头 |
| 静态墙体 | `wood-wall` / `stone-wall`，吸附在地基边或**地形格边**上（河床格也算） |
| 物件（棚子 / 篝火 / 大炮 / 箱子） | `buildPiece.kind = 'fixture'`，吸附在地基或陆地格**中心**；示例是 `campfire`（篝火） |
| 物件之间的互斥属性 | `buildPiece.slot`：同槽互斥、异槽共存（一格一个篝火，篝火和棚子可以同在一格） |
| 吸附 | `shared/build/buildGrid.mjs`：格中心 / 最近格边 / 船体本地网格 |
| 合法位置 | `shared/build/buildRules.mjs`：两端跑同一份 `validateBuildPlacement` |
| 实体碰撞 | `shared/build/buildFootprint.mjs`：放置位的占地和玩家、掉落物、场景物件、别的船比一遍 |
| 模块大小 = 地皮一格 | `BUILD_CELL_SIZE = TERRAIN_CELL_SIZE`（2 米）；水上与静态网格同宽 |

## 2. 数据流

```
建造栏选中一件  ──►  BuildController（每帧）
                     指针射线 → SceneWorld.pickBuildPoint → 世界点
                     resolveBuildPlacement → 吸附成格 / 边（水上件先找船）
                     validateBuildPlacement + resolveBuildElevation → 幽灵红绿、提示
                     主键按下 → build:command { archetypeId, surface, hullActorId?, cellX, cellZ, edge? }
                                      │
                                      ▼
房间 DS：ServerScene.applyBuildCommand → BuildMutations.placeBuildPiece
                     restoreBuildPlacement（按权威船体位姿还原）
                     validateBuildPlacement（同一份规则）
                     扣材料 → （立船：先建 float-hull）→ 建件 Actor → 挂到船上 / 进浮力结算
                     BuildSiteIndex.add；下一份快照带 buildPiece { kind, surface, cellX, cellZ, edge }
                                      │
                                      ▼
客户端：ClientActorSystem 建 Replica，按格坐标重建占位表（BuildSiteIndex）
```

上行只有**格坐标**。世界坐标过网只会让两端各自取整一次，船在动时更是如此。

## 3. 网格

- **世界网格**（静态件）：与地形格对齐，原点在世界原点，格宽 2 米。地基占一格、墙占一条边、物件占格中心的一个槽。
- **船体网格**（水上件）：挂在船体根节点的本地空间里，随船平移与旋转。`float-hull` 的 `buildGrid` 是 `0 × 0`
  （没有自带甲板），第 (0, 0) 格在根节点正下方，最初那块地基就放在那里；`extentCells` 限制往外扩多远，
  `maxPieces` 限制一艘船的件数。预制木筏若声明 `columns × rows` 的 `buildGrid`，自带甲板也走同一套规则
  （当前的 `raft` 没有声明：它的格宽 1.6 米和地皮一格对不上）。
- **吸附到哪座船坞**（`resolveBuildPlacement`）：地基按**四邻相邻**判——这一格自己是甲板、或前后左右
  任一格是甲板，就吸到那艘船的网格上；都不是就落在世界格上立一座新的。范围（`extentCells`）不参与
  吸附，它只是那艘船还能长多大的上限。墙与物件按范围找船：它们本来就该落在船上，落在没有甲板的
  格子上时幽灵停在船上变红说「下面没有地基撑着」，比跳回世界网格好读。
- **边只有两个名字**：`north` 是格子 +Z 侧，`east` 是 +X 侧。南边就是南邻格的 `north`，西边就是西邻格的 `east`，
  两个人从两侧各放一面墙不会放出两面重叠的墙。

## 4. 规则（`validateBuildPlacement` 的顺序）

1. 表面匹配、够得着（`reach`）、槽位没被占；
2. 水上地基：没吸到船 → 这一格必须是水（立一座新船坞）；吸到船 → 不盖自带甲板、不出扩建范围、
   四邻至少一格是甲板；
3. 水上墙 / 物件：所在边 / 格要有甲板；
4. 静态件要求这张图有地面（纯海域图没有）；地基放陆地格或河床格；墙两侧任一格是地基或地形格；
   物件放在地基上或陆地格中心；
5. 实体碰撞：放置位与玩家、掉落物、场景物件、别的船重叠就拒（同一表面上的建造件不算，它们靠占位槽互斥）；
6. 预算（每人 64、每房间 512、每艘船 `maxPieces`）；
7. 材料。

材料放最后，幽灵先说「这里能不能放」，再说「缺什么」。规则只有 `shared/build` 这一份，
客户端拿它给幽灵判红绿，服务端拿它做最终裁决。

## 5. 高度

- 水上件用**船体本地**高度：地基顶面贴齐 `deckHeight`，墙脚与物件落在 `deckHeight` 上；世界高度由
  `AttachmentSystem` 按船的位姿解算。
- 静态地基落在那格地形的最高角点上（斜坡格才不会陷进坡里）；河床格取水面。
- 静态墙落在两侧地基顶面较高的那一块上，没有地基就落在两侧地形较高的一格上；物件同理。

## 6. 拆除

拆除全额退回材料，背包装不下的掉在件的位置上。地基上还立着墙（另一侧没有地基撑着）或摆着物件时拆不掉；
船上最后一件拆掉，看不见的船体根节点也一并移除。

## 7. 放置键

主键（鼠标左键 / 手柄下键）：建造是「对着指针指的地方干这一下」，而指针本来就在鼠标上，
让手离开鼠标去按 E 是把一个连续动作掰成两半。交互键也收，因为触屏那颗按钮和手柄北键绑在它上面。

建造模式下这两个键不再有别的含义：`GrasslandScene` 在建造时把手持物的使用（`HotbarController`
的 `isActive`）与就近交互一起关掉，所以点一下不会既放一件又吃掉手上的果子。

## 8. 留了接口 / 还没做

- **窗户与门**（墙的变体，按 E 开合）：墙是普通 Actor，加 `interactable` 与一个开合状态即可；占位与吸附不用改。
- **更多物件**（棚子、大炮、箱子）：给原型加 `buildPiece { kind: 'fixture', slot }` 就进建造栏；箱子可直接复用
  `container` 组件。
- **船的整体起伏**：船体根节点在渲染侧有一个没有模型的空 proxy，波浪起伏与倾斜画在它身上，板由
  `ThreeAttachmentVisual` 顺着父子关系继承——整座船坞一起起伏、一起倾斜。吃水与静态倾斜仍由
  `BuoyancySystem` 在服务端结算。
- **连通性**：拆掉中间一块地基不会把船拆成两艘；两块不相连的板仍算同一艘船。
