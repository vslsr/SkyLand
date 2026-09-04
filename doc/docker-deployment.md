# Docker 构建与服务器部署

这份文档只讲一件事：把仓库变成一个能在服务器上长期跑的容器。运行形态和
`npm run start:prod` 完全一致——**一个 Node.js 进程**在同一个端口上提供 Vite 构建
出来的 `dist/`、大厅 `/api/*` 和游戏 `/ws`，每创建一个房间再 fork 一个
`room-worker.mjs` 子进程当 DS。容器里没有 Nginx，也没有第二个进程。

## 0. 前置条件

- 服务器安装 Docker Engine 20.10+（自带 BuildKit）与 Docker Compose v2。
- 构建阶段需要能访问 npm registry。
- 内存建议 ≥ 2 GB：`vite build` 峰值吃得比运行时多，运行时本身很轻。
- 不需要在服务器上装 Node.js、也不需要 Rust 工具链——`chunkgen.wasm` 是签入仓库的，
  `Dockerfile` 里不跑 `npm run build:wasm`。

## 1. 镜像里有什么

`Dockerfile` 是两段式的：

| 阶段 | 做什么 |
| --- | --- |
| `build` | `npm ci`（含 devDependencies）→ `npm run build`（`build:abilities` + `tsc` + `vite build`）产出 `dist/` |
| `production` | `npm ci --omit=dev` 只装运行时依赖，再从 `build` 拷入 `dist/`、`server/`、`shared/`、`config/` |

`shared/` 和 `config/` 不是可选的：服务端要读 `config/scenes`、`config/actors`、
`config/items`，房间 DS 还要用 `shared/world/wasm/chunkgen.wasm` 生成地形。
`.dockerignore` 已经把 `node_modules`、`dist`、`tests/`、`doc/` 挡在构建上下文外，
所以宿主机上有没有 `node_modules` 都不影响构建结果。

最终镜像以非 root 的 `node` 用户运行，暴露 `3090`，并带一条打 `/api/health` 的
`HEALTHCHECK`。

## 2. 构建镜像

在仓库根目录：

```bash
# 最常用的一条：构建并打上 latest
docker build -t skyland:latest .

# 带版本号，方便回滚
docker build -t skyland:0.1.0 -t skyland:latest .

# 不用任何缓存重新构建（依赖出现诡异问题时用）
docker build --no-cache --pull -t skyland:latest .

# 只构建到 build 阶段，用来单独排查前端构建失败
docker build --target build -t skyland-build .
```

构建完确认一下：

```bash
docker images skyland
docker run --rm skyland:latest node -e "console.log(process.version)"
```

### 构建产物推到镜像仓库

服务器和开发机不是同一台时，推荐本地构建 → 推仓库 → 服务器拉取：

```bash
docker login <registry>
docker build -t <registry>/<namespace>/skyland:0.1.0 .
docker push <registry>/<namespace>/skyland:0.1.0
```

开发机是 Apple Silicon、服务器是 x86 时必须指定目标架构，否则镜像在服务器上起不来：

```bash
docker buildx build --platform linux/amd64 \
  -t <registry>/<namespace>/skyland:0.1.0 --push .
```

没有镜像仓库时也可以直接传 tar：

```bash
docker save skyland:latest | gzip > skyland.tar.gz
scp skyland.tar.gz user@server:/tmp/
ssh user@server 'gunzip -c /tmp/skyland.tar.gz | docker load'
```

## 3. 运行容器

### 3.1 单条 docker run

```bash
docker run -d \
  --name skyland \
  --restart unless-stopped \
  --init \
  -p 3090:3090 \
  -v skyland-logs:/app/logs \
  skyland:latest
```

`--init` 不能省：房间 DS 是 `node` 的子进程，PID 1 不是 init 时被回收的子进程会
留成僵尸。

验证：

```bash
curl http://127.0.0.1:3090/api/health
# {"ok":true,"role":"web-and-dedicated-server","roomCount":0,"webReady":true}

docker ps                 # STATUS 里应该出现 (healthy)
docker logs -f skyland
```

`webReady` 是 `false` 说明镜像里没有 `dist/`——构建阶段的 `vite build` 失败了，
回去看 `docker build` 的输出。

### 3.2 Docker Compose（推荐）

仓库根目录的 `docker-compose.yml` 已经写好了上面这些参数。

```bash
docker compose up -d --build     # 构建并启动
docker compose ps                # 看状态和健康检查
docker compose logs -f skyland   # 跟日志
docker compose restart skyland
docker compose down              # 停止并删除容器（保留 skyland-logs 卷）
docker compose down -v           # 连日志卷一起删
```

默认只把端口发布到 `127.0.0.1:3090`，也就是**必须**在前面放一层反代。想让容器直接
对外，把 `ports` 改成 `"3090:3090"`。

### 3.3 环境变量

