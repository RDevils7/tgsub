# tgsub

**Telegram 频道关键词订阅下载器** —— 定时扫描频道，命中关键词就把整条消息（含相册整组）的文件下载到本地，按剧集命名并生成 Emby 能直接读取的元信息。带 Web 管理界面与 Telegram 机器人遥控，也能直接粘 B站 / 小红书 / YouTube / 网页视频链接下载。

<p>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-1.3.16-2496ED.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-339933.svg">
  <img alt="Docker" src="https://img.shields.io/badge/docker-compose-2496ED.svg">
</p>

> **版本状态**：当前最新正式版 **1.3.16**（镜像 `rdevils7/tgsub:v1.3.16` 与 `latest`）。
> 本页只讲「怎么部署起来用」；全部配置项、HTTP 接口、开发自检与排错见 [PROJECT_DOC.md](PROJECT_DOC.md)。

```
频道消息 ──▶ 定时扫描 ──▶ 关键词匹配 ──▶ 下载队列 ──▶ 剧集命名 + Emby 元信息 ──▶ 本地文件 + 管理界面
```

> 面向「订阅自己已加入的频道、把内容归档到本地媒体库」的自用场景。请遵守 Telegram 服务条款与内容版权。

---

## 本版更新（1.3.16）

**一件大事：媒体库能直接播 `.strm` 链接文件了，而且全程不碰网盘风控。** 封面与 NFO 全部落本地，
播放时截一帧当封面，选中目录后自动把缺的 NFO 补齐。

1. **`.strm` 直接进媒体库**
   把播放代理签出来的 `.strm`（里面一行 http 视频直链）放进媒体目录，海报墙里和普通分集一样显示，
   点开即播。服务端流式转发：透传 `Range` / `206` / `Content-Range`、跟随 302（≤5 跳）、
   客户端断开就销毁上游连接。复用现有 `direct` 模式，所以**拖进度条、跳到指定秒、时长显示全都原生可用**，
   播放器和 `streamUrl()` 一行没改。
   > 必须服务端转发，不能前端直达：https 页面下的局域网 http 是混合内容，而且播放器的截图要
   > `canvas.drawImage`，跨域会污染画布。

2. **封面来自「正在播的那一帧」，不是服务端抽帧**
   没有封面时，播放过片头（时长 12%，夹在 3~30 秒；拿不到时长就 8 秒）自动用 canvas 截一次；
   想换就拖到目标画面（或用「跳到 00:00」精确定位）点控制条上的图片按钮覆盖。
   图片写进 strm 同级的 `<基名>-thumb.jpg`，和下载时的截帧封面同名，Emby 与海报墙直接认；
   原子写，保存后卡片与弹窗海报立即刷新。

3. **NFO：同步生成 + 选中目录后批量补齐**
   存封面时同步补一份 `<基名>.nfo`（只在不存在时写）。选中媒体目录（含「选择目录」、刷新、
   直接落在剧集目录）后，后台再自动递归扫一遍，给**所有还没有单集 NFO 的本地 strm** 补上：
   `writeFile(flag:"wx")` 排他创建，已有（含手工编辑过）的一字不改，并发 6、同目录合并、幂等。
   NFO 只按文件名推剧名 / 季 / 集，**不读 strm 正文里的直链**。

4. **风控基线：批量元数据 = 0 次网络请求**
   列表 / 详情跳过 ffprobe（连 HEAD 都不发），`/thumb` 只发本地已有的封面、**绝不抽帧**，
   strm 用 `preload=metadata`，上游 403 / 429 按主机熔断 10 分钟不重试，
   一律直连不挂 `m3u8_proxy`，**不直连 115 API**。批量补 NFO 是纯本地写盘，
   所以几千个文件也不会产生「批量刮削」特征；封面只在真正播放时才截，不额外回源。
   `.strm` 没有混进视频后缀正则，改名 / 删除 / 搬运 / 抽帧等管理链路仍只认真视频。

5. **自检 383 项**（新增 strm 解析、私有网段、封面路径、NFO 批量等 12 项），
   `test-bot` 18 项、typecheck 与 build 全绿；另起隔离实例做 28 + 20 项端到端断言，
   实测「列表与详情对上游 0 次请求，只有点播放才发请求」。

