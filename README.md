# SkyLand

基于 Vite、TypeScript、Three.js、Node.js 与 WebSocket 的低多边形联机场景原型。

当前包含：

- Three.js 淡色填充与 `EdgesGeometry` 线稿草地场景
- `Scene` / `SceneManager` 场景生命周期
- 每个 Scene 独立的 `CommonUIManager` 栈
- 房间大厅、Grid 房间卡片和通用弹出窗体
- Node.js 大厅进程、WebSocket 网关和每房间独立子进程

## 运行

分别启动房间服务端与 Vite 客户端：

```bash
npm run server
npm run dev
```

- 客户端：`http://localhost:5180`
- 房间服务端：`http://127.0.0.1:3090`
- 生产预览：`http://localhost:4180`

服务端测试和前端构建：

```bash
npm run test:server
npm run build
```

## CommonUI 事件栈

`CommonUIManager` 按压栈顺序管理页面。默认情况下，栈顶页面独占输入，下面的 CommonUI 和游戏交互层会被阻断。

页面可以启用未处理事件向下传递：

```ts
const page: CommonUIPage = {
  id: 'floating-panel',
  element,
  passUnhandledEvents: true,
  handleInputEvent(event) {
    return event.type === 'contextmenu';
  },
};
```

事件从栈顶依次调用 `handleInputEvent`。当前页面返回 `false` 且 `passUnhandledEvents` 为 `true` 时，事件继续传给下一层；全部 CommonUI 都未处理时，最后交给 `GameInteractionLayer`。按钮、输入框等真实 DOM 控件会直接视为所属页面已经接收。

切换 Scene 时，`Scene.leave()` 会停用并清空该 Scene 的全部 CommonUI。

## 房间进程

客户端通过 HTTP 获取或创建房间，通过 `/ws` WebSocket 加入房间。大厅进程只管理连接和路由；`RoomProcessManager` 每创建一个房间都会使用 `child_process.fork()` 启动独立的 `room-worker.mjs`。

每个房间进程拥有自己的 `ServerScene`、玩家集合、输入队列和 20 Hz 更新循环。房间异常退出不会拖垮其他房间。

## 模块结构

- `src/scenes/`：Scene 基类、SceneManager 与草地场景
- `src/ui/common/`：CommonUI 栈和通用窗体
- `src/ui/pages/`：房间大厅、创建房间页面
- `src/interaction/`：最底层游戏交互事件路由
- `src/network/`：浏览器房间客户端
- `src/models/`：程序化平地、树木和草丛
- `src/materials/`：填充 Shader 与轮廓线材质
- `server/network/`：WebSocket 网关
- `server/rooms/`：房间进程管理器与 worker
- `server/scene/`：服务端权威场景状态
