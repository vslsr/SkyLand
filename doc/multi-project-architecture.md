# 多项目支持：Config、TS 与 Asset 的归属

> 上下文见 `engine-migration-roadmap.md`
> 结论：**现在不要拆包，先把依赖方向钉死**。第二个项目出现时，拆分才是机械搬运而不是重写
> 依赖：无。这件事与路线图各步互不阻塞

问题：引擎要支持多个项目时，每个项目各自的 Config、TS、Asset 怎么放？

---

## 1. 现状：三层的成本差异巨大

| 层 | 现状 | 多项目成本 |
| --- | --- | --- |
| **Config 加载** | `SceneCatalog` / `ActorCatalog` **已经接受目录参数**，`DEFAULT_SCENE_DIRECTORY` / `DEFAULT_ACTOR_DIRECTORY` 只是默认值 | **几乎免费** |
| **Asset** | 按 `engine-migration-roadmap.md` §8 的烘焙产物设计，天然按项目分 | 低 |
| **Config schema** | `server/scenes/SceneCatalog.mjs` 824 行 + `src/scenes/data/SceneDefinition.ts` 463 行，**写死了 weather / ocean / terrain / prop kinds / renderer.palette 这些 SkyLand 概念** | **高** |
| **组件注册** | `createSceneRuntimeComponent` 是 `switch` + `const unsupported: never` 的**闭合白名单** | 中，且有类型安全代价 |

配置**加载**这一层当初就写对了——目录是参数，不是常量。真正的障碍是**引擎在校验项目的语义**。

```text
现在                                        目标

┌──────────────────────────────┐          ┌──────────────────────────────┐
│ engine（名义上）               │          │ engine                       │
│  SceneCatalog                │          │  SceneCatalog                │
│   ├ 校验 weather 类型          │          │   └ 只校验骨架 + 遍历组件      │
│   ├ 校验 ocean / terrain      │          │  ComponentRegistry           │
│   ├ 校验 prop kinds           │          │   └ register(type,           │
│   └ 校验 renderer.palette     │          │              factory, schema)│
│  createSceneRuntimeComponent │          └───────────────▲──────────────┘
│   └ switch 三种 SkyLand 组件   │                          │ register()
└──────────────────────────────┘                          │ 单向
         ▲                                  ┌─────────────┴──────────────┐
         └── 引擎里写着项目的概念              │ projects/skyland/           │
             依赖方向是反的                   │  config/  src/  build/     │
                                            └────────────────────────────┘
```

---

## 2. Config：schema 要分两层

现在是一个大函数逐字段校验。要改成骨架与语义分离：

```text
引擎 schema    Actor:  id / archetypeId / transform / components[]
               Scene:  id / renderer / gameplay / actors[]
               → 只管结构，不认识任何 SkyLand 概念

项目 schema    每种 Component 的字段
               weather / ocean / terrain / palette 全是 SkyLand 的
               → 由项目通过 $ref / allOf 提供，注册进引擎
```

引擎校验骨架，然后遍历 `components[]`，把每一项交给**项目注册的校验器**。`SceneCatalog.mjs` 那 824 行里的大部分要搬到项目侧——这是整件事的主要工作量。

加载路径本身不用改：`SceneCatalog` 与 `ActorCatalog` 已经接受目录参数，多项目就是传不同的目录。

---

## 3. TS：注册表要从 switch 改成运行时注册

现在新增一种场景组件必须改引擎文件（`src/scene/components/createSceneRuntimeComponent.ts` 的 `switch`）。改成注册表：

```ts
// 引擎侧
interface ComponentRegistry {
  register(type: string, factory: ComponentFactory, schema: JSONSchema): void;
}

// 项目侧 entry
export function registerSkyland(registry: ComponentRegistry) {
  registry.register('mouse-grass-interaction', ..., schema);
  registry.register('ability-lab', ..., schema);
  registry.register('interactive-particle-effect', ..., schema);
}
```

### 3.1 这一步有真实的类型安全代价

现在的写法是 `switch` + `const unsupported: never` ——**漏实现一种组件，编译期就报错**。改成字符串键的注册表就失去了这个保护。