> 使用：媒体目录要对容器内的 `node(1000)` 可写，否则封面 / NFO 写不进（日志会留痕）。
> 这类直链是播放代理临时签发的短命地址，过期后需回视频页重新生成 strm。
>
> 1.3.15 的响应速度优化 / yt-dlp 精确排期 / 概览提醒可忽略 / 网页视频 403 根因修复、
> 1.3.14 的自绘播放器与 HEVC 跳秒，以及更早的相册整组、`access_hash`、评论区 ID 解析等全部保留。

---

## 功能概览

- **订阅抓取**：关键词（包含 / 完整词 / 正则）定时增量扫描，命中后按消息为单位下载，相册整组归档。
- **剧集命名 + Emby 元信息**：`《美人局》第4集` → `美人局/美人局S01E04.mp4`；落盘即写 `tvshow.nfo` + 单集 nfo + 缩略图，队列结束可自动通知 Emby 增量扫描。
- **媒体库（本地播放）**：把下载目录当片库浏览，点开即播，自绘控制条（跳秒、倍速、截图、画中画、全屏、连播）。直连的按 Range 直出，容器不兼容的用 ffmpeg 换封装，编码浏览器解不了时有显卡就硬解转码 —— 三种方式自动选路。
- **strm 链接文件**：媒体库直接播 `.strm`（服务端转发直链，支持 Range 与跳转）；播放时自动截一帧当封面、可手动挑画面覆盖；封面与单集 NFO 都落在 strm 同级，选中目录后自动批量补齐缺的 NFO，全程零批量回源。
- **文件整理**：改剧集名时整部剧的文件一起改名（含磁盘文件名、NFO 与缩略图）；散落的分集可勾选合并成一部剧、集号按自然序重排；移动视频可一键套用目标剧集命名，执行前能调顺序。
- **元数据管理**：按来源分区（Telegram / B站 / 小红书 / YouTube / m3u8 / 外部目录）展示，可改 NFO、换封面、ffmpeg 截帧裁剪；勾选后整体移动、复制、合并、批量删除，重名一律跳过不覆盖。每一级都能「隐藏」（只从列表移走、文件保留，可恢复）或「删除」（连磁盘文件一起清）。
- **第三方平台**：B站 / 小红书 / YouTube，引擎为镜像内置 yt-dlp（默认每 15 天检查更新），与 Telegram 共用一条队列。
- **网页 / m3u8**：静态解析 → 试常见路径 → 无头 Chromium 渲染截获，三级兜底；能过 Cloudflare 非交互挑战，并把 Cookie 带进下载。
- **队列与记录**：串行下载（避免 MTProto 切 DC 断流），支持暂停 / 停止 / 继续 / 插队；手动下载的每一条链接都留痕（状态、摘要、失败原因）。
- **概览 / 日志**：9 项服务状态 + 8 个工具组件（Node / ffmpeg / yt-dlp / Chromium / sharp / SQLite / GramJS / 硬件解码）的实际路径与版本，磁盘余量、分来源目录；日志按级别筛选并落盘。
- **登录与机器人**：首次访问强制设管理员账号（scrypt + 会话落库，重启不掉线）；扫码登录 Telegram，无需申请 api_id / api_hash，手机发链接即下载。

---

## 部署（Docker Compose）

镜像双架构（`linux/amd64` + `linux/arm64`），只要 Docker 20.10+ 与 compose v2，**不用 clone 仓库、不用编译**。

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
| `./downloads` | 媒体文件（视频 / 图片 / nfo / 封面），按来源分成 `telegram`、`B站`、`小红书`、`youtube`、`m3u8` 子目录 |

**NAS 注意**：面板自动创建的挂载目录属主是 `root`，容器会反复重启并报 `EACCES ... /data/.session-secret`。入口脚本会自动改成 `PUID/PGID`，若仍失败就把 `PUID/PGID` 设成 NAS 账号的 uid/gid（`id <用户名>` 查看）。
**拉取卡住**：配 Docker 镜像加速器，或临时把 `image` 改成 `docker.1ms.run/rdevils7/tgsub:latest`。

### 硬件转码（可选，带核显的 NAS 才需要）

多数 Windows / Linux 上的 Chrome 解不了 HEVC，有核显的机器可以让**显卡**实时转成 H.264，CPU 基本不烧。
N100 / N305、群晖、威联通、绿联这类带 Intel 核显的机型都支持：

```yaml
services:
  tgsub:
    # ...其余不变
    devices:
      - /dev/dri:/dev/dri
```

