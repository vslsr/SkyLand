# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

# 依赖清单单独复制，业务代码变化时可以复用 npm ci 缓存。
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production \
    SKYLAND_SERVER_HOST=0.0.0.0 \
    SKYLAND_SERVER_PORT=3090 \
    SKYLAND_WEB_ROOT=/app/dist

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# Node 服务器在同一端口提供 dist、/api 和 /ws；房间 DS 由 server 内的
# room-worker.mjs 子进程承载。config 和 shared 是服务端运行时依赖。
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/config ./config

# PlayerTransformLogStore 会往 /app/logs 写调试日志。镜像里以 node 用户运行，
# /app 归 root，所以目录必须提前建好并交给 node，否则调试落盘会 EACCES。
# 不声明 VOLUME：那会让每次 docker run 都留下一个匿名卷。要持久化就在
# docker run / compose 里显式挂 /app/logs。
RUN mkdir -p /app/logs && chown node:node /app/logs

USER node

EXPOSE 3090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.SKYLAND_SERVER_PORT || '3090') + '/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "server/index.mjs"]
