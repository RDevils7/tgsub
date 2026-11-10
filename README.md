# tgsub

**Telegram 频道关键词订阅下载器** —— 定时扫描已加入的频道，命中关键词就把整条消息（含相册整组）下载到本地，按剧集命名并写好 Emby 元信息。带 Web 管理界面、Telegram 机器人遥控，也能直接粘 B站 / 小红书 / YouTube / 网页 m3u8 链接下载。

<p>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-1.3.18-2496ED.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-339933.svg">
</p>

> 当前正式版 **1.3.18**（镜像 `rdevils7/tgsub:v1.3.18` / `latest`）。本页只讲**部署与使用**；配置项全集、HTTP 接口、排错细节见 [PROJECT_DOC.md](PROJECT_DOC.md)。

```
频道 → 定时扫描 → 关键词命中 → 下载队列 → 剧集命名 + NFO/封面 → 本地媒体库 + Web 界面
```

---

## 本版更新（1.3.18）

| 改动 | 说明 |
| --- | --- |
| **机器人直接收文件** | 私聊里把视频 / 文件发给机器人就自动下载，**没有文字也算**；用 bot 自己的 MTProto 客户端取媒体，不受 Bot API 20MB 限制，1GB 文件照常可下 |
| **文件夹分享机器人可用** | 识别 `📁 标题` 与 `✅ 发送完成` 状态卡片：不再报解析失败、不再刷 /help；标题记住 15 分钟，给随后推来的文件命名归档 |
| **重启可回源、重名不覆盖** | 任务用 `tgbot:<chatId>:<messageId>` 定位，进程重启后按 access_hash 补取消息；同一分享里多个文件撞名自动加消息 ID 后缀 |

- 校验：`typecheck` 0 错误、自检 **402** 项、bot 测试 **18** 项、`build` 全绿；隔离实例端到端 **6** 项（入队 → 落盘 → 查重 → 重启回源 → 重名消解）全过。
- 1.3.17 的媒体库任意目录 / bot 入站日志 / Emby 设置三合一、1.3.16 的 strm 播放与截帧封面、1.3.15 的响应速度与 yt-dlp 精确排期、1.3.14 的自绘播放器全部保留。

---

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 订阅抓取 | 关键词（包含 / 完整词 / 正则）定时增量扫描，按消息为单位下载，相册整组归档 |
| 剧集命名 + Emby 元信息 | `《美人局》第4集` → `美人局/美人局S01E04.mp4`，落盘即写 `tvshow.nfo`、单集 nfo、缩略图，可选自动通知 Emby 增量扫描 |
| 本地媒体库 | 海报墙浏览、点开即播；自绘控制条（跳秒 / 倍速 / 截图 / 画中画 / 连播）。按文件自动选 direct / remux / 硬解转码 |
| `.strm` 链接 | 服务端转发直链（支持 Range 与跳转）；播放时自动截一帧当封面、可手动覆盖；封面与 NFO 落同级目录，选中目录后批量补齐缺失的 NFO，**全程零批量回源** |
| 文件整理 | 整剧改名、分集合并（集号自然序重排）、移动套用目标命名、复制 / 删除 / 隐藏（可恢复），重名一律跳过不覆盖 |
| 元数据管理 | 按来源分区，可改 NFO、换封面、ffmpeg 截帧裁剪 |
| 第三方平台 | B站 / 小红书 / YouTube（镜像内置 yt-dlp，默认每 15 天检查更新），与 Telegram 共用队列 |
| 网页 / m3u8 | 静态解析 → 试常见路径 → 无头 Chromium 截获三级兜底，可过 Cloudflare 非交互挑战并把 Cookie 带进下载 |
| 队列与记录 | 串行下载、暂停 / 停止 / 继续 / 插队；手动下载逐条留痕（状态、摘要、失败原因） |
| 概览 / 日志 | 服务状态、工具链路径与版本、磁盘余量；日志按级别筛选并落盘 |
| 登录与机器人 | 首次访问强制设管理员账号（scrypt + 会话落库，重启不掉线）；扫码登录 Telegram，无需申请 api_id；机器人可直接收文件与链接 |

---

## 部署（Docker Compose，推荐）

双架构镜像 `linux/amd64` + `linux/arm64`，**不用 clone、不用编译**，Docker 20.10+ / compose v2 即可。

```bash
mkdir -p tgsub/data tgsub/downloads && cd tgsub
sudo chown -R 1000:1000 data downloads   # 容器内以 node(1000) 运行
```

