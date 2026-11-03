# tgsub

**Telegram 频道关键词订阅下载器** —— 定时扫描频道，命中关键词就把整条消息（含相册整组）的文件下载到本地，按剧集命名并生成 Emby 能直接读取的元信息。带 Web 管理界面与 Telegram 机器人遥控。也能直接粘 B站 / 小红书 / YouTube / 网页视频链接下载。

<p>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-1.3.2-2496ED.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-339933.svg">
  <img alt="Docker" src="https://img.shields.io/badge/docker-compose-2496ED.svg">
</p>

```
频道消息 ──▶ 定时扫描 ──▶ 关键词匹配 ──▶ 下载队列 ──▶ 剧集命名 + Emby 元信息 ──▶ 本地文件 + 管理界面
```

> 面向「订阅自己已加入的频道、把内容归档到本地媒体库」的自用场景。请遵守 Telegram 服务条款与内容版权。
> 完整文档（全部配置项、HTTP 接口、开发自检、排错）见 [PROJECT_DOC.md](PROJECT_DOC.md)。

---

## 本版更新（1.3.2）

**一句话：下载目录按来源拆开、每一项都能单独设；管理界面加了登录密码，首次打开必须设置账号。**

1. **每个来源一个目录，能单独改** —— 以前第三方平台全堆在 `downloads/第三方/` 下，Telegram 又直接落在下载根目录。现在五个来源各占一级：

   | 来源 | 默认目录 |
   | --- | --- |
   | Telegram | `downloads/telegram/` |
   | B站 | `downloads/B站/` |
   | 小红书 | `downloads/小红书/` |
   | YouTube | `downloads/youtube/` |
   | 网页 / m3u8 | `downloads/m3u8/` |

   - 设置页「下载目录」逐项可改，支持 `影视/短剧` 这样的多级相对路径，右侧实时预览最终落盘位置。
   - 目录名会被逐段清洗；填了下载根内的绝对路径会换算成相对路径；`..` 越界、`<>:"|?*` 这类字符直接拒绝并说明原因。
   - **升级不会搬动老文件**：新默认值只作用于新任务。要把旧目录归拢，用元数据页的「合并为剧集」，或手动 `mv` 后重新登记来源。

2. **管理界面加了登录密码** —— 首次打开网页会要求先设置用户名与密码，之后凭它进入：

   - 登录页左侧插画 + 右侧白卡，支持「保持登录 30 天」、密码显示/隐藏、忘记密码指引。
   - 密码用 **scrypt 加盐哈希**存本机数据库（不引第三方原生依赖）；会话也落库，**重启容器、升级镜像都不用重新登录**。
   - 连续输错 5 次锁定 5 分钟；支持多设备同时在线，设置页可一键「下线其它设备」。
   - 改密码后所有旧会话立即失效，需用新密码重新登录；改用户名同理。
   - **忘记密码**：在 compose 里加 `AUTH_DISABLED: "1"` 临时启动 → 设置页重设（此时不用旧密码）→ 删掉这行重启。这是唯一出口，别把它常开。

> 1.3.1 的短剧站 403、Cloudflare 挑战、手动下载提交记录、剧集改名与跨目录合并全部保留。

---

## 功能概览