- **只加 `devices` 这一项就够**。设备属组由入口脚本在容器内自动加进运行用户的补充组，不需要写 `group_add`。
- **不要写 `group_add: ["video", "render"]`**：Docker 按宿主机 `/etc/group` 解析组名，群晖 / 威联通 / 绿联的组文件里只有 `video`、没有 `render`，会直接报
  `unable to find group render: no matching entries in group file`，**容器连创建都失败**（1.3.9 起已改成容器内自动处理）。
- 宿主机没有 `/dev/dri`（ARM NAS、VPS）时**不要**加这一项，否则容器会因为找不到设备起不来。
- 生效后工具栏出现「硬解 · VAAPI」，分集卡片标「显卡转码」，HEVC 点开直接看。
- 是否真的可用：概览页工具链看「硬件解码」这一项，会写设备节点或失败原因。显示「初始化失败」时，
  在 environment 里加 `LIBVA_DRIVER_NAME: iHD` 再重启（强行指定 Intel 驱动）。
- 工具栏的「HEVC 直连」默认按浏览器能力决定：Safari 这类能自解的会直接播、不占显卡；Chrome 这类解不了的自动转码。
- 拖动转码视频的进度条（或在播放器里填「跳到 00:00」）等于从新位置重开一段流，等 1~3 秒；这是实时流的固有代价。

---

## 第一次打开：设账号 + 五步配置

打开 `http://<服务器IP>:6789` 的第一件事是**设置管理员账号**（用户名 + ≥8 位密码，没有跳过入口），
之后每次登录可勾「保持登录（30 天）」。账号密码与会话哈希都存在 `data/tgsub.db`，**重启容器不掉线**；
同一 IP 连续错 5 次锁 5 分钟；设置 → 账号与安全可下线其它设备。

**忘记密码**（唯一出口）：compose 的 environment 里临时加一行 `AUTH_DISABLED: "1"` → 重启 → 直接进主界面
→ 设置 → 账号与安全 → 重设密码（「当前密码」留空）→ **删掉这行再重启**。这个开关等于关掉整个鉴权，用完必须撤销。

登录之后的顺序：

1. **配代理** —— 设置 → 网络与代理，填 SOCKS4 / SOCKS5 / HTTP / HTTPS，点「联网测试」确认能连通 Telegram API。
2. **扫码登录** —— 设置 → Telegram 账号 → 扫码（手机 Telegram → 设置 → 设备 → 链接桌面设备）。
3. **加频道** —— 频道页粘 `@channel` 或 `t.me` 链接；私有频道用 `t.me/c/<内部ID>/<消息ID>`。
4. **建订阅** —— 填关键词、选匹配方式与生效频道。
5. **等扫描** —— 默认 15 分钟一次，也可在概览页点「立即扫描」。

> 代理地址别填 `127.0.0.1`：容器里的 `127.0.0.1` 是容器自己。访问宿主机代理用 `host.docker.internal:7890`
> （Linux 还要加 `extra_hosts: ["host.docker.internal:host-gateway"]`）或局域网 IP。

---

## 常用配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `6789` | 监听端口 |
| `DATA_DIR` / `DOWNLOAD_DIR` | `./data` / `$DATA_DIR/downloads` | 数据与下载目录；Docker 里是 `/data`、`/downloads` |
| `SESSION_SECRET` | 自动生成 | 加密 Telegram session 的密钥（≥16 位）。**设了就别改**，否则要重新扫码 |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | 空 | 同时设置即开 HTTP Basic 认证，配合反代暴露公网时用 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `AUTH_DISABLED` | 空 | **应急开关**：`1` 关闭管理界面登录（忘记密码时用），用完必须删掉 |
| `HW_ACCEL` | 自动探测 | `vaapi` / `qsv` / `software` / `none`，强制指定硬件转码方式 |
| `TZ` | `Asia/Shanghai` | 时区，影响日志与按天分目录 |
| `M3U8_BROWSER_PROXY` | 空 | 网页 / m3u8 的备用代理。默认先直连，不通才用它；未设时回落 `HTTPS_PROXY` / `HTTP_PROXY`（`127.0.0.1` 会被忽略）。界面设置项优先级更高 |

界面里的设置（扫描间隔、路径模板、画质、Cookie、机器人开关等）存数据库，改完即生效，不用重启。

---

## 第三方平台（B站 / 小红书 / YouTube）

设置 → 第三方平台 → 打开开关，然后到「手动下载」页粘链接；**短链与整段分享口令**都能直接粘，发给机器人也行（一次最多 5 条）。
清晰度默认「最高（原画）」；1080P 以上要大会员 / 登录态。yt-dlp 默认每 **15 天**自动检查更新，失败按 30 分钟起翻倍退避。

