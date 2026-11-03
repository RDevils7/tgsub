# tgsub

**Telegram 频道关键词订阅下载器** —— 定时扫描频道，命中关键词就把整条消息（含相册整组）的文件下载到本地，按剧集命名并生成 Emby 能直接读取的元信息。带 Web 管理界面与 Telegram 机器人遥控。也能直接粘 B站 / 小红书 / YouTube 链接下载。

<p>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-1.3.0-2496ED.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-339933.svg">
  <img alt="Docker" src="https://img.shields.io/badge/docker-compose-2496ED.svg">
</p>

```
频道消息 ──▶ 定时扫描 ──▶ 关键词匹配 ──▶ 下载队列 ──▶ 剧集命名 + Emby 元信息 ──▶ 本地文件 + 管理界面
```

> 面向「订阅自己已加入的频道、把内容归档到本地媒体库」的自用场景。请遵守 Telegram 服务条款与内容版权。
> 完整文档（全部配置项、HTTP 接口、开发自检、排错）见 [PROJECT_DOC.md](PROJECT_DOC.md)。

---

## 本版更新（1.3.0）

**一句话：新增网页 / m3u8 视频下载（机器人 + Web 都能触发），并且「能不用代理的地方尽量直连」—— 下载列表每条任务都会标出走的是直连还是代理。**

1. **网页 / m3u8 视频下载**：粘贴普通网页链接或 `.m3u8` 直链即可下载。解析逐级兜底 —— 静态抓 HTML → 试常见播放器路径 → **用内置无头 Chromium 真正渲染页面**截获播放器发出的 m3u8（覆盖 SPA / 签名接口 / 加密接口的站点）。下载走 ffmpeg，AES-128 切片自动解密，防盗链自动带 `UA` / `Referer` / `Origin`。
2. **直连优先，能不用代理就不用**：默认先直连源站，直连不通（超时 / DNS 失败 / 连不上）才自动改走代理，并把「这个域名直连不通」记住一段时间，下次直接用代理，不再浪费时间重试。403 / 签名失效这类换线路也没用的错误不会重试。
3. **下载列表显示线路**：每条任务旁边标出「直连 / 代理 / 自动」徽章，Web 下载页与机器人 `/tasks` 都能看到；下载过程中会实时更新为实际走的线路。
4. **线路策略可配**：设置 → 网络与代理 → 「网页 / m3u8 视频下载」，可切换「直连优先 / 强制走代理 / 只用直连」，并单独指定该链路用的代理（`socks4/5/5h`、`http/https` 都支持 —— SOCKS 会自动转成本地桥给 ffmpeg 用）。
5. **代理来源更清晰**：网页下载的代理按「设置项 `m3u8_proxy` → `M3U8_BROWSER_PROXY` → `HTTPS_PROXY` / `HTTP_PROXY`」取，自动忽略 `127.0.0.1` / `localhost` 这类工具自带的内部代理。

> 1.2.4 的机器人下载列表全量显示、平台下载与 Telegram 并行、元数据封面圆角全部保留。完整历史与全部配置项见 PROJECT_DOC.md。
> 第三方平台仍为 **B站 / 小红书 / YouTube** 三个，引擎是镜像内置的 yt-dlp。

---

## 功能概览

- **订阅抓取**：关键词（包含 / 完整词 / 正则）定时增量扫描，命中后按消息为单位下载，相册整组归档。
- **剧集命名**：`《美人局》第4集` → `美人局/美人局S01E04.mp4`；多视频按原始文件名序号排序；认不出标题按正文首行建目录。
- **Emby 元信息**：落盘即写 `tvshow.nfo` + 单集 nfo + 缩略图，队列结束后可自动通知 Emby 增量扫描。
- **第三方平台**：B站 / 小红书 / YouTube，引擎为镜像内置 yt-dlp，与 Telegram 任务共用一条队列。
- **网页 / m3u8 视频下载**：粘贴网页链接或 `.m3u8` 直链，自动解析页面内视频并用 ffmpeg 合并下载（支持 Referer / UA 防盗链），与平台任务共用外部并行车道。**SPA / 签名接口站点**（视频地址藏在 JS 里、静态抓不到）会自动用内置无头 Chromium 渲染页面、截获真实 m3u8 请求，机器人发链接、Web 手动下载都支持。
- **队列管控**：串行下载（避免 MTProto 切 DC 断流），支持暂停 / 停止 / 继续 / 插队，实时速度与剩余时间。
- **元数据编辑页**：按目录聚合展示，可改 NFO、换封面、ffmpeg 截帧、框选裁剪；也能登记本地已有目录。
- **元数据管理**：目录树里剧集目录与每一集都能就地删除，可选「连磁盘文件一起删」或「仅从列表移除（可恢复）」；删除会同步清掉下载记录与来源登记。
- **监控历史 / 日志页**：每次扫描留痕可搜索；运行日志按级别筛选、落盘到 `data/logs/app.log`。
- **扫码登录**：无需申请 api_id / api_hash，session 加密存储，重启免登录。
- **机器人**：手机上发链接即下载，也能扫描、加频道、改订阅、看队列。

