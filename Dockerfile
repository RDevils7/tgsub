# syntax=docker/dockerfile:1

# 说明：仓库里的 package-lock.json 是在 Windows 上生成的，里面缺少 Linux 平台的
# 原生可选依赖（@rollup/rollup-linux-x64-gnu、@esbuild/linux-x64 等二进制包），
# `npm ci` 只会照 lock 装，容器里就会报 "Cannot find module @rollup/rollup-linux-x64-gnu"
# 导致 vite 构建失败（npm/cli#4828）。因此镜像内按 package.json 重新解析依赖树，
# 让 npm 装上当前架构的二进制；lock 仍保留给本地 Windows 开发使用。

############################
# 1. 开发依赖（含原生模块编译工具链）
############################
FROM node:22-bookworm-slim AS deps
WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_REGISTRY} \
    npm_config_fund=false \
    npm_config_audit=false

# better-sqlite3 需要预编译二进制；若 GitHub 不可达则回退到本地编译
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json

RUN rm -f package-lock.json \
 && npm install --no-audit --no-fund --include=optional

# 确认原生模块可用，失败则强制源码编译（需要上面的工具链）
RUN node -e "require('better-sqlite3')" \
 || npm_config_build_from_source=true npm rebuild better-sqlite3

############################
# 2. 生产依赖（运行时镜像用，不含任何 devDependency）
############################
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_REGISTRY} \
    npm_config_fund=false \
    npm_config_audit=false \
    NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json

RUN rm -f package-lock.json \
 && npm install --omit=dev --no-audit --no-fund --include=optional \
 && (node -e "require('better-sqlite3')" \
     || npm_config_build_from_source=true npm rebuild better-sqlite3)

# 关键原生依赖自检：缺一个就在构建期报错，而不是等到线上截帧/处理图片时才炸
#
# 注意：这里**不校验 ffprobe**。@ffprobe-installer 的二进制单独就占 75MB
# （amd64），是镜像体积最大的一层，也是从慢速镜像站拉取时卡住的直接原因。
# 现在由 server/src/tg/ffmpeg.ts 用 `ffmpeg -i` 的 stderr 解析替代，
# 用户若自备 ffprobe 仍会被优先使用。
RUN node -e "require('better-sqlite3')" \
 && node -e "console.log('ffmpeg:', require('@ffmpeg-installer/ffmpeg').path)" \
 && node -e "try{require('sharp');console.log('sharp: ok')}catch(e){console.log('sharp: 缺失（图片处理降级为原图复制）')}"

# 工作区软链（node_modules/server、node_modules/web）在运行镜像里是悬空的，直接清掉
RUN rm -f node_modules/server node_modules/web

############################
# 3. 构建（前端静态资源 + 后端 TS）
############################
FROM node:22-bookworm-slim AS build
WORKDIR /app

ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY web ./web

RUN npm -w web run build \
 && npm -w server run build

############################
# 4. 运行时（最小化镜像）
############################
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=6789 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    DOWNLOAD_DIR=/downloads \
    TZ=Asia/Shanghai \
    PUID=1000 \
    PGID=1000

# util-linux 提供 setpriv：入口脚本用它把 root 降权成 PUID/PGID
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini util-linux ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /downloads \
 && chown -R node:node /data /downloads /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist

# 入口脚本：以 root 启动时先把 /data /downloads 属主改成 PUID:PGID，再降权运行 node。
# NAS 场景（面板自动创建挂载目录、属主是 root）就是靠这一步解决反复重启的问题。
COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 注意：这里不写死 USER node。
# 入口脚本需要先以 root 身份 chown 挂载目录，之后自己用 setpriv 降权。
# 最终业务进程仍是 PUID/PGID（默认 node/1000）身份运行。

EXPOSE 6789

# ① 数据持久化目录：数据库、加密 session、封面缓存、临时截图
# ② 下载目录：实际下载的视频 / 图片 / 剧集目录
VOLUME ["/data", "/downloads"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||6789)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
