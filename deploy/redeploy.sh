#!/usr/bin/env bash
# 一条命令发一次版：拉取 → 重新编译镜像 → 起 skyland + nginx → 自检。
#
#   bash deploy/redeploy.sh
#   SKYLAND_CERT_HOST=111.229.172.59 bash deploy/redeploy.sh   # 首次跑，顺手签一张自签证书
#   SKYLAND_BRANCH=claude/xxx bash deploy/redeploy.sh          # 发别的分支
#   SKYLAND_PULL=0 bash deploy/redeploy.sh                     # 不动 git，只重编译当前工作区
#
# 编译在镜像里做（Dockerfile 的 build 阶段跑 npm ci && npm run build），所以这台机器
# 不需要装 Node，也不需要提前 npm install：改了代码就是重跑一次这个脚本。
#
# 注意两件事：
#   1. 拉取会**丢掉工作区里的本地改动**（`git checkout -f -B`）。部署机就该和远端一致，
#      要留东西先自己 commit 或 stash。用 checkout -B 而不是 git pull，是因为 main 的
#      历史被强推过，pull 会以 refusing to merge unrelated histories 失败。
#   2. 发版会踢掉所有在线玩家：房间状态只在 room-worker.mjs 子进程的内存里。
set -euo pipefail

cd "$(dirname "$0")/.."

BRANCH="${SKYLAND_BRANCH:-main}"
COMPOSE=(docker compose --profile nginx-tls)

if [ "${SKYLAND_PULL:-1}" = "1" ]; then
  echo "[1/5] 拉取 origin/$BRANCH"
  git fetch origin "$BRANCH"
  git checkout -f -B "$BRANCH" "origin/$BRANCH"
  git --no-pager log --oneline -1
else
  echo "[1/5] 跳过拉取（SKYLAND_PULL=0）"
fi

echo "[2/5] 检查 TLS 证书"
if [ ! -f deploy/tls/cert.pem ] || [ ! -f deploy/tls/key.pem ]; then
  host="${SKYLAND_CERT_HOST:-}"
  if [ -z "$host" ]; then
    echo "deploy/tls/ 里没有证书，nginx 起不来。" >&2
    echo "先跑 ./deploy/generate-self-signed-cert.sh <IP 或域名>，" >&2
    echo "或者 SKYLAND_CERT_HOST=<IP 或域名> bash deploy/redeploy.sh 让本脚本顺手签一张。" >&2
    exit 1
  fi
  sh deploy/generate-self-signed-cert.sh "$host"
else
  echo "  已有 deploy/tls/cert.pem"
fi

echo "[3/5] 重新编译并滚动替换"
"${COMPOSE[@]}" up -d --build

echo "[4/5] 清理悬空镜像"
docker image prune -f >/dev/null

echo "[5/5] 自检"
# 健康检查是镜像里的 HEALTHCHECK，间隔 30s，所以这里最多等 90s。
for _ in $(seq 1 45); do
  state="$(docker inspect -f '{{.State.Health.Status}}' skyland 2>/dev/null || echo unknown)"
  [ "$state" = healthy ] && break
  sleep 2
done
echo "  skyland 容器: ${state:-unknown}"
# 走 nginx 打一遍：这一条同时验了 TLS 收口、反代和服务端自己发的跨源隔离头。
# 没有 COOP/COEP/CORP 就没有 SharedArrayBuffer，客户端会直接抛「渲染循环搬不进线程」。
curl -kfsS https://127.0.0.1/api/health | head -c 400; echo
curl -kfsSI https://127.0.0.1/ | grep -i '^cross-origin' || {
  echo "跨源隔离响应头没拿到，页面会起不来——检查 deploy/nginx-tls.conf 有没有被改动过。" >&2
  exit 1
}
echo "发版完成。"