---

## 部署（Docker Compose）

镜像双架构（`linux/amd64` + `linux/arm64`），只需要 Docker 20.10+ 与 compose v2，**不用 clone 仓库、不用编译**。

```bash
# 1. 建目录（容器内以 node(1000) 运行，属主必须是 1000:1000）
mkdir -p tgsub/data tgsub/downloads && cd tgsub
sudo chown -R 1000:1000 data downloads
```

```yaml
# 2. docker-compose.yml
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
      LOG_LEVEL: info
      PUID: "1000"
      PGID: "1000"
      SESSION_SECRET: ""
      BASIC_AUTH_USER: ""
      BASIC_AUTH_PASS: ""
    volumes:
      - ./data:/data
      - ./downloads:/downloads
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:6789/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 25s
    deploy:
      resources:
        limits:
          memory: 1G
```

```bash
# 3. 启动
docker compose up -d && docker compose logs -f --tail=200
```

访问 `http://<服务器IP>:6789`。备用仓库 `ghcr.io/rdevils7/tgsub:latest`（内容一致，国内优先 Docker Hub）。

| 目录 | 内容 |
| --- | --- |
| `./data` | `tgsub.db`、加密 session、`.session-secret`、封面缓存、日志 |
| `./downloads` | 实际媒体文件（视频 / 图片 / nfo / 封面） |

**NAS 部署注意**：面板自动创建的挂载目录属主是 `root`，容器会反复重启并报 `EACCES ... /data/.session-secret`。入口脚本会自动把属主改成 `PUID/PGID`；若仍失败，把 `PUID/PGID` 改成 NAS 账号的 uid/gid（`id <用户名>` 查看）。
**拉取卡住**：Docker 配镜像加速器，或临时改成 `image: docker.1ms.run/rdevils7/tgsub:latest`。

---

## 首次配置

1. **配代理** —— 设置 → 网络与代理，填 SOCKS4 / SOCKS5 / HTTP / HTTPS 地址，点「联网测试」确认能连通 Telegram API。
2. **扫码登录** —— 设置 → Telegram 账号 → 扫码登录（手机 Telegram → 设置 → 设备 → 链接桌面设备）。
3. **加频道** —— 频道页粘贴 `@channel` 或 `t.me` 链接；私有频道用 `t.me/c/<内部ID>/<消息ID>`。
4. **建订阅** —— 填关键词、选匹配方式与生效频道。
5. **等扫描** —— 默认 15 分钟一次，也可在概览页点「立即扫描」。

**代理地址别填 `127.0.0.1`**：容器里的 `127.0.0.1` 是容器自己，访问宿主机代理要用 `host.docker.internal:7890`（Linux 需加 `extra_hosts: ["host.docker.internal:host-gateway"]`）或局域网 IP。

---

## 常用配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `6789` | 监听端口 |
| `DATA_DIR` / `DOWNLOAD_DIR` | `./data` / `$DATA_DIR/downloads` | 数据与下载目录；Docker 里为 `/data`、`/downloads` |
| `SESSION_SECRET` | 自动生成 | 加密 session 的密钥（≥16 位）。**一旦设定不要改**，否则需重新扫码 |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | 空 | 同时设置即启用 HTTP Basic 认证，暴露公网时建议开 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `TZ` | `Asia/Shanghai` | 时区，影响日志与按天分目录 |
| `M3U8_BROWSER_PROXY` | 空 | 网页 / m3u8 下载的**备用**代理，如 `http://192.168.5.2:7890`。默认仍先直连，不通才用它；未设时回落到 `HTTPS_PROXY` / `HTTP_PROXY`（`127.0.0.1` 会被忽略）。界面设置项 `m3u8_proxy` 优先级更高 |