```yaml
# docker-compose.yml
services:
  tgsub:
    image: rdevils7/tgsub:latest
    container_name: tgsub
    restart: unless-stopped
    ports:
      - "6789:6789"
    environment:
      TZ: Asia/Shanghai
      DATA_DIR: /data
      DOWNLOAD_DIR: /downloads
      PUID: "1000"
      PGID: "1000"
      SESSION_SECRET: ""        # 设了就别改，否则要重新扫码
    volumes:
      - ./data:/data
      - ./downloads:/downloads
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:6789/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 25s
```

```bash
docker compose up -d && docker compose logs -f --tail=200
```

访问 `http://<服务器IP>:6789`。备用仓库 `ghcr.io/rdevils7/tgsub:latest`（内容一致，国内优先 Docker Hub）。

| 目录 | 内容 |
| --- | --- |
| `./data` | `tgsub.db`、加密 session、`.session-secret`、封面缓存、日志 |
| `./downloads` | 媒体文件，按来源分 `telegram` / `B站` / `小红书` / `youtube` / `m3u8` 子目录 |

**四条容易踩的坑**

- 挂载目录属主必须是 `1000:1000`；NAS 自动建的目录属主是 `root`，会报 `EACCES ... /data/.session-secret`。入口脚本会按 `PUID/PGID` 修，仍失败就把它们设成 NAS 账号的 uid/gid（`id <用户名>`）。
- 硬件转码**只加** `devices: ["/dev/dri:/dev/dri"]`；**不要写 `group_add: ["video","render"]`**（NAS 没有 `render` 组，容器创建即失败）。没有 `/dev/dri` 的机器不要加这一段。
- 代理别填 `127.0.0.1`：那是容器自己。用 `host.docker.internal:7890`（Linux 加 `extra_hosts: ["host.docker.internal:host-gateway"]`）或局域网 IP。
- 拉镜像卡住：配加速器，或临时改 `image: docker.1ms.run/rdevils7/tgsub:latest`。

有 Intel 核显时可在概览页看「硬件解码」是否可用；HEVC 在 Chrome 上会自动转 H.264，Safari 能直解则不占显卡。转码流拖进度条等于从新位置重开一段（约 1~3 秒），属实时流固有代价。

---

## 第一次打开：五步

1. **设账号** —— 首访强制设置（用户名 + ≥8 位密码），会话落库，重启不掉线；同一 IP 连错 5 次锁 5 分钟。
2. **配代理** —— 设置 → 网络与代理，填 SOCKS5 / HTTP，点「联网测试」确认能连通 Telegram API。
3. **扫码登录** —— 设置 → Telegram 账号 → 扫码（手机 Telegram → 设置 → 设备 → 链接桌面设备）。
4. **加频道 + 建订阅** —— 频道页粘 `@channel` 或 `t.me` 链接（私有频道用 `t.me/c/<内部ID>/<消息ID>`）；订阅页填关键词与匹配方式。
5. **等扫描** —— 默认 15 分钟一次，概览页可点「立即扫描」。

> 忘记密码：compose 临时加 `AUTH_DISABLED: "1"` → 重启 → 设置 → 账号与安全 → 重设密码 → **删掉这行再重启**。该开关等于关掉整个鉴权，用完必须撤销。

---

## 常用配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `6789` | 监听端口 |
| `DATA_DIR` / `DOWNLOAD_DIR` | `./data` / `$DATA_DIR/downloads` | 数据与下载目录；Docker 内为 `/data`、`/downloads` |
| `SESSION_SECRET` | 自动生成 | 加密 session 的密钥（≥16 位）；**改了要重新扫码** |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | 空 | 同时设置即开 HTTP Basic，配合反代暴露公网 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `HW_ACCEL` | 自动探测 | `vaapi` / `qsv` / `software` / `none` |
| `M3U8_BROWSER_PROXY` | 空 | 网页 / m3u8 备用代理；未设时回落 `HTTPS_PROXY` / `HTTP_PROXY` |
| `AUTH_DISABLED` | 空 | 应急开关：`1` 关闭管理界面登录，用完必须删 |
| `TZ` | `Asia/Shanghai` | 时区，影响日志与按天分目录 |

界面里的设置（扫描间隔、路径模板、画质、Cookie、机器人等）存数据库，改完即生效，不用重启。

---

## 其它用法要点