Cookie 在设置页粘贴（加密落盘，只回摘要不发明文，粘贴时即时解析、缺关键字段标黄）：

| 平台 | 关键字段 | 不填会怎样 |
| --- | --- | --- |
| B站 | `SESSDATA`（大会员还需 `bili_jct`、`DedeUserID`） | 只能拿 480P 左右，部分视频直接 412 |
| 小红书 | `web_session`、`a1` | 大概率空流或要求登录 |
| YouTube | `SID`、`SAPISID`（会员 / 年龄限制才需要） | 公开视频不填也行 |

**代理只作用于 yt-dlp**：默认 YouTube 与「检查更新」走代理；B站 / 小红书默认直连 —— B站 的 CDN 会把海外代理 IP 判成
`HTTP Error 567`，绕出去反而下不动。服务器在海外又要下国内平台时，才勾「国内平台也走代理」。

落盘结构（每条视频一个目录，Emby 里是独立条目）：

```
downloads/B站/UP主名字/视频标题 [BV1xx411c7mD]/
    视频标题 [BV1xx411c7mD].mp4         ← 编码不兼容 mp4 时自动是 .mkv，Emby 一样能读
    视频标题 [BV1xx411c7mD].nfo         ← 标题 / 简介 / UP主 / 分区 / 日期
    视频标题 [BV1xx411c7mD]-thumb.jpg   tvshow.nfo  poster.jpg  landscape.jpg  fanart.jpg
```

> Emby 媒体库要勾「优先使用本地元数据 / 启用 NFO」，否则它会先联网刮削再读 nfo，把上面这些字段盖掉。

---

## 网页 / m3u8 视频

「手动下载」页可直接粘普通网页链接或 `.m3u8` 直链。解析逐级兜底：

1. 静态抓 HTML，找 `<video>` / `<source>` / JS 变量里的 m3u8（内嵌地址先还原 HTML 实体）；
2. 试常见播放器路径（`playlist.m3u8`、`index.m3u8`、`live.m3u8`、`hls.m3u8`）；
3. 被 403 / 429 挡住或都没有，就用**无头浏览器真正渲染页面** —— 先等 Cloudflare 这类非交互挑战跑完（上限 60 秒），再反复点播放直到截获 m3u8 请求。短剧站 / 短视频站基本靠这一步。

下载由 ffmpeg 合并成 mp4，AES-128 切片自动取 key 解密；请求头沿用浏览器（UA、视频页原地址作 Referer、Origin、解析时的 Cookie），
点「重试 / 继续」时照样带着。

**线路默认直连优先**：正式下载时直连失败一律再试一次代理（用户取消 / 地址丢失除外），403 / 签名失效也换 ——
出口 IP 不同，放行结果常常不同；解析阶段会记下走通的线路，**下载与 403 重解析都优先沿用同一条线路**。
设置 → 网络与代理可改「直连优先 / 强制代理 / 只用直连」。

> `cf_clearance` 与 `auth_key` 绑定出口 IP：代理池轮换 IP 的部署这类站会时好时坏，属预期。
> 静态抓页面下发的 `Set-Cookie`、浏览器拿到的 `cf_clearance` 都会一起交给 ffmpeg。
> SOCKS 会先转成本地 HTTP 桥再交给 ffmpeg（ffmpeg 只认 `http_proxy`，也不支持 socks4）。

> 上面的代理规则只管「手动下载网页 / m3u8」。媒体库播 `.strm` 是另一条转发链路：
> 目标通常是局域网播放代理，**一律直连**，不套用这里的代理设置。

---

## 镜像标签

| 标签 | 含义 |
| --- | --- |
| `latest` | 最新一次 `v*` 发布的镜像 |
| `v1.3.16` | 固定版本（**生产环境建议锁定**） |

只有这两个标签：push 到 `main` 只跑构建与冒烟测试（健康检查、两个挂载目录可写、NAS 属主场景、内置 ffmpeg），
**不发布镜像**；打 tag 才构建 amd64 + arm64 并推送。

---

## 升级与备份

```bash
docker compose pull && docker compose up -d   # 升级，数据保留
docker compose restart                        # 优雅重启（先断 Telegram 再退出）
docker compose down                           # 停止，./data 与 ./downloads 不动
```