界面设置项（扫描间隔、路径模板、画质、Cookie、机器人开关等）存数据库，「设置」页改完即生效，不用重启。

---

## 第三方平台（B站 / 小红书 / YouTube）

设置 → 第三方平台 → 打开开关，然后到「手动下载」页粘链接；短链与**整段分享口令**都能直接粘：

```
【李世民已经是太子…-哔哩哔哩】 <https://b23.tv/29inbIp>
举手大喊：姐姐看我！… <https://xhslink.cn/o/8c7hpV57rvQ> 复制文本后进入【小红书】
```

同样几段话直接发给机器人也会开始下载（一次最多 5 条）。

**清晰度**默认「最高（原画）」，按平台实际能给的码率取；B站大会员 / 小红书登录态才会出现 1080P 以上，想省空间可降成固定档位。

**Cookie**（设置 → 第三方平台，加密落盘，只回摘要不发明文）。粘贴时即时解析，保存后显示「5 项 · SESSDATA / bili_jct · 2 天前」，缺关键字段会标黄。鼠标悬停平台名后的 `?` 有分步取法。

| 平台 | 关键字段 | 不填会怎样 |
| --- | --- | --- |
| B站 | `SESSDATA`（大会员还需 `bili_jct`、`DedeUserID`） | 只能拿 480P 左右，部分视频直接 412 |
| 小红书 | `web_session`、`a1` | 大概率空流或要求登录 |
| YouTube | `SID`、`SAPISID`（会员 / 年龄限制才需要） | 公开视频不填也行 |

**代理**：默认只有 YouTube 与「检查更新」走代理（设置 → 第三方平台 → 「第三方平台代理」填 `http://192.168.1.2:7890`，只作用于 yt-dlp，不影响 Telegram）。
B站 / 小红书 **默认直连** —— B站 的 CDN 会把海外代理 IP 判成 `HTTP Error 567`，绕出去反而下不动。
服务器本身在海外、又要下国内平台时，勾上「国内平台也走代理」即可，但 B站 仍可能 567。

**落盘结构**（每条视频一个目录，Emby 里是独立条目）：

```
downloads/第三方/B站/UP主名字/视频标题 [BV1xx411c7mD]/
    视频标题 [BV1xx411c7mD].mp4    ← 编码不兼容 mp4 时自动是 .mkv，Emby 一样能读
    视频标题 [BV1xx411c7mD].nfo        ← 标题 / 简介 / UP主 / 分区 / 日期 / 播放点赞
    视频标题 [BV1xx411c7mD]-thumb.jpg
    tvshow.nfo  poster.jpg  landscape.jpg  fanart.jpg
```

> Emby 媒体库要勾选「优先使用本地元数据 / 启用 NFO」，否则它会先联网刮削再读 nfo，把上面这些字段盖掉。

---

## 网页 / m3u8 视频

「手动下载」页可以直接粘**普通网页链接**或 **`.m3u8` 直链**；把链接直接发给机器人也一样会开始下载。

**解析顺序**（逐级兜底）：

1. 静态抓页面 HTML，找 `<video>` / `<source>` / JS 变量里的 m3u8；
2. 试常见播放器路径（`playlist.m3u8`、`index.m3u8`、`live.m3u8`、`hls.m3u8`）；
3. 都不行就**用无头浏览器真正渲染页面**，监听网络请求截获播放器实际发出的 m3u8 —— 这一步能覆盖 SPA / 签名接口 / 加密接口的站点（短视频站、短剧站大多属于这类）。

**下载**：ffmpeg 合并成 mp4，AES-128 加密的切片会自动取 key 解密；防盗链自动带 `User-Agent` + `Referer` + `Origin`（不支持自定义 Cookie）。

**线路（直连优先）**：默认**先直连**，直连不通才自动改走代理，并记住这个域名下次直接走代理。
Web 下载页与机器人 `/tasks` 每条任务都会标出「直连 / 代理 / 自动」徽章，下载中会实时更新。

