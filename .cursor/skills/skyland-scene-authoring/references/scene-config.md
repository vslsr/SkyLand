# SkyLand 场景配置参考

场景配置位于 `config/scenes/*.scene.json`。服务端启动时由 `SceneCatalog` 扫描、校验并净化数据；大厅 API 只下发摘要，玩家加入房间后，DS 再把该房间实际使用的完整配置随 `room:joined` 返回给客户端。

`scene.schema.json` 为编辑器补全和静态结构说明，`server/scenes/SceneCatalog.mjs` 是运行时接受配置的最终入口。修改配置契约时必须同步两者，并同步 `src/scenes/data/SceneDefinition.ts`。

## 顶层配置

| 字段 | 格式/范围 | 作用 |
| --- | --- | --- |
| `$schema` | 字符串，通常为 `./scene.schema.json` | 让编辑器关联本地 JSON Schema，提供补全和错误提示；不参与游戏逻辑。 |
| `schemaVersion` | 当前固定为 `1` | 配置协议版本。服务端拒绝不受支持的版本，为后续迁移预留边界。 |
| `id` | 唯一的小写 kebab-case，如 `open-meadow` | 场景稳定标识。创建房间时传递 `sceneId`，服务端用它查找场景。建议与文件名一致。 |
| `displayName` | 1–32 个字符 | 大厅地图选择器和房间信息中显示的名称。 |
| `description` | 1–120 个字符 | 大厅中的地图说明，帮助玩家理解玩法或视觉特征。 |
| `capacity` | 1–64 的整数 | 使用该场景创建的房间人数上限，由房间/DS 权威限制。 |
| `renderer` | 对象 | 客户端如何构建和表现这个场景。 |
| `gameplay` | 对象 | DS 和客户端共同使用的可活动区域、出生规则与环境基准。 |
| `camera` | 对象 | 加入房间后的初始视角、控制模式和移动速度。 |

## `renderer`：场景视觉

| 字段 | 格式/范围 | 作用 |
| --- | --- | --- |
| `type` | 当前只能是 `line-art` | 选择场景构建器。新增取值必须同时实现服务端白名单、客户端类型和对应 renderer factory。 |
| `background` | `#RRGGBB` | Three.js 场景背景色。通常与雾色接近，减少远景分界。 |
| `fog.color` | `#RRGGBB` | 线稿材质和 Three.js 雾使用的颜色。 |
| `fog.near` | 大于等于 0 | 从相机多远开始出现雾效。数值越小，近处越早褪色。 |
| `fog.far` | 大于 `near` | 到该距离时物体基本融入雾色；也影响线稿远景观感。 |
| `content.ground` | 布尔值 | 是否创建地面模型。 |
| `content.trees` | 布尔值 | 是否创建树木群。 |
| `content.grass` | 布尔值 | 是否创建草丛。 |
| `content.ocean` | 布尔值 | 是否创建动态海面系统。为 `true` 时必须配置 `renderer.ocean` 和 `gameplay.water`。 |
| `palette.ground` | `#RRGGBB` | 地面的填充主色。 |
| `palette.grass` | `#RRGGBB` | 草丛的填充主色。 |
| `palette.treeTrunk` | `#RRGGBB` | 树干填充色。 |
| `palette.treeNeedles` | `#RRGGBB` | 树冠/针叶填充色。 |

当前服务端总会读取全部 `palette` 字段，因此即使关闭相应内容也不能省略它们。

### `renderer.ocean`：动态海面

仅在 `content.ocean` 为 `true` 时使用。

| 字段 | 格式/范围 | 作用 |
| --- | --- | --- |
| `size` | 16–1024 | 正方形海面的边长。通常至少覆盖 `bounds` 的 X、Z 两个跨度，避免玩家看到边缘。 |
| `segments` | 8–128 的整数 | 海面网格细分数。越高，波形更平滑，但每帧更新的顶点和渲染成本越高。 |
| `waveHeight` | 0–1 | 波浪垂直振幅。`0` 表示平面；也会影响木筏取样到的浮力高度。 |
| `waveSpeed` | 0–4 | 波形随时间变化的速度。`0` 保留波形但停止动画。 |
| `waveLines` | 4–64 的整数 | 海面线稿波纹数量。越高画面越密，几何和每帧顶点更新量也增加。 |
| `crestLines` | 0–32 的整数 | 浪峰强调线数量。`0` 可关闭浪峰线。 |
| `surfaceColor` | `#RRGGBB` | 海面主要填充色。 |
| `secondaryColor` | `#RRGGBB` | 海面的次级色，用于丰富纸绘水面层次。 |
| `waveLineColor` | `#RRGGBB` | 普通波纹线颜色。 |
| `crestLineColor` | `#RRGGBB` | 浪峰强调线颜色。 |
| `foamColor` | `#RRGGBB` | 泡沫以及演示木筏相关浅色细节的颜色。 |
| `demoRaft` | 布尔值 | 是否生成随波形起伏、俯仰和横滚的演示木筏；这是客户端视觉演示，不代表服务器船只实体。 |

## `gameplay`：权威玩法空间

### `gameplay.bounds`