- **订阅抓取**：关键词（包含 / 完整词 / 正则）定时增量扫描，命中后按消息为单位下载，相册整组归档。
- **剧集命名 + Emby 元信息**：`《美人局》第4集` → `美人局/美人局S01E04.mp4`；多视频按原始文件名序号排序，认不出标题按正文首行建目录。落盘即写 `tvshow.nfo` + 单集 nfo + 缩略图，队列结束后可自动通知 Emby 增量扫描。
- **文件整理**：改剧集名时整部剧的文件一起改名（含 NFO 与封面）；散在不同文件夹的分集可勾选合并成一部剧，集号自动重排。
- **第三方平台**：B站 / 小红书 / YouTube，引擎为镜像内置 yt-dlp（默认每 15 天检查更新），与 Telegram 任务共用一条队列。
- **网页 / m3u8 下载**：粘网页链接或 `.m3u8` 直链，静态解析 → 试常见路径 → 无头 Chromium 渲染截获，三级兜底；能过 Cloudflare 非交互挑战，并把 Cookie 带进下载。
- **提交记录**：手动下载页保留每一次提交的链接、时间、状态与失败原因，刷新不丢。
- **队列管控**：串行下载（避免 MTProto 切 DC 断流），支持暂停 / 停止 / 继续 / 插队，实时速度与剩余时间。
- **元数据编辑与管理**：按目录聚合展示，可改 NFO、换封面、ffmpeg 截帧、框选裁剪，也能登记本地已有目录；目录树里每一级都能就地删除，可选「连磁盘文件一起删」或「仅从列表移除（可恢复）」。
- **监控历史 / 日志页**：每次扫描留痕可搜索；运行日志按级别筛选、落盘到 `data/logs/app.log`。
- **界面登录**：首次访问强制设置管理员账号，scrypt 加盐哈希落库、会话落库（重启不掉线），支持 30 天免登录与多设备下线。
- **扫码登录 / 机器人**：无需申请 api_id / api_hash，session 加密存储、重启免登录；手机上发链接即下载，也能扫描、加频道、改订阅、看队列。

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

## 登录与密码（1.3.2）

打开 `http://<服务器IP>:6789` 的第一件事就是设置管理员账号 —— **首次访问强制设置，没有跳过入口**：

```
首次打开 → 设置用户名 + 密码（≥ 8 位）→ 直接进入主界面
之后每次  → 输入同一组账号密码，可勾「保持登录（30 天）」
```

**关于这套登录**：

| 项目 | 行为 |
| --- | --- |
| 存储 | 单组账号，用户名与 scrypt 加盐哈希存在 `data/tgsub.db` 的 `settings` 表；会话哈希存在 `login_sessions` 表 |
| 有效期 | 勾「保持登录」30 天（存 cookie），不勾则是浏览器会话级；**重启容器不掉线** |
| 多设备 | 允许；设置 → 账号与安全可「下线其它设备」，或改密码一次性踢掉全部 |
| 防爆破 | 同一 IP 连续错 5 次锁 5 分钟，提示里会写还剩几次 |
| 保护范围 | 所有 `/api` 接口。`/api/health` 与登录页静态资源放行（否则容器健康检查与登录框都进不去） |

**忘记密码怎么办**（唯一出口，请务必记住）：

```yaml
# docker-compose.yml 的 environment 里临时加一行
AUTH_DISABLED: "1"
```

重启容器 → 直接进主界面（不校验密码）→ 设置 → 账号与安全 → 重设密码（此时「当前密码」可留空）→ **删掉这行再重启**。
这个开关等于把鉴权整个关掉，只用于自己家的内网应急，用完全部撤销。

> 已经有 `BASIC_AUTH_USER/PASS` 且反代层做了鉴权的话，这套登录是第二道门，两层可以同时开着。

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
| `AUTH_DISABLED` | 空 | **应急开关**：设为 `1` 关闭管理界面登录（忘记密码时用），用完必须删掉 |
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

**yt-dlp 更新**：默认每 **15 天**自动检查一次，设置页可按天改。失败按 30 分钟起翻倍退避（封顶 24 小时），不会因为一次网络抖动就反复撞 GitHub 配额。也可点「检查更新」立即下载一份到 `data/bin`。

**Cookie**（设置 → 第三方平台，加密落盘，只回摘要不发明文）。粘贴时即时解析，保存后显示「5 项 · SESSDATA / bili_jct · 2 天前」，缺关键字段会标黄。鼠标悬停平台名后的 `?` 有分步取法。

| 平台 | 关键字段 | 不填会怎样 |
| --- | --- | --- |
| B站 | `SESSDATA`（大会员还需 `bili_jct`、`DedeUserID`） | 只能拿 480P 左右，部分视频直接 412 |
| 小红书 | `web_session`、`a1` | 大概率空流或要求登录 |
| YouTube | `SID`、`SAPISID`（会员 / 年龄限制才需要） | 公开视频不填也行 |