设置 → 网络与代理 → 「网页 / m3u8 视频下载」可改三件事：

| 项 | 说明 |
| --- | --- |
| 线路策略 | `直连优先`（默认）/ `强制走代理` / `只用直连` |
| 代理地址 | 留空则用环境变量 `M3U8_BROWSER_PROXY` / `HTTPS_PROXY`；`socks4/5/5h`、`http/https` 都支持 |

> SOCKS 代理会自动转成本地 HTTP 桥再喂给 ffmpeg —— ffmpeg 原生只认 `http_proxy`，且不支持 socks4。
> Docker 内置 Chromium，镜像会比之前大一些（+约 170MB）。

**落盘结构**（下载完自动生成 nfo 与封面，Emby 可直接识别）：

```
downloads/m3u8/剧集名/剧集名.mp4
downloads/m3u8/剧集名/剧集名.nfo
```

> 解析失败时按提示用浏览器 F12 → Network → 过滤 `.m3u8` → 复制那条请求地址，直接粘成 m3u8 直链下载。

---

## 镜像标签

| 标签 | 含义 |
| --- | --- |
| `latest` | 最新一次 `v*` 发布构建的镜像 |
| `v1.3.0` | 固定版本（**生产环境建议锁定**） |

只有这两个标签：push `main` 只跑构建与冒烟测试、不发布镜像。

---

## 升级与备份

```bash
docker compose pull && docker compose up -d   # 升级，数据保留
docker compose restart                        # 优雅重启（先断 Telegram 再退出）
docker compose down                           # 停止，./data 与 ./downloads 不动
```

- 从 1.0.4 之前的版本升级：下载文件曾经落在 `./data/downloads`，先 `mv data/downloads/* downloads/` 再 `rmdir data/downloads`。
- **备份**打包 `./data` 即可恢复全部配置与记录（建议先 `docker compose stop` 让 SQLite WAL 落盘）；下载文件在 `./downloads`。恢复时保持 `SESSION_SECRET` 不变。
- 查看运行版本：`curl -s http://<IP>:6789/api/health`。

---

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 容器反复重启，`EACCES ... /data/.session-secret` | 挂载目录属主不是 1000；`chown -R 1000:1000 data downloads`，NAS 上可改 `PUID/PGID` |
| 拉镜像卡在某个百分比 | 配镜像加速器，或 `image: docker.1ms.run/rdevils7/tgsub:latest` |
| 「连接异常，延迟重连」刷屏 | 先看设置页「联网测试」：Telegram API 超时就是代理没生效 |
| 扫码后立刻掉线 | 代理不稳定或 IP 被风控；换节点，必要时走「彻底重置并重新登录」 |
| 新集没出现在 Emby | 确认「Emby 入库通知」地址 / API Key / 路径映射三项都对，点「测试连接」 |
| `yt-dlp 不可用` | 镜像低于 1.2.0 或本地开发没装；升级镜像，或在设置里手填路径 |
| `要求登录` / `风控拦截（412）` | Cookie 过期，重新复制一次；已下载的文件不受影响 |
| `连不上 YouTube` | 没配第三方平台代理，或节点不通；YouTube 还需在代理地区可用 |
| 日志 `SSL: UNEXPECTED_EOF_WHILE_READING` | 代理把长连接掐了（1.1.1 起自动重试 10 次）；仍频繁出现就换节点或避开高峰期 |
| 日志 `Postprocessing` / `Could not find tag for codec` | 音视频合并失败，1.1.1 起用 `mp4/mkv` 兜底；老任务先删掉该目录里的 `.part` / `.webm` / `.m4a` 再重试 |
| `HTTP Error 567: Unknown Status`（B站） | CDN 拒绝了下载分片：先确认没开「国内平台也走代理」（海外 IP 会被判 567），再确认 Cookie 没过期 |

更多报错与细节见 [PROJECT_DOC.md](PROJECT_DOC.md)。

---

## 安全提示

程序会以你的 Telegram 账号身份读取频道内容，请自行评估风险；不要把管理界面直接暴露到公网（必要时开 `BASIC_AUTH_*`）。本工具不提供任何内容，仅用于归档你已有权限访问的内容。

## License

[MIT](LICENSE)
