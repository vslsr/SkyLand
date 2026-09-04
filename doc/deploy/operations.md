# 日常运维与后续演进

`build-and-run.md` 讲的是「怎么第一次部署起来」，这一份讲「跑起来之后要做什么」。

文中一律用 `<公网IP>` / `<域名>` 占位。仓库是公开的，具体主机信息不写进来——
需要的话记在服务器本地的 `.env` 或运维手册里。

## 当前形态

```
浏览器 ──https──▶ nginx:443（自签证书，terminate TLS）
                     │  proxy_pass，透传 COOP/COEP，转发 WebSocket 升级
                     ▼
                 skyland:3090（Node）── fork ──▶ room-worker.mjs × N
                     │
                     └── 同一端口提供 dist/ · /api/* · /ws
```

- 启动方式：`docker compose --profile nginx-tls up -d`
- skyland 容器本身只监听 `127.0.0.1:3090`，对外由 nginx 收口
- 证书在 `deploy/tls/`（不入库），由 `deploy/generate-self-signed-cert.sh` 生成

## 发版

```bash
cd <仓库目录>
git pull
docker compose --profile nginx-tls up -d --build
docker image prune -f
```

只改了 `deploy/nginx-tls.conf` 时不用重建镜像：

```bash
docker compose restart nginx
```

**发版会踢掉所有在线玩家。** 房间状态只存在于 `room-worker.mjs` 子进程的内存里，
没有持久化也没有迁移，容器一停就没了。挑低峰期。

发完自查：

```bash
curl -kI https://127.0.0.1/ | grep -i cross-origin   # COOP/COEP/CORP 三行都要在
curl -k  https://127.0.0.1/api/health                # webReady 必须是 true
```

浏览器侧的验收永远是这一句，不要靠「看起来能动」：

```js
console.log({ secure: isSecureContext, isolated: crossOriginIsolated });
// 必须是 { secure: true, isolated: true }
```

## 回滚

镜像还在本地时直接切回旧 tag：

```bash
docker images skyland
docker tag skyland:<旧tag> skyland:latest
docker compose --profile nginx-tls up -d
```

所以**每次发版前先给当前镜像打个日期 tag**，否则 `up -d --build` 会把 `latest`
覆盖掉，没有可回滚的目标：

```bash
docker tag skyland:latest skyland:$(date +%Y%m%d)
```

## 证书续期

自签证书有效期 825 天，到期前重跑脚本再重启 nginx：

```bash
./deploy/generate-self-signed-cert.sh <公网IP>
docker compose restart nginx
```

查剩余有效期：

```bash
openssl x509 -in deploy/tls/cert.pem -noout -enddate
```

换成 Let's Encrypt（下一节）之后这一步就不需要了，Caddy 自动续。

## 后续演进

按优先级：

### 1. 换成备案域名 + Let's Encrypt

自签证书的代价是**每个新访客都要点一次「不安全」警告**——自己测没问题，对外发就是
劝退门槛。有了已备案域名之后：

```bash
echo 'SKYLAND_SITE=<域名>' > .env
docker compose --profile nginx-tls down
docker compose --profile tls up -d
```

Caddy 自动签发和续期，浏览器无警告。注意 80 和 443 都要能从公网访问（HTTP-01 挑战
走 80）。境内服务器必须先完成 ICP 备案，否则未备案域名走 80/443 会被云厂商拦截，
详见 `build-and-run.md` 4.2 里那条警告。

服务器换到境外节点也能立刻解决备案问题。

### 2. 让 h5sgame 和 SkyLand 共存

现在 `h5sgame-prod-nginx-1` 是停着的——两个站都要 80/443，没有域名时无法区分。
有域名之后用 `server_name` 分流即可，一个 nginx 带两个 server 块：

```nginx
server { server_name skyland.<域名>;  location / { proxy_pass http://skyland:3090; ... } }
server { server_name h5sgame.<域名>;  location / { proxy_pass http://h5sgame:3000; ... } }
```

两个容器要在同一个 Docker 网络里，nginx 才能按服务名访问。
在此之前的临时办法是给其中一个换非标准端口。

### 3. 房间状态持久化

目前重启即丢。要做无损发版就得先把房间状态搬出进程内存，这是引擎侧的改动，
不是部署能解决的。

### 4. 日志与监控

`/app/logs` 已经挂在 `skyland-logs` 卷上，但那只是调试用的 PlayerTransform 记录。
容器 stdout 目前没有轮转配置，长期跑要加：

```yaml
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

健康状态可以直接读：

```bash
docker inspect --format '{{.State.Health.Status}}' skyland
```

## 备份

需要留存的只有两样，其余都能从仓库重建：

| 路径 | 内容 | 丢了会怎样 |
| --- | --- | --- |
| `deploy/tls/` | 自签证书和私钥 | 重跑脚本即可，访客要重新点一次警告 |
| `skyland-logs` 卷 | 调试日志 | 只影响回溯，不影响运行 |
| `caddy-data` 卷 | LE 证书和账户密钥 | 会重新签发，注意 LE 频率限制 |

```bash
docker run --rm -v skyland-logs:/data -v "$PWD":/backup alpine \
  tar czf /backup/skyland-logs-$(date +%F).tar.gz -C /data .
```

## 排查

先分层定位，别一上来就猜：

```bash
docker compose ps                                    # 容器都在吗
docker compose logs --tail=100 nginx                 # 反代这一层
docker compose logs --tail=100 skyland               # 应用这一层
curl -k https://127.0.0.1/api/health                 # 绕过公网，服务本身好吗
```

| 现象 | 大概率原因 |
| --- | --- |
| 浏览器一直转圈，服务器日志什么都没有 | 安全组没放行 443，请求根本没到机器 |
| nginx 起不来，`host not found in upstream "skyland"` | skyland 容器没起；`depends_on` 只管顺序不管就绪 |
| 页面报「拿不到 SharedArrayBuffer」 | 走了 http，或反代覆盖了 COOP/COEP。`curl -kI` 查那三行 |
| 页面能开，进房间就断 | WebSocket 升级没转发，或 `proxy_read_timeout` 太短 |
| `webReady: false`，页面 503 | 镜像里没有 `dist/`，构建阶段 `vite build` 失败了 |

更完整的排查表在 `build-and-run.md` 第 6 节。