| 字段 | 作用 |
| --- | --- |
| `minimumX` / `maximumX` | 世界 X 轴的最小/最大可活动坐标，必须满足 `minimumX < maximumX`。服务端移动与客户端预测都使用该范围约束玩家。 |
| `minimumZ` / `maximumZ` | 世界 Z 轴的最小/最大可活动坐标，必须满足 `minimumZ < maximumZ`。 |

边界应位于可见、可行走的场景范围内。视觉模型比玩法边界略大，通常能避免玩家走到画面断面。

### `gameplay.spawn`

| 字段 | 格式/范围 | 作用 |
| --- | --- | --- |
| `centerX` / `centerZ` | 有限数字且中心位于 `bounds` 内 | 出生区域中心。DS 以此为基准计算玩家出生位置。 |
| `radius` | 大于等于 0 | 出生点围绕中心分布的半径。`0` 会让玩家出生在同一点；应尽量保证整个半径落在边界内。 |
| `slots` | 1–64 的整数 | 出生环上可分配的位置数量。建议不小于 `capacity`，避免满房时重复使用位置。 |

### `gameplay.water`

| 字段 | 格式 | 作用 |
| --- | --- | --- |
| `seaLevel` | 有限数字 | 海面静态基准 Y 高度；实际采样高度为 `seaLevel + wave`。海面与浮力对象都以它为基准。 |

`gameplay.water` 在海洋场景中必填；非海洋场景可省略。

## `camera`：加入房间后的视角与控制

| 字段 | 格式/范围 | 作用 |
| --- | --- | --- |
| `mode` | `topdown` 或 `fly` | `topdown` 创建玩家实体并启用玩家控制、同步远端玩家；`fly` 不创建本地玩家实体，使用自由飞行相机浏览场景。 |
| `position` | `[x, y, z]` 三个数字 | 自由相机的初始世界坐标。当前 `topdown` 控制器有独立的跟随偏移，不读取此值。 |
| `yaw` | 数字，单位为弧度 | 自由相机的初始水平朝向。正负方向遵循当前 `CameraTransform` 实现；从相近示例微调最稳妥。 |
| `pitch` | -1.5–1.5，单位为弧度 | 自由相机的初始俯仰角。负值通常向下看。 |
| `moveSpeed` | 大于 0 且不超过 100 | 自由相机的基础移动速度；按 Shift 时当前实现会乘以 2.5。当前 `topdown` 玩家移动使用共享玩法速度，不读取此值。 |

加入房间时系统总会把这些字段写入备用自由相机，但 `topdown` 随后会切换到 `TopDownController`，因此除 `mode` 外的相机字段目前只对 `fly` 的实际画面和移动生效。它们仍是所有场景的必填字段，以保持统一配置契约。

## 跨字段约束与常见错误

- 文件必须以 `.scene.json` 结尾，否则启动扫描不会发现。
- 所有场景 `id` 必须唯一；建议文件名等于 `id`，便于定位，但当前运行时不强制两者相同。
- `renderer.type` 当前只支持 `line-art`。
- `fog.far` 必须大于 `fog.near`。
- 出生中心必须位于玩法边界内；当前校验不检查整个出生圆是否越界，作者仍应自行保证。
- 海洋开关、`renderer.ocean`、`gameplay.water` 三者应成组出现。
- JSON Schema 声明 `additionalProperties: false`，不要加入未定义字段。运行时会净化并只下发已知字段，但不应依赖静默丢弃拼写错误。
- 新场景文件或配置改动需要重启 Node 主服务；目录只在 `SceneCatalog.load()` 时扫描一次。
- 大厅只显示场景摘要且保持空场景。客户端必须等待 `room:joined.scene`，不能把浏览器选择值当成权威配置直接加载。

## 新建场景检查清单

1. 从 `grassland.scene.json`、`open-meadow.scene.json` 或 `water.scene.json` 中选择最接近的模板。
2. 设置唯一文件名、`id`、名称、说明和容量。
3. 设置内容开关、配色、雾效；海域补齐 `renderer.ocean`。
4. 设置玩法边界、出生区域；海域补齐 `gameplay.water`。
5. 选择 `topdown` 玩法模式或 `fly` 展示模式并调整初始相机。
6. 用编辑器/Schema 检查 JSON，再以 `SceneCatalog` 测试确认运行时校验。
7. 运行 `npm run test:server` 和 `npm run build`。
8. 重启服务，确认 `/api/scenes` 出现新条目；创建房间并加入，确认 DS 返回并加载正确场景。

## 何时需要扩展代码

仅调整现有字段或组合现有内容时，不要改 renderer。若新增例如 `rocks`、`buildings` 或新 renderer 类型，则至少同步：

1. `config/scenes/scene.schema.json`：定义字段及约束。
2. `server/scenes/SceneCatalog.mjs`：运行时校验、默认拒绝策略和净化后的返回结构。
3. `src/scenes/data/SceneDefinition.ts`：客户端契约。
4. `src/scene/createLineArtScene.ts` 或新的场景工厂：把配置转成视觉内容。
5. `src/models/`：程序化几何；有逐帧状态的系统放在独立视觉系统模块中。
6. 服务端目录校验测试、客户端逻辑测试和构建检查。
