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

默认把宿主机 80 直接映射到容器的 3090，前面不放反代。注意这个默认值只够验证
`/api/health` 和静态资源是否正常——**浏览器里游戏起不来**，因为纯 HTTP 没有跨源隔离，
见 4.1。真要能玩，按 4.2 拿到安全上下文。

要换发布方式，用 `SKYLAND_PUBLISH` 覆盖，不用改文件（改了会和 `git pull` 冲突）：

```bash
SKYLAND_PUBLISH=127.0.0.1:3090 docker compose up -d  # 配好反代后回到这个形态
SKYLAND_PUBLISH=0.0.0.0:8080 docker compose up -d    # 换个对外端口
```

想固定下来就在仓库根目录写个 `.env`（不在 git 里，`docker compose` 会自动读）：

```bash
echo 'SKYLAND_PUBLISH=127.0.0.1:3090' > .env
```

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

**拿不到跨源隔离，客户端直接起不来**，页面上会是这一行：

> 客户端初始化失败：拿不到 SharedArrayBuffer（页面没有跨源隔离？），渲染循环搬不进线程

`src/platform/threading.ts` 里的 `allocateSharedBytes` 确实会回落成普通 `ArrayBuffer`，
但根本走不到那一步：`src/render/worker/connectRenderWorldInWorker.ts` 在装配渲染线程时
就抛了异常，而 `GrasslandScene` 只有这一条渲染路径，没有主线程回退分支。

所以「先用 HTTP 跑起来，以后再上 HTTPS」是行不通的——安全上下文是能不能玩的前提，
不是性能优化。下一节是没有域名时怎么拿到它。

### 4.2 没有域名时怎么拿到安全上下文

**先说清楚：光加一层反代是修不好的。** 根因是协议不是 HTTPS，跟前面有没有 nginx 无关。
反代必须**终止 TLS**，也就是它得有证书。仓库里备了三个可选 profile：

| 方案 | 证书 | 浏览器警告 | 需要入站端口 | 适合 |
| --- | --- | --- | --- | --- |
| `--profile quicktunnel` | Cloudflare 签发 | 无 | 不需要 | 境内服务器、没备案、想马上试玩 |
| `--profile nginx-tls` | 自己准备（自签或已有的） | 自签会弹一次 | 443 | 纯 IP 访问、内网、离线、已有证书 |
| `--profile tls`（Caddy） | Let's Encrypt 自动签发续期 | 无 | 80 + 443 | 已备案域名，或服务器在境外 |

启用任一 profile 时 skyland 自己不要再占 80，保持默认的只发布到回环即可。
`nginx-tls` 和 `tls` 都占 80/443，不能同时起；`quicktunnel` 不占任何端口，可以并存。

> **境内服务器的坑：`<IP>.sslip.io` + Let's Encrypt 走不通。** 云厂商会在入口拦截
> 未备案域名走 80/443 的请求，返回一个 webblock 页。Let's Encrypt 是多视角校验，
> 只要有一个节点拿到拦截页整单就失败，日志长这样：
>
> ```
> Invalid response from https://dnspod.qcloud.com/static/webblock.html?d=<域名>: 566
> ```
>
> 这跟配置无关，改不好。境内没备案就走 `quicktunnel` 或 `nginx-tls`。别让它一直重试
> ——Let's Encrypt 对失败校验有频率限制（同一域名每小时 5 次），确认是这个错就
> `docker compose --profile tls down`。

#### 方案 A：Cloudflare 快速隧道，不需要任何入站端口

`cloudflared` 只建立**出站**连接到 Cloudflare，再由 Cloudflare 把流量送回来。
所以它同时绕开了未备案拦截、安全组和端口占用，而且拿到的是正式证书，没有警告。

```bash
docker compose --profile quicktunnel up -d
docker compose logs cloudflared | grep trycloudflare.com
# https://<随机字符>.trycloudflare.com
```

地址是随机的，**容器一重启就换一个**，带宽也有限制。适合自己试玩和临时分享给几个人，
不适合当正式入口。流量会经过 Cloudflare，内容敏感时要考虑这一点。

#### 方案 B：nginx + 自签证书，纯 IP 访问

不依赖外部 CA，也不涉及域名，所以不受备案拦截影响。代价是浏览器首访要点一次
「继续访问」。点过之后就是安全上下文，`crossOriginIsolated` 为 `true`，功能完整。

```bash
./deploy/generate-self-signed-cert.sh 111.229.172.59   # 换成你的公网 IP
docker compose --profile nginx-tls up -d
# 浏览器开 https://111.229.172.59/
```

证书写在 `deploy/tls/`（已在 `.gitignore` 里）。已经有正式证书时，把 `cert.pem` /
`key.pem` 放进这个目录即可，不用跑脚本。需要放行安全组的 443 入站。

`deploy/nginx-tls.conf` 里刻意没有任何 `add_header` / `proxy_hide_header`：
COOP/COEP/CORP 由 Node 服务端统一发，nginx 默认透传，一旦覆盖就前功尽弃。

#### 方案 C：Caddy + Let's Encrypt（需要已备案域名，或服务器在境外）

```bash
echo 'SKYLAND_SITE=skyland.example.com' > .env
docker compose --profile tls up -d
docker compose logs -f caddy                # 等 certificate obtained
```

没有域名但服务器在境外时，可以用 `<公网IP>.sslip.io` —— 这个泛解析服务把该名字
解析回同一个 IP，Let's Encrypt 能正常签发。境内服务器见上面那条警告。

签发走 HTTP-01 挑战，**80 和 443 都必须能从公网访问**，签完 80 会 301 到 443。
证书存在 `caddy-data` 卷里，别删。

#### 方案 D：只有自己试玩，SSH 隧道

服务器什么都不用改，容器保持只监听回环。`http://localhost` 是安全上下文，
性能和正式部署完全一致。

```bash
# 在你自己的电脑上执行
ssh -N -L 3090:127.0.0.1:3090 root@<服务器IP>
# 浏览器开 http://localhost:3090/
```

必须用 `localhost` 或 `127.0.0.1`——局域网 IP 同样不算安全上下文。

### 4.3 Nginx

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

### 4.4 Caddy（自动签证书，配置更短）

```caddy
skyland.example.com {
    reverse_proxy 127.0.0.1:3090
}
```

Caddy 默认就转发 WebSocket 升级，也不会动上游的 COOP/COEP 头。

### 4.5 防火墙

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
| 页面报「客户端初始化失败：拿不到 SharedArrayBuffer」 | 不是安全上下文（走了 http），或反代删掉了 COOP/COEP。控制台查 `crossOriginIsolated`，`false` 就是这条。见 4.1、4.2 |
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
