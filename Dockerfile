# syntax=docker/dockerfile:1

############################
# 1. 依赖安装（含原生模块编译工具链）
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

RUN npm ci --no-audit --no-fund \
 || (rm -rf node_modules && npm install --no-audit --no-fund)

# 确认原生模块可用，失败则强制源码编译（需要上面的工具链）
RUN node -e "require('better-sqlite3')" \
 || npm_config_build_from_source=true npm rebuild better-sqlite3

############################
# 2. 构建（前端静态资源 + 后端 TS）
############################
FROM node:22-bookworm-slim AS build
WORKDIR /app

ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY web ./web

RUN npm -w web run build \
 && npm -w server run build \
 && npm prune --omit=dev

############################
# 3. 运行时（最小化镜像）
############################
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/downloads \
 && chown -R node:node /data /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/web/dist ./web/dist

USER node
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
