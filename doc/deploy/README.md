# 部署文档

| 文档 | 讲什么 |
| --- | --- |
| [`build-and-run.md`](build-and-run.md) | 第一次部署：镜像构建、分发、compose、环境变量、四种拿到 HTTPS 的方案、反代配置 |
| [`operations.md`](operations.md) | 跑起来之后：发版、回滚、证书续期、后续演进、备份、分层排查 |

配置文件本身在仓库根的 [`deploy/`](../../deploy/) 下：

- `nginx-tls.conf` —— nginx 终止 TLS 的反代配置（`--profile nginx-tls`）
- `Caddyfile` —— Caddy + Let's Encrypt（`--profile tls`）
- `generate-self-signed-cert.sh` —— 生成自签证书到 `deploy/tls/`

## 一句话版本

一个 Node 进程在同一端口提供 `dist/`、`/api/*` 和 `/ws`，每个房间再 fork 一个
`room-worker.mjs` 子进程。容器本身只监听回环，对外由一层终止 TLS 的反代收口。

**HTTPS 不是可选项**：客户端要 `SharedArrayBuffer` 才能把渲染循环搬进 worker，
而它只在安全上下文里可用。纯 HTTP 部署下页面会直接抛
「拿不到 SharedArrayBuffer」，没有降级路径。
