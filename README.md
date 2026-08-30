# SkyLand 线稿场景

基于 Vite、TypeScript 与 Three.js 的低多边形线稿场景。当前阶段包含一块平地、三棵程序化树和零散草丛。

渲染方式沿用 `.cursor/line-art-style-magic-cabin-main` 的核心结构：为每个物体同时创建淡色填充网格与 `EdgesGeometry` 轮廓线，不再使用此前的 MRT、屏幕空间边缘检测与 FXAA 后期链路。

## 运行

```bash
npm install
npm run dev
```

开发服务器地址：`http://localhost:5180`。生产预览使用 `http://localhost:4180`。

## 操作

- 点击画面：锁定鼠标
- 鼠标：控制朝向
- W / A / S / D：沿相机局部坐标前后左右飞行
- Space / C：上升 / 下降
- Shift：加速
- Esc：释放鼠标

## 模块结构

- `src/models/`：平地、树、草丛和通用描边物体的程序化建模
- `src/materials/`：填充 Shader 与轮廓线材质
- `src/scene/`：场景装配
- `src/rendering/`：Three.js 渲染器、透视相机同步和 DPR 管理
- `src/camera/`：相机变换、局部坐标移动、输入控制与坐标不变量验证
- `src/math/`：相机使用的向量与矩阵运算
- `src/ui/`：进入面板和鼠标锁定提示

渲染器启用硬件抗锯齿，设备像素比上限为 1.75。