- **备份**：打包 `./data` 即可恢复全部配置与记录（先 `docker compose stop` 让 SQLite WAL 落盘）；媒体文件在 `./downloads`。
  恢复时保持 `SESSION_SECRET` 不变，否则要重新扫码。
- **1.0.4 之前升级**：下载文件曾在 `./data/downloads`，先 `mv data/downloads/* downloads/` 再 `rmdir data/downloads`。
- 查运行版本：`curl -s http://<IP>:6789/api/health`。

---

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 打开只看到登录框 | 1.3.2 起首次访问必须设账号，出现「初始化账号」就设一个 |
| 忘记管理密码 | compose 里临时加 `AUTH_DISABLED: "1"` 重启 → 重设密码 → 删掉这行再重启 |
| 容器反复重启，`EACCES ... /data/.session-secret` | 挂载目录属主不是 1000：`chown -R 1000:1000 data downloads`，NAS 上改 `PUID/PGID` |
| 拉镜像卡在某个百分比 | 配镜像加速器，或 `image: docker.1ms.run/rdevils7/tgsub:latest` |
| 「连接异常，延迟重连」刷屏 | 设置页点「联网测试」：Telegram API 超时就是代理没生效 |
| 扫码后立刻掉线 | 代理不稳或 IP 被风控；换节点，必要时「彻底重置并重新登录」 |
| 新集没出现在 Emby | 检查「Emby 入库通知」的地址 / API Key / 路径映射，点「测试连接」 |
| `yt-dlp 不可用` | 镜像低于 1.2.0 或本地开发没装；升级镜像或在设置里手填路径 |
| `要求登录` / `风控拦截（412）` | Cookie 过期，重新复制一次；已下载的文件不受影响 |
| 评论区链接报「没有开启评论 / 不在讨论组里」 | 1.3.10 起会依次试 6 条路定位讨论组（先读频道的 linked_chat_id）；仍失败时会写明是「帖子确实没开评论」还是「私密讨论组 + 账号不在群里」（后者只能先用同一账号加群） |
| `连不上 YouTube` | 没配第三方平台代理，或节点在该地区不可用 |
| 网页视频报 `403`，一秒就失败 | 多半是老任务里 `&amp;` 把签名写坏；1.3.1 起已自动还原，点「重试」即可 |
| 一直 `Just a moment...` / 抓取 403 | 站点在跑 Cloudflare 人机验证，会自动开无头浏览器过挑战（15~30 秒）；代理轮换 IP 会让 Cookie 失效 |
| `HTTP Error 567`（B站） | 关掉「国内平台也走代理」（海外 IP 会被判 567），再确认 Cookie 没过期 |
| 媒体库 HEVC 标「播不了」/ 点了黑屏 | 有核显：按「部署 → 硬件转码」加 `devices` 并重启；没有核显：打开「HEVC 直连」用 Safari / Edge 播 |
| 显示「无硬解」、概览里「硬件解码」是红的 | 没映射 `/dev/dri`、或宿主机没装 Intel 驱动；概览里那行会写具体原因 |
| 创建容器报 `unable to find group render` | compose 里写了 `group_add: ["video","render"]`，而 NAS 的组文件没有 `render` 组。**删掉整段 group_add**，只留 `devices: ["/dev/dri:/dev/dri"]`（1.3.9 起属组由容器内自动处理） |
| 容器是 running 但网页打不开 | ① `docker port tgsub` 看有没有 `6789/tcp -> 0.0.0.0:6789`；② `docker exec tgsub node -e "fetch('http://127.0.0.1:6789/api/health').then(r=>r.text()).then(console.log)"`，有 JSON 返回说明服务正常，问题在端口映射 / NAS 防火墙 / 反向代理（镜像里没有 curl / wget，只能用 node）；③ 访问 `http://NAS地址:6789`（不是 https），换浏览器无痕窗口再试 |
| 改名 / 合并后顺序不对 | 顺序按解析出的集号排，解析不出的垫后按文件名自然序；执行前有「旧名 → 新名」预览 |

更多报错与细节见 [PROJECT_DOC.md](PROJECT_DOC.md)。

---

## 安全提示

程序以你的 Telegram 账号身份读取频道内容，请自行评估风险。管理界面自带账号密码登录，但那是家庭 / 内网强度：
暴露公网前请套一层反代 + HTTPS，必要时叠加 `BASIC_AUTH_*`。改名 / 合并会**真实移动磁盘文件**，第一次建议拿副本目录试。
本工具不提供任何内容，仅用于归档你已有权限访问的内容。

## License

[MIT](LICENSE)