**代理**：默认只有 YouTube 与「检查更新」走代理（设置 → 第三方平台 →「第三方平台代理」填 `http://192.168.1.2:7890`，只作用于 yt-dlp，不影响 Telegram）。
B站 / 小红书 **默认直连** —— B站 的 CDN 会把海外代理 IP 判成 `HTTP Error 567`，绕出去反而下不动。
服务器本身在海外、又要下国内平台时，勾上「国内平台也走代理」即可，但 B站 仍可能 567。

**落盘结构**（每条视频一个目录，Emby 里是独立条目）：

```
downloads/B站/UP主名字/视频标题 [BV1xx411c7mD]/
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

1. 静态抓页面 HTML，找 `<video>` / `<source>` / JS 变量里的 m3u8（内嵌地址会先还原 HTML 实体）；
2. 试常见播放器路径（`playlist.m3u8`、`index.m3u8`、`live.m3u8`、`hls.m3u8`）；
3. 静态抓取被 403 / 429 挡住、或前面都没找到，就**用无头浏览器真正渲染页面**：先等 Cloudflare 这类非交互挑战跑完（上限 60 秒），再反复点播放等播放器真正发出 m3u8 请求。这一步覆盖 SPA / 签名接口 / 人机验证的站点（短剧站、短视频站大多属于这类）。

**下载**：ffmpeg 合并成 mp4，AES-128 加密的切片会自动取 key 解密。请求头沿用浏览器的样子 —— `User-Agent`、**视频页原地址**作 `Referer`、`Origin`，以及解析时拿到的 Cookie（`cf_clearance`、登录态）。这些都会存进任务，点「重试 / 继续」时照样带着。

**线路（直连优先）**：默认**先直连**，直连不通才自动改走代理，并记住这个域名下次直接走代理。超时 / DNS 失败 / 连接拒绝这类网络错误会换线路；**403 / 429 / 5xx 也会换**（出口 IP 不同，放行结果常常不同）；404 与签名失效换也没用，直接报错。
Web 下载页与机器人 `/tasks` 每条任务都会标出「直连 / 代理 / 自动」徽章，下载中实时更新。

设置 → 网络与代理 → 「网页 / m3u8 视频下载」可改三件事：

| 项 | 说明 |
| --- | --- |
| 线路策略 | `直连优先`（默认）/ `强制走代理` / `只用直连` |
| 代理地址 | 留空则用环境变量 `M3U8_BROWSER_PROXY` / `HTTPS_PROXY`；`socks4/5/5h`、`http/https` 都支持 |

> **Cloudflare 站的注意点**：`cf_clearance` 绑定出口 IP。解析与下载必须走同一条线路 —— 代理池轮换出口 IP 的部署，这类站会时好时坏，属预期。
> SOCKS 代理会自动转成本地 HTTP 桥再喂给 ffmpeg —— ffmpeg 原生只认 `http_proxy`，且不支持 socks4。
> Docker 内置 Chromium，镜像会比 1.2.x 大一些（+约 170MB）。

**落盘结构**（下载完自动生成 nfo 与封面，Emby 可直接识别）：

```
downloads/m3u8/剧集名/剧集名.mp4
downloads/m3u8/剧集名/剧集名.nfo
```

> 解析失败时按提示用浏览器 F12 → Network → 过滤 `.m3u8` → 复制那条请求地址，直接粘成 m3u8 直链下载。

---

## 手动下载与提交记录

「手动下载」页最下面是**提交记录**，每提交一条链接就留一行：

| 记什么 | 说明 |
| --- | --- |
| 链接 | 提交时的原始链接，可点开 |
| 时间 | 一小时以内显示「刚刚 / N 分钟前」，更早显示 `11-03 20:41`，悬停看完整时间 |
| 状态 | 已入队 / 之前下过 / 没入队 / 失败 / 已取消 |
| 类型 | Telegram / B站 / 小红书 / YouTube / 网页·m3u8 |
| 摘要 | 视频标题 + 一行说明（频道·消息号·文件数 / UP主·时长·大小 / 保存目录） |
| 失败原因 | 报错原文，如「yt-dlp 退出码 1：This video is unavailable」 |

记录由服务端在真正办事的接口里写，所以关掉页面、手机提交、脚本调接口都留痕。可筛选成功 / 失败 / 未入队，可搜链接与标题；悬停某行出现「再提交」（链接填回输入框）与删除。清空时可选「只清失败与未入队」或「全部清空」—— **只删这份历史，不动下载队列和磁盘文件**。

---

## 镜像标签

| 标签 | 含义 |
| --- | --- |
| `latest` | 最新一次 `v*` 发布构建的镜像 |
| `v1.3.2` | 固定版本（**生产环境建议锁定**） |

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
| 打开网页只看到登录框，没设置过密码 | 1.3.2 起首次访问必须设账号。升级后第一次打开会出现「初始化账号」，设完即可；若已经是别人设过的账号，见下一条 |
| 忘记管理密码了 | compose 里临时加 `AUTH_DISABLED: "1"` 重启 → 设置页重设密码（不用旧密码）→ 删掉这行再重启。详见「登录与密码」 |
| 容器反复重启，`EACCES ... /data/.session-secret` | 挂载目录属主不是 1000；`chown -R 1000:1000 data downloads`，NAS 上可改 `PUID/PGID` |
| 拉镜像卡在某个百分比 | 配镜像加速器，或 `image: docker.1ms.run/rdevils7/tgsub:latest` |
| 「连接异常，延迟重连」刷屏 | 先看设置页「联网测试」：Telegram API 超时就是代理没生效 |
| 扫码后立刻掉线 | 代理不稳定或 IP 被风控；换节点，必要时走「彻底重置并重新登录」 |
| 新集没出现在 Emby | 确认「Emby 入库通知」地址 / API Key / 路径映射三项都对，点「测试连接」 |
| `yt-dlp 不可用` | 镜像低于 1.2.0 或本地开发没装；升级镜像，或在设置里手填路径 |
| `要求登录` / `风控拦截（412）` | Cookie 过期，重新复制一次；已下载的文件不受影响 |
| `连不上 YouTube` | 没配第三方平台代理，或节点不通；YouTube 还需在代理地区可用 |
| 网页视频报 `403`，一秒就失败 | 多半是 m3u8 里的签名参数被 HTML 转义写坏（`&amp;`）。1.3.1 起已自动还原；老任务点「重试」即可，无需重新粘链接 |
| 网页一直 `Just a moment...` / 抓取 403 | 站点在跑 Cloudflare 人机验证。1.3.1 起会自动开无头浏览器过挑战（15~30 秒，只在解析时慢）；**代理轮换出口 IP 会导致 Cookie 失效**，固定线路更稳 |
| 网页视频下载很慢（几十到一百 KB/s） | 对方 CDN 限速，不是卡住；看「已下载」字节是否在涨，涨就是在走 |
| 改名 / 合并后顺序不对 | 顺序按**解析出的集号**排，解析不出来的排后面按文件名自然序。执行前会出预览表，看清「旧名 → 新名」再确认 |
| 改名后 Emby 还是旧标题 | 文件名与 NFO 都改了，需要 Emby 重新识别：队列结束会自动发通知，也可在 Emby 里手动「刷新元数据」 |
| 日志 `SSL: UNEXPECTED_EOF_WHILE_READING` | 代理把长连接掐了（1.1.1 起自动重试 10 次）；仍频繁出现就换节点或避开高峰期 |
| 日志 `Postprocessing` / `Could not find tag for codec` | 音视频合并失败，1.1.1 起用 `mp4/mkv` 兜底；老任务先删掉该目录里的 `.part` / `.webm` / `.m4a` 再重试 |
| `HTTP Error 567: Unknown Status`（B站） | CDN 拒绝了下载分片：先确认没开「国内平台也走代理」（海外 IP 会被判 567），再确认 Cookie 没过期 |

更多报错与细节见 [PROJECT_DOC.md](PROJECT_DOC.md)。

---

## 安全提示

程序会以你的 Telegram 账号身份读取频道内容，请自行评估风险。管理界面自带账号密码登录（1.3.2 起），但它是给家庭 / 内网用的强度，暴露到公网前请再套一层反代 + HTTPS，必要时叠加 `BASIC_AUTH_*`。本工具不提供任何内容，仅用于归档你已有权限访问的内容。
改名 / 合并会**真实移动磁盘文件**，第一次用建议先拿一个副本目录试，确认无误再对正式库操作。

## License

[MIT](LICENSE)