这是多项目支持的真实成本，不是免费的。折中：项目侧仍用 discriminated union 保住自己的穷尽检查，只是**引擎不再知道全集**。

### 3.2 加载方式：构建期打包，不是运行时动态加载

不要幻想运行时动态加载 TS——浏览器里没有 TS 编译器，动态 `import()` 也要预先构建。所以形态是：

> **项目 TS 在构建期和引擎一起打包，每个项目一个构建入口。**

这个模式**项目里已经有了**：`scripts/build-ability-runtime.mjs` 用 esbuild 把 `src/abilities/serverRuntimeEntry.ts` 打成 `shared/abilities/runtime.mjs` 供服务端加载。

多项目就是把它推广成「每个项目产出一份 server runtime bundle，房间进程按 project id 加载」。**机制现成**，只是现在只有一个项目在用它。

---

## 4. Asset：最简单，但有一条归属要改

按 `engine-migration-roadmap.md` §8 的设计（`.bin` 烘焙产物 + `contentHash`），每个项目自己的 `build/assets.bin`，**引擎负责加载，不负责生产**。

但有一条归属判断要写明：

> **`src/models/` 那 38 个程序化模型是项目资产，不是引擎代码。**

线稿风格的树、岩石、草是 SkyLand 的美术表达，不是引擎能力。现在它们和引擎混在一起。拆分时整体搬到项目侧，引擎只保留「模板注册接口」（`registerTemplate` 那一层）。

---

## 5. 目录形态

```text
engine/
  core/  scene/  function/  resource/  platform/  tool/
  schema/            引擎级骨架 schema

projects/
  skyland/
    config/          场景与 Actor JSON
    src/             项目 TS：Component / System / Ability / 程序化模型
    build/           烘焙产物 .bin
    project.json     清单：入口、schema 扩展、资源根、构建目标
  another-game/
    ...
```

编辑器（见 `tool-layer-implementation.md`）因此变成「打开一个项目」——`project.json` 就是它的入口清单，与 Unity 的 project 概念一致。

---

## 6. 但现在最该做的不是拆包

诚实的判断：**现在只有一个项目，拆包是提前抽象。** §2 那 824 行的重构，在第二个项目真正存在之前做，多半会拆错边界——因为没有第二个样本来验证哪些字段是通用的、哪些是 SkyLand 独有的。

但有一件事成本极低、收益立刻兑现：

> **现在就确立「引擎代码不许 import 项目代码」这条规则，并用依赖检查钉死它。**

不拆目录，只加约束。加一个 `scripts/check-layering.mjs` 扫 import（或用 eslint 的 `no-restricted-imports` / dependency-cruiser），一天就能跑起来。

两个立刻兑现的收益：

1. **跑一遍就得到一份「引擎反向依赖项目」的清单** —— 这是后面所有拆分工作的基线，比继续推演有用。
2. **第二个项目出现时，拆分是机械搬运；不这样做，拆分是重写。**

这与路线图里 RenderProxy 边界的逻辑完全一样——**先立边界，后拆物理结构**。

---

## 7. 结论所依据的现状

| 位置 | 事实 |
| --- | --- |
| `server/scenes/SceneCatalog.mjs:20` | `DEFAULT_SCENE_DIRECTORY` 是默认值，目录本身是参数 |
| `server/actors/ActorCatalog.mjs:6` | `DEFAULT_ACTOR_DIRECTORY` 同上 |
| `server/scenes/SceneCatalog.mjs` | **824 行**，内含 `PROP_KIND_BY_NAME`、`WEATHER_TYPES`、ocean / terrain / palette 等 SkyLand 专有校验 |
| `src/scenes/data/SceneDefinition.ts` | **463 行**，客户端侧同一套 SkyLand 专有类型 |
| `src/scene/components/createSceneRuntimeComponent.ts` | `switch` + `const unsupported: never`，白名单硬编码三种组件 |
| `scripts/build-ability-runtime.mjs` | esbuild 把项目 TS 打成 `.mjs` 供服务端加载——「项目代码作为可加载产物」的现成先例 |
| `src/models/` | 38 个文件，全部为 SkyLand 的程序化模型定义 |
| `config/` | 23 个 `*.actor.json` + 6 个 `*.scene.json`，两类各带一份 `.schema.json` |
