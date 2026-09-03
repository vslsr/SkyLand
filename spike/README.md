# 渲染线程尖刀

**不是产物的一部分。** `tsc` 的 include 只有 `src` / `shared` / `vite.config.ts`，
vite build 的入口只有根 `index.html`，所以这个目录既不参与类型检查也不进 `dist/`。
它只在 `npm run dev` 下由开发服务器直接服务。

## 怎么跑

```
npm run dev
# 打开 http://localhost:5180/spike/
```

## 它回答什么

**真实渲染栈能不能整体跑在 worker 里。**

第 3 步开头做过一次尖刀，只证明了「`transferControlToOffscreen` + WebGL2 能在
worker 里清屏」。那和这里问的不是一件事——真正会咬人的是自定义 shader 材质、
chunk 几何、WASM 生成器、以及标记牌的文字贴图。

这一版把真东西搬进去跑：`ThreeRenderScene`（含 Actor 模型与玩家史莱姆）、
`ChunkViewHost`（四块 chunk 的地形、树、岩石、草）、`createSceneEnvironment`
的自定义材质、`createChunkGenerator` 的 WASM 后端、标记牌的 `OffscreenCanvas`
文字贴图，然后真画三帧。

结论：**全过**。WebGL2、材质、几何、WASM、文字贴图，一样没缺，画面正常。
所以第 3 步剩下的是装配的拆分，不是「能不能」的问题。

## 第二问：命令能不能过去

现在这一版又往前推了一步：**主线程这一侧一个 Three 对象都没有**。它只有一个
`RenderCommandQueue`、一张 `RenderProxyTable`、和那段 `SharedArrayBuffer`。
建 proxy、挂 chunk、设标记牌全部变成命令，成批 `postMessage` 过去；
位置则根本不走命令——两侧看的是同一块内存。

跑出来：11 条命令结构化克隆过去，worker 兑现后画出 68 次 draw call，
货箱正落在主线程写进 SAB 的那三个 x 上（`shared=true`）。

## 留着它干什么

接下来把渲染世界一块一块搬进线程时，每搬一块就在这里验一次——比起把半成品接进
真实场景，这个页面的反馈快得多，而且失败时的报错干净。等渲染循环真的搬完，
这个目录就可以删掉。