| 变量 | 镜像默认值 | 说明 |
| --- | --- | --- |
| `SKYLAND_SERVER_HOST` | `0.0.0.0` | 监听地址。容器里保持 `0.0.0.0`，端口映射负责收口 |
| `SKYLAND_SERVER_PORT` | `3090` | 监听端口。改了它，`-p`、健康检查和反代都要跟着改 |
| `SKYLAND_WEB_ROOT` | `/app/dist` | 静态资源根目录，一般不需要动 |
| `NODE_ENV` | `production` | — |

`SKYLAND_ROOM_ID`、`SKYLAND_ROOM_NAME`、`SKYLAND_ROOM_CAPACITY` 是 `RoomProcessManager`
给房间子进程注入的，不要在容器上手动设置。

换端口的例子：

```bash
docker run -d --name skyland --init \
  -e SKYLAND_SERVER_PORT=8080 -p 8080:8080 skyland:latest
```

## 4. 反向代理与 HTTPS

### 4.1 先记住这条：不上 HTTPS，游戏会掉能力

客户端依赖 `crossOriginIsolated === true` 才能拿到可共享的 `SharedArrayBuffer`
（渲染 Worker 的 transform/instance 缓冲走它）。浏览器只在**安全上下文**里给这个能力：
`https://` 或 `http://localhost`。用 `http://<公网 IP>:3090` 访问，
COOP/COEP 头发得再对，`crossOriginIsolated` 仍然是 `false`。

`src/platform/threading.ts` 拿不到 SAB 时会**静默**回落成普通 `ArrayBuffer`——
不报错，只是主线程和渲染线程之间从共享内存变成逐帧拷贝。所以这个坑不会以异常的形式
暴露出来，只会表现为线上比本地卡。

所以公网部署请务必配好域名和 TLS。局域网内自测可以走 IP，但那时的能力集和线上不一样。

### 4.2 Nginx

Node 服务端自己会发 `Cross-Origin-Opener-Policy: same-origin` 和
`Cross-Origin-Embedder-Policy: require-corp`，反代**不要**覆盖或删掉它们。

```nginx
server {
    listen 443 ssl http2;
    server_name skyland.example.com;

    ssl_certificate     /etc/letsencrypt/live/skyland.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/skyland.example.com/privkey.pem;

    # dist 里有 2 MB 的 rapier wasm，别让上传/下载缓冲卡住
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:3090;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # /ws 的 WebSocket 升级；写在 location / 里可以一并覆盖
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 游戏会话是长连接，默认的 60s 读超时会把闲置连接踢掉
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;

        # 快照广播要及时，不能被反代攒着
        proxy_buffering off;
    }
}

server {
    listen 80;
    server_name skyland.example.com;
    return 301 https://$host$request_uri;
}
```

改完 `nginx -t && systemctl reload nginx`。

### 4.3 Caddy（自动签证书，配置更短）

```caddy
skyland.example.com {
    reverse_proxy 127.0.0.1:3090
}
```

Caddy 默认就转发 WebSocket 升级，也不会动上游的 COOP/COEP 头。

### 4.4 防火墙

容器端口只绑到回环时，对外只需要放行 80/443：

```bash
sudo ufw allow 80,443/tcp
```

## 5. 更新与回滚

```bash
cd /srv/skyland
git pull
docker compose up -d --build      # 重新构建并滚动替换
docker image prune -f             # 清掉悬空镜像
```

用镜像仓库时：

```bash
docker compose pull && docker compose up -d
```

回滚就是切回旧 tag：

```bash
docker run -d --name skyland --init -p 127.0.0.1:3090:3090 skyland:0.1.0
```

**部署会断开在线玩家。** 房间状态只在 `room-worker.mjs` 进程的内存里，容器一停就没了，
没有持久化和迁移。挑低峰期发版。

## 6. 排查

| 现象 | 原因与处理 |
| --- | --- |
| `/api/health` 返回 `"webReady": false`，页面 503 | 镜像里没有 `dist/`。看 `docker build` 输出里 `vite build` 是否失败 |
| 容器 STATUS 一直 `(unhealthy)` | `docker logs skyland` 看启动报错；或 `SKYLAND_SERVER_PORT` 改了但健康检查还打 3090 |
| 页面能开，进房间就断线 | 反代没转发 WebSocket 升级，或 `proxy_read_timeout` 太短 |
| 帧率明显低于本地，但没有任何报错 | 跨源隔离没打开。`src/platform/threading.ts` 会静默回落到普通 `ArrayBuffer`，不抛异常。在控制台查 `crossOriginIsolated`，`false` 就是这条。原因见 4.1 |
| 加载卡在 wasm，控制台报跨源资源被拒 | 引入了不带 `Cross-Origin-Resource-Policy` 的跨源资源（CDN 字体/图片），COEP 会静默拦掉 |
| 构建时 OOM 被杀 | 构建机内存不足。加 swap，或在别处构建好推镜像 |
| 日志目录写入报 EACCES | `/app/logs` 没挂卷或属主不对。用 `-v skyland-logs:/app/logs` |

常用命令：

```bash
docker compose logs --tail=200 skyland
docker exec -it skyland sh
docker inspect --format '{{json .State.Health}}' skyland | head -c 400
docker stats skyland
```
