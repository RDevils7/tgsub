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
    npm_config_audit=false \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

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
    NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

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
# 镜像里只有 ffmpeg 一个媒体二进制：媒体信息（时长 / 分辨率 / 编码）由
# server/src/tg/ffmpeg.ts 解析 `ffmpeg -i` 的 stderr 得到，不需要额外的探测程序。
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

# 版本号：与 package.json / server/src/version.ts 保持一致。
# /api/health 与设置页都读它，镜像标签由 git tag 决定（v1.2.4 → v1.2.4 / latest）。
ARG APP_VERSION=1.3.19-test

ENV NODE_ENV=production \
    PORT=6789 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    DOWNLOAD_DIR=/downloads \
    TZ=Asia/Shanghai \
    PUID=1000 \
    PGID=1000 \
    APP_VERSION=${APP_VERSION} \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    FFMPEG_PATH=/usr/bin/ffmpeg

# OCI 标准标签：docker inspect / Docker Hub 都能看到版本与来源
LABEL org.opencontainers.image.title="tgsub" \
      org.opencontainers.image.description="Telegram 频道媒体订阅下载，自动生成 Emby 媒体库（NFO + 封面）" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/RDevils7/tgsub" \
      org.opencontainers.image.licenses="MIT"

# util-linux 提供 setpriv：入口脚本用它把 root 降权成 PUID/PGID
# 同时装 Chromium 运行所需的系统库（无头浏览器解析 SPA 站点的 m3u8 用）
#
# ffmpeg 装系统包而不是只用 npm 里的静态版：静态版在部分平台没编入 VAAPI，
# 而硬件转码（N100 这类带核显的 NAS 把 HEVC 实时转成 H.264）依赖 libva + iHD 驱动。
# 系统 ffmpeg 由 Debian 编译，VAAPI / QSV 都带；用 FFMPEG_PATH 指向它（优先于内置静态版）。
# intel-media-va-driver 是第 11 代以后核显（含 N100 / N305 的 Gen12）的 iHD 驱动。
# 注意：这个包只有 x86 版本（Debian 上仅 amd64 / i386），arm64 装了会直接「Unable to locate package」，
# 所以按架构判断，只有 x86 才装（arm64 NAS 没有 Intel 核显，本来也用不上）。
RUN set -eux; \
    apt-get update; \
    case "$(dpkg --print-architecture)" in \
      amd64|i386) HW_DRIVER="intel-media-va-driver" ;; \
      *)          HW_DRIVER="" ;; \
    esac; \
    apt-get install -y --no-install-recommends tini util-linux ca-certificates \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0 libxshmfence1 \
      libx11-6 libxcb1 libxext6 fonts-liberation \
      ffmpeg libva2 libva-drm2 ${HW_DRIVER}; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /data /downloads; \
    chown -R node:node /data /downloads /app

# yt-dlp：B站 / 抖音 / 小红书的下载引擎（约 30MB，自带 Python 运行时）。
# 这三个平台的播放地址都要签名，自己实现会随平台改版失效，交给 yt-dlp 跟版更稳。
# 用 node 下载以免额外装 curl；TARGETARCH 由 buildx 自动注入。
# 本地构建如果访问不了 GitHub，可以 --build-arg INSTALL_YTDLP=0 跳过（第三方下载功能不可用）。
ARG TARGETARCH
ARG INSTALL_YTDLP=1
RUN set -eux; \
    if [ "$INSTALL_YTDLP" = "1" ]; then \
      case "${TARGETARCH:-amd64}" in \
        arm64) asset=yt-dlp_linux_aarch64 ;; \
        *)     asset=yt-dlp_linux ;; \
      esac; \
      node -e "const fs=require('fs');const a=process.argv[1];fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/'+a).then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);const b=Buffer.from(await r.arrayBuffer());if(b.length<1e6)throw new Error('文件过小，可能是错误页');fs.writeFileSync('/usr/local/bin/yt-dlp',b,{mode:0o755});console.log('已下载 '+a+'，'+b.length+' 字节')}).catch(e=>{console.error(e);process.exit(1)})" "$asset"; \
      chmod +x /usr/local/bin/yt-dlp; \
      /usr/local/bin/yt-dlp --version; \
    else \
      echo "跳过 yt-dlp 安装"; \
    fi

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist

# 无头浏览器（Chromium）：仅用于渲染 SPA / 签名接口站点、截获真实 m3u8 请求。
# 浏览器二进制单独下载并固定到 /opt/playwright，运行时靠 PLAYWRIGHT_BROWSERS_PATH 定位。
# 镜像体积会比之前大（Chromium ~170MB），换来「网页链接自动解析」对所有主流视频站可用。
RUN set -eux; \
    export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright; \
    node_modules/.bin/playwright install chromium; \
    chmod -R a+rX /opt/playwright

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