- **机器人直接收文件**：私聊把视频 / 文件发给机器人即可，**不用转发频道消息，也不用带文字**；文件夹分享机器人（`t.me/xxx?start=…`）的标题卡片与完成通知会自动识别，文件推来即下载。图片仍受「🖼 图片下载」开关控制；bot 离线时任务会明确提示重发。
- **第三方平台**：设置 → 第三方平台打开开关，到「手动下载」粘链接或整段分享口令（机器人一次最多 5 条）；1080P 以上需登录态，Cookie 在设置页粘贴（加密落盘）。B站 / 小红书默认直连，YouTube 与更新检查走代理 —— 海外 IP 下 B站会被判 `HTTP Error 567`。
- **网页 / m3u8**：直连优先，失败自动换代理再下一次；解析与下载沿用同一条线路。`cf_clearance` / `auth_key` 绑定出口 IP，代理池轮换会时好时坏。媒体库播 `.strm` 是另一条链路，**一律直连**。
- **Emby**：媒体库要勾「优先使用本地元数据 / 启用 NFO」；容器路径与 Emby 看到的路径不同时必须填「路径映射」，否则通知会被静默忽略。
- 细节（接口、代理优先级、风控、目录白名单、日志字段）见 [PROJECT_DOC.md](PROJECT_DOC.md)。

---

## 镜像与升级

| 标签 | 含义 |
| --- | --- |
| `latest` | 最新一次 `v*` 发布 |
| `v1.3.18` | 固定版本，**生产建议锁定** |

push 到 `main` 只跑构建与冒烟测试、不发镜像；打 tag 才构建 amd64 + arm64 并推送。

```bash
docker compose pull && docker compose up -d   # 升级，数据保留
docker compose restart                        # 优雅重启
curl -s http://<IP>:6789/api/health            # 查版本
```

- **备份**：先 `docker compose stop` 让 SQLite WAL 落盘，打包 `./data` 即可恢复全部配置与记录；媒体文件在 `./downloads`。恢复时保持 `SESSION_SECRET` 不变。
- 1.0.4 之前升级：先 `mv data/downloads/* downloads/ && rmdir data/downloads`。

---

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 容器反复重启 / `EACCES` | `chown -R 1000:1000 data downloads`，NAS 上改 `PUID/PGID` |
| 容器 running 但网页打不开 | `docker port tgsub` 查映射；`docker exec tgsub node -e "fetch('http://127.0.0.1:6789/api/health').then(r=>r.text()).then(console.log)"` 有 JSON 即服务正常，问题在端口 / 防火墙 / 反代（镜像内无 curl）；用 http 不是 https |
| 忘记管理密码 | 临时 `AUTH_DISABLED: "1"` → 重设密码 → 删掉重启 |
| 登录框刷「连接异常，延迟重连」 | 代理没生效，设置页点「联网测试」 |
| 机器人发文件没反应 | 确认已升级到 1.3.18、bot 在线；纯图片需打开「🖼 图片下载」；任务失败看日志里的 `bot-media-*` 记录 |
| 新集不出现在 Emby | 查地址 / API Key / 路径映射，点「测试连接」；再确认 Emby 已勾本地 NFO |
| 评论区链接报「不在讨论组里」 | 会依次试 6 条路定位讨论组；私密群 + 账号不在群里只能先用同一账号加群 |
| 网页视频 `403` / 一直 `Just a moment...` | Cloudflare 挑战会由无头浏览器自动过（15~30 秒）；老任务里的 `&amp;` 已自动还原，点「重试」即可 |
| HEVC 播不了 / 黑屏 | 有核显加 `devices` 并重启；没有核显用 Safari / Edge 开「HEVC 直连」 |
| 显示「无硬解」 | 没映射 `/dev/dri` 或宿主机没装 Intel 驱动，概览页那行会写具体原因 |
| 改名 / 合并后顺序不对 | 按解析出的集号排，解析不出的垫后按文件名自然序；执行前有「旧名 → 新名」预览 |

更多报错见 [PROJECT_DOC.md](PROJECT_DOC.md)。

---

## 安全提示

程序以你的 Telegram 账号身份读取频道内容，请自行评估风险。管理界面的账号密码是家庭 / 内网强度；暴露公网前请套反代 + HTTPS，必要时叠加 `BASIC_AUTH_*`。改名 / 合并会**真实移动磁盘文件**，第一次建议拿副本目录试。本工具不提供任何内容，仅用于归档你已有权限访问的内容。

## License

[MIT](LICENSE)
