# tgsub

**Telegram 频道关键词订阅下载器** —— 定时扫描指定频道，命中关键词后把整条消息（含相册整组）的文件自动下载到本地，按剧集命名并生成 Emby 可直接读取的元信息。自带 Web 管理界面与 Telegram 机器人遥控。

<p>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520%20(%E6%8E%A8%E8%8D%9022)-339933.svg">
  <img alt="Docker" src="https://img.shields.io/badge/docker-compose-2496ED.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.x-3178C6.svg">
</p>

```
频道消息 ──▶ 定时扫描 ──▶ 关键词匹配 ──▶ 下载队列 ──▶ 剧集命名 + Emby 元信息 ──▶ 本地文件 + 管理界面
```

> 面向「订阅自己已加入的频道、把内容归档到本地媒体库」的自用场景。请遵守 Telegram 服务条款与内容版权。

📖 **完整文档**：功能细节、配置项、HTTP 接口、开发自检、常见问题 → [PROJECT_DOC.md](PROJECT_DOC.md)

---

## 功能概览

- **订阅与抓取**：多关键词订阅（包含 / 完整词 / 正则），定时增量扫描频道；命中后按「消息」为单位下载，相册整组一起归档。
- **剧集命名**：剧名与集数从正文和原始文件名两处识别，`《美人局》第4集` → `美人局/美人局S01E04.mp4`，`妈妈我爱你 EP1-10` 的相册逐集编成 `S01E01` ~ `S01E10`；一个链接里多个视频时按原始文件名里的序号（`01.mp4`、`2 - 片段.mp4`）排先后，不按消息顺序；认不出标题的按正文首行建文件夹，文件夹与文件同名。
- **Emby 元信息**：落盘即写出 `tvshow.nfo` + 单集 nfo 与每集缩略图；剧集目录的竖版海报 / 横版图 / 背景图统一取自第一集，全部由 ffmpeg 从视频随机截帧生成（消息里的图片不再下载）。
- **队列管控**：串行下载（避免 MTProto 切 DC 打断文件），每条任务支持暂停 / 停止 / 继续 / 插队，实时显示速度与剩余时间。
- **第三方平台**：B站 / 抖音 / 小红书 / YouTube 链接也能下（引擎 yt-dlp，镜像内置、可自动更新），粘贴到「手动下载」页即可；各平台 Cookie 在设置里填，加密保存、状态可见。下载完成后同样写 nfo、截帧封面并通知 Emby。
- **元数据编辑页**：按文件夹聚合展示剧集，可手动改 NFO、换封面、ffmpeg 截帧、框选裁剪；也支持登记服务器上的本地视频目录。
- **监控历史**：每次扫描看过的消息全部留痕，可按状态筛选、全文搜索，用来排查「为什么这条没下载」。
- **日志页面**：内置运行日志页，可按级别筛选、关键词搜索、自动刷新、下载归档；服务日志同时落盘到 `data/logs/app.log`。
- **扫码登录**：手机扫二维码即可，**无需申请 api_id / api_hash**；session 加密落盘，重启不用重登。登录失效时可在设置页一键「彻底重置并重新登录」。
- **Telegram 机器人**：手机上发消息就能扫描、加频道、改订阅、看队列、按链接下载。

---

## 快速部署（Docker Compose）

**无需 clone 仓库、无需在服务器上编译** —— 直接从 Docker Hub 拉取已构建好的镜像：

```
rdevils7/tgsub:latest
```

镜像为 `linux/amd64` 与 `linux/arm64` 双架构，服务器上只要有 Docker 20.10+ 与 docker compose v2 即可。

> 备用仓库是 GitHub Container Registry：`ghcr.io/rdevils7/tgsub:latest`。
> 两者内容完全一致，**国内优先用 Docker Hub**，拉不动再换 GHCR。

### 1. 准备目录

```bash
mkdir -p tgsub && cd tgsub
mkdir -p data downloads
# 容器内以 node(1000) 用户运行，宿主机目录属主必须是 1000:1000，否则写入失败
sudo chown -R 1000:1000 data downloads
```

两个目录的作用：

| 宿主机目录 | 容器内路径 | 存放内容 |
| --- | --- | --- |
| `./data` | `/data` | **数据持久化目录**：SQLite 数据库、加密后的 Telegram session、会话密钥、封面缓存、运行日志 |
| `./downloads` | `/downloads` | **下载目录**：实际的视频 / 图片 / nfo / 封面，按剧集归档。体积大，可单独挂到另一块大容量盘 |

### 2. 准备 compose 文件

新建一个 `docker-compose.yml`（放在刚才的 `tgsub/` 目录里），内容如下：

```yaml
services:
  tgsub:
    image: rdevils7/tgsub:latest
    container_name: tgsub
    restart: unless-stopped
    ports:
      # 宿主机端口 → 容器端口
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
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    deploy:
      resources:
        limits:
          memory: 1G
```

> 不要加 `init: true` —— 镜像的 ENTRYPOINT 已经用 tini 做 PID 1，再叠加一层会出现
> 「Tini is not running as PID 1」警告。

整个部署过程**只需要这一个文件**，不需要 clone 仓库、不需要在本机编译、也不需要访问 GitHub 源码。
文件里全部是真实值（不做变量插值），要改镜像版本、端口或目录，直接编辑对应那一行即可。

（若网络能访问 raw.githubusercontent.com，也可以直接下载仓库里的同一份文件：
`curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/RDevils7/tgsub/main/docker-compose.yml`）

### 3. 按需修改配置

compose 文件里全部是真实值，**直接编辑对应那一行**即可：

| 要改什么 | 改哪一行 |
| --- | --- |
| 换镜像版本 | `image:` → `rdevils7/tgsub:v1.0.6` |
| 换宿主机端口 | `ports:` → `- "8080:6789"` |
| 换数据目录 | `volumes:` 第一条 → `- /opt/tgsub/data:/data` |
| 换下载目录 | `volumes:` 第二条 → `- /mnt/nas/tgsub:/downloads` |
| 改时区 / 日志级别 | `environment:` 里的 `TZ:` / `LOG_LEVEL:` |
| 改容器内运行用户 | `environment:` 里的 `PUID:` / `PGID:` |
| 开启基础认证 | `environment:` 里的 `BASIC_AUTH_USER:` / `BASIC_AUTH_PASS:` |
| 固定 session 密钥 | `environment:` 里的 `SESSION_SECRET:`（≥16 位） |

> `SESSION_SECRET` 留空（或不足 16 位）时，程序会在数据目录自动生成 `/data/.session-secret` 并一直复用；
> 手动设置需 ≥16 位。**一旦设定就不要改** —— 改了数据库里的 session 解不开，得重新扫码。

### 4. NAS 部署（群晖 / 威联通 / 绿联 / 铁威马等）

NAS 的 Docker 面板和普通服务器有个关键差别：**面板自动创建的挂载目录属主是 `root`**，
而容器内应用以 `node`(1000) 运行，写不进去 —— 典型症状是容器反复重启，日志里刷：

```
Error: EACCES: permission denied, open '/data/.session-secret'
```

**本镜像已经处理了这个问题**：入口脚本在容器启动时会自动把 `/data`、`/downloads`
的属主改成 `PUID`/`PGID` 对应的用户，然后降权运行。正常情况下**不需要任何手工操作**。

如果面板限制了权限修正（日志里出现「无法修改 … 的属主」），按下面顺序处理：

| 场景 | 做法 |
| --- | --- |
| SSH 能登录 | `sudo chown -R 1000:1000 <宿主机 data 目录> <宿主机 downloads 目录>` |
| 挂载目录属主是别的账号 | SSH 执行 `id <用户名>` 拿到 uid/gid，改 compose 里的 `PUID:` / `PGID:` |
| 目录来自 SMB/CIFS 共享 | 共享的权限由 NAS 账号决定，把 `PUID`/`PGID` 设成该账号的 uid/gid |
| 完全没有 SSH | 在面板里把挂载目录的属主改成「管理账号」，并让 `PUID`/`PGID` 与之一致 |

> `PUID`/`PGID` 就是「容器内用哪个账号读写文件」。默认 `1000:1000`（镜像里的 `node` 用户）。
> 改成 NAS 上你自己的账号 uid/gid，下载的视频在你 NAS 的文件管理器里就直接属于你的账号了。

#### 只有个别剧集报 `EACCES ... open '/downloads/xx/xx.nfo'`？

**不是下载失败** —— 视频已经落盘了，只是这一集的 `.nfo` / 封面没写进去，Emby 里会缺标题和集数。

原因是那个剧集目录是历史遗留：入口脚本为了不拖慢启动（下载目录可能有几百 GB），
默认只把 `/downloads` **顶层**目录的属主改成 `PUID`/`PGID`，里面的老目录还是上个版本
以 `root` 创建时的属主。当前进程以 `PUID` 运行，就写不进这些老目录；
新下载的剧集目录由当前用户创建，所以只有老条目会中招。

修一次即可（二选一）：

```yaml
# compose 里加一行，重启后递归修正整个下载目录（目录很大时会慢一些）
environment:
  CHOWN_RECURSE: "1"
```

```bash
# 或者只修那一部剧，不用碰整个下载目录
sudo chown -R 1000:1000 <宿主机 downloads 目录>/<剧名目录>
```

改完重跑该条目就能补上 `.nfo`，**不用重新下载**。

> 1.0.4 起这类失败的日志会直接写明「视频已落盘」、目录属主与修复命令；
> 若目录属主就是当前用户、只是权限位被改成了只读（0555），程序会自动补上写权限并重试一次。

#### 拉取镜像卡在某个百分比不动？

`docker compose pull` 卡在 `78.55MB / 78.57MB` 这类「差一点点就完成」的位置，
或者进度条十几分钟不动，是**镜像站回源失败或限速**导致的，不是镜像有问题 ——
那一层传到 99% 时连接被切断，Docker 会从头重传，于是永远出不来。

> 根本原因：国内网络到 `registry-1.docker.io` / `production.cloudflare.docker.com`
> 的 DNS 解析经常被污染，指向无法完成 TLS 握手的 IP，导致大层拉取直接挂死。
> 这台镜像 122.63MB / 14 层，其中 L2 (47.57MB) 与 L7 (42.51MB) 两层占了 90MB，
> 卡住几乎都发生在这两层上。

按下面顺序处理，**推荐先用方案 A**：

##### 方案 A：给 Docker 配镜像加速器（改一次，永久生效）

Docker Hub 的镜像会被加速器代理，拉取速度提升明显。

| NAS 品牌 | 操作路径 |
| --- | --- |
| 群晖 | Container Manager → 注册表 → 右上「设置」→ 新增 → 填 `https://docker.1ms.run` → 勾选启用 |
| 威联通 | Container Station → 设置 → Docker Hub → 镜像仓库 → 添加 `https://docker.1ms.run` |
| 绿联 | Docker → 设置 → 镜像源 → 添加 `https://docker.1ms.run` |
| 飞牛 | Docker 管理器 → 镜像源 → 添加 `https://docker.1ms.run` |
| 极空间 | Docker → 高级模式 → 设置 → 镜像加速 → 填 `https://docker.1ms.run` |

**群晖 / Linux 通用（SSH）**：

```bash
# 群晖
sudo vi /var/packages/ContainerManager/etc/dockerd.json
# 其他 Linux NAS
sudo vi /etc/docker/daemon.json
```

写入（注意逗号，文件里已有其他字段时要合并）：

```json
{
  "registry-mirrors": ["https://docker.1ms.run", "https://docker.1panel.live"]
}
```

然后重启 Docker：

```bash
sudo synoservicectl --restart pkgctl-ContainerManager   # 群晖
sudo systemctl restart docker                           # 其他
```

验证是否生效：

```bash
docker info | grep -A2 "Registry Mirrors"
```

##### 方案 B：compose 里直接加加速器前缀

不改 NAS 全局设置，只改这一个项目。在 `docker-compose.yml` 的 `image:` 前面加前缀：

```yaml
image: docker.1ms.run/rdevils7/tgsub:latest
```

> 注意：这样拉下来的镜像在 NAS 上会带 `docker.1ms.run/` 前缀，
> `docker images` 里看到的是 `docker.1ms.run/rdevils7/tgsub:latest`。
> 功能完全一样，只是本地镜像名不同。

##### 方案 C：换仓库

把 compose 的 `image:` 改成 `ghcr.io/rdevils7/tgsub:latest` 再试。

##### 方案 D：完全离线导入（网络实在不行时）

在能连上 Docker Hub 的电脑上把镜像导出成 tar，再传到 NAS 导入：

```bash
# 有 Docker 的电脑
docker pull rdevils7/tgsub:latest
docker save rdevils7/tgsub:latest -o tgsub-amd64.tar
# 传到 NAS 后
docker load -i tgsub-amd64.tar
```

> 仓库根目录已备好现成的离线归档（标准 `docker save` 格式，14 层全部通过 sha256 校验）：
>
> | 文件 | 架构 | 大小 | 适用机型 |
> | --- | --- | --- | --- |
> | `tgsub-amd64-docker-archive.tar.gz` | amd64 | 120.49MB | 群晖 / 威联通 Intel、AMD 机型 |
> | `tgsub-arm64-docker-archive.tar.gz` | arm64 | 112.99MB | ARM 机型（部分绿联、极空间、飞牛） |
>
> 无需自备 Docker，NAS 上直接导入：
>
> ```bash
> # 传到 NAS 后（二选一）
> gunzip -c tgsub-amd64-docker-archive.tar.gz | docker load
> # 或先压成 .tar 再导入（部分旧版 Docker 不认 .tar.gz）
> gunzip tgsub-amd64-docker-archive.tar.gz && docker load -i tgsub-amd64-docker-archive.tar
> ```
>
> 导入后本地镜像名是 `rdevils7/tgsub:latest`，compose 不用改。
> 不知道 NAS 是哪种架构？在 NAS 上执行 `uname -m`，
> 输出 `x86_64` 用 amd64，输出 `aarch64` 用 arm64。

##### 其他补充手段

| 做法 | 说明 |
| --- | --- |
| 手动分步拉取 | `docker pull rdevils7/tgsub:latest` 观察卡在哪一层，再 `docker compose up -d` |
| 多拉几次 | 限速是随机的，重试往往能挤进去 |
| 调高超时 | `/etc/docker/daemon.json` 里加 `"max-concurrent-downloads": 3`，避免多路并发互相挤带宽 |

> 镜像体积已从 151MB 优化到约 122MB（剥离了 ffprobe 静态二进制，
> 单层从 71MB 降到约 42MB），卡住的概率和等待时间都明显下降。

### 5. 启动

```bash
docker compose up -d
docker compose logs -f --tail=200
```

启动后访问 `http://<服务器IP>:6789`，进入「设置 → Telegram 账号 → 扫码登录」用手机扫码即可。

> **代理**：国内网络直连不上 Telegram，请先在「设置 → API 凭证与网络」填代理地址。
> 容器里的 `127.0.0.1` 是容器自己，访问宿主机代理要用 `host.docker.internal:7890`
> （Linux 需在 compose 中加 `extra_hosts: ["host.docker.internal:host-gateway"]`）或局域网 IP。

### 从旧版本升级

早期版本只有一个持久化目录，下载文件落在 `./data/downloads`。新版把数据与下载分开：

```bash
docker compose down
mkdir -p downloads
mv data/downloads/* downloads/ 2>/dev/null   # 有文件才需要执行
rmdir data/downloads 2>/dev/null
docker compose pull && docker compose up -d
```

- `./data` 里的数据库、加密 session、设置**原地保留**，不用动 —— 升级后订阅、历史记录都还在。
- `SESSION_SECRET` / `.session-secret` **不要改**，改了数据库里的 session 解不开，得重新扫码。
- 旧容器以 root 跑过的话，`./data` 里会留下 root 属主的文件；新版入口脚本启动时会递归修正
  `/data` 的属主，正常不用手动处理。

### 运维命令

```bash
docker compose pull                 # 拉取最新镜像
docker compose up -d                # 用新镜像重建容器（数据保留）
docker compose logs -f --tail=200   # 看日志
docker compose restart              # 优雅重启（会先断开 Telegram 再退出）
docker compose down                 # 停止容器，数据保留在 ./data 与 ./downloads
```

### 可用镜像标签

镜像同时发布到 **Docker Hub** 与 **GitHub Container Registry**，两个仓库的标签完全一致：

| 仓库 | 镜像地址 |
| --- | --- |
| Docker Hub（推荐） | `rdevils7/tgsub:latest` |
| GHCR（备用） | `ghcr.io/rdevils7/tgsub:latest` |

| 标签 | 含义 |
| --- | --- |
| `latest` | 最新一次 `v*` 发布构建的镜像 |
| `v1.0.6` | 打标签时的固定版本（**生产环境建议锁定**） |

> **只有这两个标签。** push 到 `main` 只跑构建与冒烟测试、不发布镜像，
> 所以仓库里不会再出现 `main`、`sha-<40位>`、`1.0`、`1.0.4` 这类派生标签。

```bash
# 锁定版本部署：把 compose 里 image: 一行改成 rdevils7/tgsub:v1.0.6
docker compose up -d
```

### 版本记录

| 版本 | 主要变更 |
| --- | --- |
| `1.0.6` | **支持 YouTube**：链接识别加入 `youtube.com` / `youtu.be` / `shorts` / `embed`，与 B站 等平台共用队列与 Emby 收尾；新增**第三方平台代理**（只给 yt-dlp 用，与 Telegram 代理分开，YouTube 与检查更新必须走它）。**yt-dlp 自更新**：设置页显示当前版本、最新版本、上次检查时间与来源（镜像内置 / 自动更新版 / 手动指定），可设「每 N 小时检查一次」，发现新版自动下载到 `data/bin` 并切过去（旧版本保留为 `.bak`，新文件跑 `--version` 验证通过才替换），也可点「检查更新」立即执行并显示下载进度。**Cookie 状态可见**：保存后显示「6 项 · SESSDATA / bili_jct · 2 天前」，缺关键项（如 B站没 `SESSDATA`）标黄提示；输入时即时解析，边贴边看认出了几项。**分享口令直接粘**：B站 `<https://b23.tv/…>`、抖音「复制打开抖音…」、小红书 `xhslink.cn` 整段粘贴即可，机器人收到同样开始下载；**默认画质改为最高（原画）**（老库自动迁移）；每个平台名后加 `?`，悬停显示分步 Cookie 获取说明 |
| `1.0.5` | **B站 / 抖音 / 小红书 下载**：新增第三方平台支持，引擎是镜像内置的 yt-dlp，在「手动下载」页粘贴链接即可（短链 `b23.tv` / `v.douyin.com` / `xhslink.com` 也能识别），与 Telegram 任务共用队列、暂停/停止/重试、进度与 Emby 收尾。设置页新增「第三方平台」卡片：总开关、清晰度上限、存放子目录、是否写 nfo 与截帧封面、yt-dlp 路径与版本检测；**三个平台的 Cookie 加密保存**（与 session 同级，接口只回「已保存 · 2 项，首项 SESSDATA」）。落盘结构 `第三方/<平台>/<作者>/<标题> [ID]/`，下载完成后自动回填真实文件名（yt-dlp 可能输出 mkv/webm） |
| `1.0.4` | 设置页整合与网络诊断：**Emby 入库通知并入设置页**（不再单独占一个导航）；**网络与代理独立成区**，协议可选 SOCKS4 / SOCKS5 / SOCKS5H / HTTP / HTTPS，带「联网测试」按钮（Telegram API、Google、GitHub、百度四个站点，显示状态码与延迟）；**ffmpeg 显示实际路径、来源与版本**（内置包 / 环境变量 / PATH / 手填，附 ffprobe 是否可用）；**机器人新增「测试 Token」**（走 Bot API 的 getMe，与 MTProto 分开诊断）；API 凭证挪到设置页最底部；**缓存清理**：设置页新增「缓存清理」卡片，实时显示 `data/covers`（消息封面预览）与 `data/frames`（截帧候选）的占用与文件数，可设上限自动清理最旧的那批，也可一键清空 |
| `1.0.3` | **Emby 入库通知**：新增「Emby 入库」页，下载完成后自动把文件路径提交给 Emby 的 `/Library/Media/Updated` 接口，Emby 立刻做增量扫描，新集几十秒内出现在媒体库里；支持独立地址 / API Key（加密落盘）/ 路径映射（容器路径 ↔ Emby 路径）、连接测试、全库扫描兜底与入库记录；连下多集自动合批、失败重试一次，通知失败不影响下载。**封面改为「从视频随机截帧」**：每集生成自己的 `<剧名S01E04>-thumb.jpg`，剧集目录的 poster / landscape / fanart 统一取自第一集，消息里的图片不再下载（队列里遗留的旧封面图任务自动作废）。**日志补充上下文**：下载完成 / 失败 / 暂停 / 跳过等信息直接写明剧名、集号、相对路径与文件大小，并带上 messageId、频道名等字段。**多视频按原文件名排序**：一个链接里有多个视频时，集号按原始文件名里的序号（`01.mp4`、`2 - 片段.mp4`）排先后，不再按消息顺序；正文没写集数时序号直接当集号，并支持中文数字集数（`第一集`、`第十二集`） |
| `1.0.2` | 修复「连接异常，延迟重连」每 66 秒刷屏：gramjs 的 `PingDelayDisconnect` 在代理环境下收不到 Pong 会误判断线，现改为以真实 `getMe` 心跳判定连接活性，心跳正常时忽略 ping 误判（真断线时告警照常保留）；重连退避重置窗口 180s → 45s，连接稳定后延迟回到 4 秒；日志页直接显示 `strikes`/`delayMs` 并在连续掉线时给出排查方向；机器人「未启用 · Token 已保存」状态区分 |
| `1.0.1` | 内置凭证默认值由 Telegram Desktop 官方客户端（`api_id=2040`）换成 **tdl 自建应用（15055931）**，老库自动迁移；新增**重登闸门**（1 分钟冷却 + 24h 5 次上限）；登录后延迟 10 秒再独立验证，避免新 authKey 双连接被判作废；失效原因识别为风控类时直接给出申诉指引；扫描分页与频道间加随机抖动；设置页底部显示版本号 |
| `1.0.0` | 首个版本：扫码登录、频道扫描、关键词订阅、媒体下载、Emby NFO + 封面、Telegram 机器人控制台、日志页 |

```bash
# 查看当前运行的版本
curl -s http://<NAS-IP>:6789/api/health
# {"ok":true,"uptime":123,"telegram":true,"version":"1.0.5"}
```

> 镜像仓库是公开的，任何人都能 `docker pull`。若你的 fork 需保持私有，
> 去 GitHub 仓库 `Settings → Packages` 改为 Private，拉取前先
> `docker login ghcr.io -u <用户名>`（密码用 PAT，勾选 `read:packages`）。

### 不用 compose？

```bash
docker pull rdevils7/tgsub:latest
docker run -d --name tgsub -p 6789:6789 \
  -v "$(pwd)/data:/data" -v "$(pwd)/downloads:/downloads" \
  -e DATA_DIR=/data -e DOWNLOAD_DIR=/downloads -e TZ=Asia/Shanghai \
  --restart unless-stopped rdevils7/tgsub:latest
```

### 其他部署方式

需要改代码或本地开发时，见 [PROJECT_DOC.md](PROJECT_DOC.md) 的「快速开始」章节（含本地构建镜像、本地运行）。

### 镜像是怎么发布到 Docker Hub 的？

CI（`.github/workflows/docker.yml`）在 `main` 分支推送后自动构建并推送，**不需要手动操作**。
想在 Docker Hub 网页上看到镜像，只需先配置两个 GitHub Secret：

| Secret 名 | 值 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub 用户名（小写），例如 `rdevils7` |
| `DOCKERHUB_TOKEN` | Docker Hub 的 **Access Token**（不是账号密码） |

配置步骤：

1. 登录 [hub.docker.com](https://hub.docker.com/) → 右上角头像 → **Account settings**
2. 左侧 **Personal access tokens** → **Generate new token**
3. `AccessToken` 权限勾选 **Read & Write**（只读也能拉，但推不了）
4. 复制生成的 token（形如 `dckr_pat_...`，**只显示一次**）
5. 打开 GitHub 仓库 `RDevils7/tgsub` → **Settings → Secrets and variables → Actions**
6. 点 **New repository secret**，分别添加上面两个 Secret
7. 回到仓库点 **Actions** → 手动触发一次 `Docker 镜像` 工作流

之后每次推送 `main` 都会自动同步到 Docker Hub，标签与 GHCR 完全一致。

> 没配 Secret 也不会报错 —— CI 会只发布到 GHCR 并打一条提示日志。

---

## 首次配置

1. **配代理** —— 「设置 → 网络与代理」填代理地址（支持 SOCKS4 / SOCKS5 / HTTP / HTTPS），点「联网测试」确认能连通 Telegram API 再往下走。
2. **扫码登录** —— 「设置 → Telegram 账号 → 扫码登录」，手机 Telegram → 设置 → 设备 → 链接桌面设备 → 扫描。
3. **加频道** —— 「频道」页粘贴 `@channel` 或 `t.me` 链接；私有频道用 `t.me/c/<内部ID>/<消息ID>` 链接或直接填数字 ID（账号需已加入）。
4. **建订阅** —— 「订阅关键词」页填关键词、选匹配方式与生效频道。
5. **等扫描** —— 默认每 15 分钟自动扫描，也可在概览页点「立即扫描」。

---

## 常用配置

完整配置项见 [PROJECT_DOC.md](PROJECT_DOC.md#配置说明)。最常用的几个：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `6789` | 监听端口 |
| `DATA_DIR` / `DOWNLOAD_DIR` | `./data` / `$DATA_DIR/downloads` | 数据目录与下载目录；Docker 里为 `/data`、`/downloads` |
| `SESSION_SECRET` | 自动生成 | 加密 session 的密钥（≥16 位），更换后需重新登录 |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | 空 | 同时设置后启用 HTTP Basic 认证 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `TZ` | `Asia/Shanghai` | 时区，影响日志与按天分目录 |

界面设置项（扫描间隔、路径模板、截帧开关、ffmpeg 路径、机器人开关等）存在数据库里，在「设置」页改完即生效，无需重启。

---

## Emby 入库通知（下载完成即入库）

下载完成后，程序把新文件的路径提交给 Emby 的 `POST /Library/Media/Updated` 接口，
Emby 只对这一条路径做增量扫描 —— 不用等它的定时任务，也不必去后台手动点「扫描媒体库」。

配置都在「**设置 → Emby 入库通知**」这一块（1.0.4 起不再单独占一个导航项）：

| 项 | 填什么 |
| --- | --- |
| Emby 地址 | 例如 `http://192.168.1.10:8096`。不写协议按 `http` 处理，末尾的 `/web` 会自动去掉 |
| Emby API Key | Emby 后台 → 设置 → API 密钥 → 新建，权限选管理员。加密存库，接口只回掩码 |
| 路径映射 | 每行一条「本机路径=Emby 看到的路径」，例如 `/downloads=/volume1/media/tgsub` |

**路径映射是最容易漏的一步**：容器里下载到 `/downloads`，而 Emby 看到的是宿主目录
（群晖 `/volume1/...`、威联通 `/share/...`）。不填的话 Emby 会**静默忽略**——接口照样返回
204，什么都不报，只是媒体库里始终不出新集。填好后点「测试连接」，能看到 Emby 的服务器名与版本就说明地址与密钥都对。

其他行为：

- **合批**：连着下完几集，攒 2.5 秒合成一次请求，只触发一次增量扫描。
- **失败不影响下载**：通知失败会重试一次并写日志，下载任务本身照旧标记成功。
- **兜底**：点「让 Emby 全库扫描」立刻触发一次全库扫描，适合补历史文件。
- **老剧集**：升级前下载的不会自动补推，用页面底部「补推路径」填剧集目录名（如 `美人局`）提交一次即可。
- **开关**：关掉「下载完成后通知 Emby 入库」就完全停止通知，与 Emby 自身的库配置互不影响。

---

## 网络与代理

「设置 → 网络与代理」是独立的一块，填一个代理地址即可，协议由地址前缀决定：

| 写法 | 说明 |
| --- | --- |
| `socks5://192.168.5.2:7890` / `socks5h://…` | 最常用；`h` 表示域名交给代理解析，能绕开本地 DNS 污染 |
| `socks4://host:1080` | 老代理，只支持 IPv4 |
| `http://host:8080` / `https://host:8443` | HTTP 代理（CONNECT 隧道），可带 `user:pass@` |

不带协议时按 `socks5` 处理；省略端口则用各协议默认值（socks 1080、http 8080、https 8443）。地址里的用户名密码会跟随保存。

**Telegram 只能用 SOCKS**：MTProto 是裸 TCP，`gramjs` 不支持 HTTP 代理。填了 http/https 时代码会明确报错，界面上也会先给一条黄色警告，不要以为是代理没通。

**「联网测试」按钮**会并发探测四个站点，各显示状态码与耗时：

- **Telegram API** —— 下载与登录都靠它，这个不通就什么都做不了
- **Google / GitHub** —— 国外线路参照
- **百度** —— 国内线路参照

拿到任意 HTTP 状态码即视为连通（403 / 404 也算），所以失败项看到的原因是网络层错误：`域名解析失败`、`连接被拒绝`、`超时`、`代理 1.2.3.4:7890 连不上` 等。国内三个通、Telegram 超时，就是典型的代理没生效。

机器人区域还有「测试 Token」：它走 Bot API 的 `getMe`（普通 HTTPS），和机器人进程自己的 MTProto 是两条路 —— getMe 通但机器人不在线，说明 token 没问题、是那条长连接被挡了。

---

## 缓存清理

`data` 下有两个「删了也能重建」的缓存目录，设置页的「**缓存清理**」卡片就是管它们的：

| 目录 | 存什么 | 重建方式 |
| --- | --- | --- |
| `data/covers` | 消息列表展开时的封面预览，每条消息 3 张 320px 缩略图 + 一份 json | 再次展开该消息时从 Telegram 取 |
| `data/frames` | 元数据页「截帧」的候选图，每个目标一个子目录（含早期自动截帧的 `auto/` 遗留） | 重新点「截帧」 |

**不在清理范围**：`tgsub.db`（数据库）、`downloads/`（下载的媒体）、`logs/`（日志），以及已经写进剧集目录的 nfo 与封面。

- **上限**：默认 512 MB，填 `0` 表示不清理。超过上限时按最后写入时间从旧到新删，一次清到上限的 80%（留余量，避免每下一集都触发）。
- **自动触发**：每集下载完成、以及元数据页截帧之后各检查一次（攒 3 秒合并）；进程启动时也会检查一次。
- **保护**：最近 10 分钟内写入的组先不动，免得删掉你正在挑选的候选帧，留给下一轮。
- **一键清空**：点两次确认后清空两个目录（目录本身保留），不影响已经入库的视频。
- **统计**：卡片顶部显示合计 / 封面预览 / 截帧缓存三块占用，超过上限时数字变色；底部显示上次清理的时间与释放空间。

---

## 第三方平台（B站 / 抖音 / 小红书 / YouTube）

除了 Telegram 频道，也可以直接粘视频链接下载。引擎是镜像内置的 **yt-dlp**：
这些平台的播放地址都要签名（B站 `w_rid`、抖音 `a_bogus`、小红书 `x-s`、YouTube 的 `nsig`），
自己实现会随平台改版失效，交给 yt-dlp 跟版更稳。

**用法**：设置 → 第三方平台 → 打开开关 → 「手动下载」页粘贴链接 → 开始下载。
短链也认：`b23.tv/xxx`、`v.douyin.com/xxx`、`xhslink.com/xxx`、`xhslink.cn/xxx`、`youtu.be/xxx`。

**分享口令直接粘**：App 里点「复制链接」出来的那整段文字可以原样粘进来，说明文字会被忽略：

```
【李世民已经是太子，为什么还要强行继位？-哔哩哔哩】 <https://b23.tv/29inbIp>
4.87 复制打开抖音，看看【蓝心说影的作品】… https://v.douyin.com/dVS6cveLVCw/ :1pm j@C.UL
举手大喊：姐姐看我！… <https://xhslink.cn/o/8c7hpV57rvQ> 复制文本后进入【小红书】
```

同样这几段话**直接发给 Telegram 机器人**也会开始下载（一次最多 5 条），不用先转成纯链接。

**清晰度**默认「最高（原画）」：让 yt-dlp 取平台实际能给的最高码率，B站大会员、小红书登录态才会出现 1080P 以上；
想省空间可以在设置里降成固定档位。

### YouTube 需要代理

B站 / 抖音 / 小红书 在墙内**直连最快**，所以第三方平台有自己的代理设置，和 Telegram 那条互相独立：

```
设置 → 第三方平台 → 第三方平台代理
  http://192.168.1.2:7890
  socks5://192.168.1.2:7890
```

下 YouTube 必须填；不填会直接报「连不上 YouTube：请在第三方平台代理里填一个可用代理」。
代理只作用于 yt-dlp 子进程，不影响 Telegram 连接，也不影响国内平台（可以按需临时清空）。

YouTube 还需要 **JS 运行时**解密 `nsig`，镜像里自带 Node，yt-dlp 版本够（≥ 2025.10.22）时会自动带上
`--js-runtimes node`，不需要额外装 deno。

### yt-dlp 自动更新

平台改版频繁，镜像里的二进制会慢慢失效。设置页的引擎卡片会显示：

| 显示项 | 含义 |
| --- | --- |
| 版本号 | 当前实际在用的版本 |
| 来源标签 | `镜像内置` / `自动更新版`（`data/bin`）/ `手动指定` / `系统 PATH` |
| 最新版本 | 上次查询 GitHub 的结果，后面会标「已是最新 / 可更新」 |
| 上次检查 / 上次更新 | 相对时间（`3 小时前`） |

- 勾选「定时检查并自动更新」，填「每 N 小时」（默认 24）即可。首检在启动 90 秒后，之后每小时醒一次判断是否到点。
- 点「检查更新」立即执行；下载中按钮会显示百分比（状态每 2.5 秒轮询一次）。
- 新版下载到 `data/bin/yt-dlp`，**这个目录在挂载卷里，容器重建不会丢**，并且优先级高于镜像内置的那个。
- 替换前会先跑 `--version` 验证，通过才切换；旧文件保留为 `.bak`，失败自动回滚，不会把能用的引擎搞坏。
- 检查与下载都走「第三方平台代理」—— GitHub 在大陆直连不通，没配代理时会给明确提示。

### Cookie 怎么填

Cookie 在**设置 → 第三方平台**里，四个平台分开保存，**加密落盘**（与 Telegram session 同级），
接口只回摘要，不会明文回给界面。保存后输入框下面直接显示状态：

```
5 项 · SID / HSID / SSID … · 保存于 2 小时前
2 项 · 缺 SID                        ← 标黄，说明还不算登录态
```

粘贴时就会实时解析（不用先保存）：认出了几项、命中哪些关键字段、缺什么，一眼能看到。

取法：浏览器登录该平台 → F12 → Network → 随便点一个请求 → 复制 Request Headers 里的 `Cookie`
整串，粘进对应输入框。**设置页每个平台名后面有个 `?`，鼠标悬停就能看到该平台的分步说明**，
下面是同一份内容的摘要。至少要包含下表里的字段：

| 平台 | 关键字段 | 不填会怎样 |
| --- | --- | --- |
| B站 | `SESSDATA`（大会员画质还需要 `bili_jct`、`DedeUserID`） | 只能拿到 480P 左右，部分视频直接 412 |
| 抖音 | `ttwid`、`msToken`、`odin_tt` | 常拿到带水印的低清版本，且更容易被风控 |
| 小红书 | `web_session`、`a1` | 大概率返回空流或要求登录 |
| YouTube | `SID`、`SAPISID`（会员 / 年龄限制视频才需要） | 公开视频不填也能下；会员、私享、年龄限制会失败 |

Cookie 会过期（各平台不同，通常几周到几个月）。日志里出现「要求登录」「412」时重新复制一次即可，
**已下载的文件不受影响**。

### 落盘与命名

```
downloads/
  第三方/
    B站/
      UP主名字/
        视频标题 [BV1xx411c7mD]/
          视频标题 [BV1xx411c7mD].mp4
          视频标题 [BV1xx411c7mD].nfo      ← 标题 / 简介 / UP主 / 发布日期
          视频标题 [BV1xx411c7mD]-thumb.jpg
          tvshow.nfo / poster.jpg …        ← 截帧封面，与 Telegram 剧集一致
```

- 每条视频一个目录：Emby 里就是独立条目，`tvshow.nfo` 与封面不会互相覆盖。
- 清晰度在设置里选：最高（原画）/ 1080P / 720P / 480P。默认 1080P —— 选「最高」时 B站会给到 4K/8K，文件会很大。
- 目录名、下载后的真实扩展名由 yt-dlp 决定（可能是 mkv/webm），列表里显示的就是最终文件名。
- 与 Telegram 任务共用一条队列：一样能暂停 / 停止 / 继续 / 插队，一样写 nfo、截帧、通知 Emby。

### 常见报错

| 日志 | 原因 | 处理 |
| --- | --- | --- |
| `要求登录：请…填入新鲜 Cookie` | Cookie 为空或已过期 | 重新复制 Cookie |
| `风控拦截（412）` | B站判定脚本请求 / Cookie 失效 / 请求过密 | 换新鲜 Cookie，隔几分钟再试 |
| `该链接没有所选清晰度` | 视频本身没有这个分辨率 | 画质改成「最高」 |
| `yt-dlp 认不出这个链接` | 主页链接、或页面类型不支持（如小红书图文笔记） | 用视频详情页链接；图文笔记没有视频流 |
| `yt-dlp 不可用` | 镜像不是 1.0.6+，或本地开发没装 | 升级镜像，或在设置里填 yt-dlp 路径 |
| `连不上 YouTube：请…填一个可用代理` | 没配第三方平台代理，或代理不通 | 填代理后点「检查更新」旁的下次下载重试 |
| `该视频在当前地区不可用` | 代理节点所在地区被限制 | 换节点 |
| `YouTube 判定为机器人/需要年龄验证` | 机房 IP 被标记，或缺登录 Cookie | 换代理 IP；填 YouTube Cookie |
| `检查更新失败：…GitHub` | 访问不了 GitHub（大陆直连不通） | 在「第三方平台代理」里填代理后重试 |

> 镜像因此大了约 30 MB（内置 yt-dlp 自带 Python 运行时）。
> 本地构建访问不了 GitHub 时可以 `--build-arg INSTALL_YTDLP=0` 跳过，Telegram 下载不受影响。

---

## 数据与备份

| 宿主机目录 | 内容 |
| --- | --- |
| `./data` | `tgsub.db`（频道、订阅、下载记录、监控历史、设置、加密 session）、`.session-secret`、`covers/`、`frames/`、`logs/app.log` |
| `./downloads` | 实际下载的媒体文件（视频 / 图片 / nfo / 封面） |

- **备份**打包 `./data` 即可恢复全部配置与记录；下载文件在 `./downloads`，可按需单独备份。
- 建议先 `docker compose stop`（让 SQLite 的 WAL 落盘）再拷贝。
- **恢复**时保持 `SESSION_SECRET`（或 `.session-secret`）不变，否则 session 解不开，需重新扫码。

---

## 常见问题

**容器一直重启，日志报 `EACCES: permission denied, open '/data/.session-secret'`**
挂载目录属主与容器内运行用户不一致。NAS 面板自动创建的目录属主是 `root`，而程序以 `node`(1000) 运行。
本镜像的入口脚本会自动修正属主，**先确认镜像是最新版**（`docker compose pull && docker compose up -d`）；
若日志显示「无法修改 … 的属主」，按上面「NAS 部署」章节的表格手动处理，或调 `PUID`/`PGID`。

**日志里刷 `Tini is not running as PID 1 and isn't registered as a child subreaper`**
compose 里多写了一行 `init: true`，和镜像自带的 tini 重复了。删掉那一行即可（不影响功能，但会多一个进程并刷警告）。

**私有频道下载报 `Could not find the input entity ... className: PeerUser`**
频道 ID 必须用 Telegram 的标记形式（`-100` 开头）解析，裸号会被当成用户 ID。程序内部已统一处理；若手动改过数据库里的 `channels.tg_id`，改回未标记的裸号即可。

**扫码登录失败 / 二维码加载不出来**
先确认代理已保存且可用；一直卡在「等待扫描…」时检查手机是否为同一账号、入口是否为「设置 → 设备 → 链接桌面设备」。
若反复生成二维码都失败，点「彻底重置并重新登录」清掉旧 session 后再扫。

**提示「本地登录凭据已被 Telegram 判定失效」，点重新链接没用、重新扫码也无效**
这是 Telegram 服务器已作废该 authKey（`AUTH_KEY_UNREGISTERED` / `AUTH_KEY_DUPLICATED`），旧 session 不可能「重连」回来，
**必须先清干净再扫码**。设置页的失效提示会按错误码给出指引：

| 界面提示 | 含义 | 处理 |
| --- | --- | --- |
| 服务器已作废，重试不会恢复 | authKey 被服务器永久删除 | 点「彻底重置并重新登录」，再重新扫码 |
| 错误码 `AUTH_KEY_DUPLICATED` | 同一 authKey 在多处连接，已被作废 | 同上；并确认没有第二个容器/进程在用同一份 session |
| 错误码 `SESSION_REVOKED` / `SESSION_EXPIRED` | 会话被主动吊销或过期 | 同上，重新扫码即可 |

「彻底重置并重新登录」会删除本地 session 与备份、清空登录状态，**不会影响频道、订阅、下载记录**。
若重置后仍无法扫码，去「日志」页看 `AUTH_KEY_*` 错误码与 `已切换数据中心并恢复重连节流` 记录定位。

**登录失效后想保留 session 不重扫**
可在「日志」页看错误码与时间点，确认没有第二个实例占用同一 session 后，在设置页「手动导入 session」恢复。

**点「继续」后进度回到 0**
gramjs 的 `downloadMedia` 不支持断点续传，暂停/停止/让位后都会从头下载。

**元数据页显示不出视频时长/分辨率**
镜像里内置了 `ffmpeg` 但**没有内置 `ffprobe`**（ffprobe 单独就占 75MB，是镜像体积大头）。
时长、分辨率、编码等字段改由 `ffmpeg -i` 的输出解析，功能不受影响。
若连 `ffmpeg` 也没有，在「设置 → Emby 与封面」里填 `ffmpeg 路径` 指向宿主机上的 ffmpeg 可执行文件即可。

**磁盘涨得快**
在设置里配好最小/最大文件大小，或给订阅限定频道；下载记录页可按状态筛选后批量删除。

---

## 日志页面

左侧导航「日志」页是排障的第一站，直接读服务运行日志，不需要 SSH 进容器。

| 能力 | 说明 |
| --- | --- |
| 级别筛选 | 全部 / 错误 / 警告 / 信息 / 调试 / 追踪，每个级别带条数 |
| 关键词搜索 | 同时匹配日志正文与结构化附加字段（如 `err.code`、`dcId`） |
| 自动刷新 | 每 5 秒拉一次，仅在第一页生效 |
| 下载归档 | 一键下载当前完整日志文件（`tgsub-<时间戳>.log`） |
| 清空 | 同时清空内存缓冲与磁盘文件，操作前有二次确认 |
| 详情展开 | 点任意一条展开查看完整附加字段与堆栈 |

日志同时输出到三处：`stdout`（`docker compose logs` 可见）、磁盘 `data/logs/app.log`（超过 10MB 自动轮转）、内存环形缓冲（保留最近 2000 条，重启后从文件尾部自动回灌）。

更多问题见 [PROJECT_DOC.md](PROJECT_DOC.md#常见问题)。

---

## 账号风控与封禁（必读）

**tgsub 是用你自己的账号登录 Telegram 的**，它做的每一件事（翻频道历史、下载媒体、加入频道）
在服务器看来都来自这个账号。Telegram 对"自动化使用"有明确风控，触发后不是封本程序，
而是处置**账号本身**。最严重的一次处置会同时执行三件事，看起来像三个 bug，其实是同一个结果：

| 你看到的现象 | 实际发生的事 |
| --- | --- |
| 刚登录就失效，提示 `AUTH_KEY_UNREGISTERED` / `SESSION_REVOKED` | 服务器**重置了该账号的全部会话** |
| 手机上其他设备（平板、另一台手机）一起被退出登录 | 同上，这是一次账号级操作，不是本程序踢的 |
| 机器人连不上，提示 `ACCESS_TOKEN_INVALID`，机器人变成"已删除账户" | 该账号创建的机器人被**冻结**，其 Token 被**重置** |

这种情况在本地做什么都没用：重新扫码、点重试、重装容器都不会恢复。
**反复重登是错的**——每点一次都在服务器侧新增一条授权记录，只会延长限制。

### 会触发风控的行为（按风险从高到低）

1. **用内置凭证跑自动化（尤其是官方客户端凭证）。**
   `1.0.1` 起默认已换成 tdl 自建应用（`api_id=15055931`），不再默认冒充官方桌面客户端；
   但内置凭证终究是公开共用的，风控敏感度仍高于你自己申请的应用。
   **长期使用请到 my.telegram.org 申请自己的 api_id/api_hash**，两分钟即可。
2. **短时间内反复登录。** 每扫一次码就是一条新授权。十分钟内堆十几条，等于告诉 Telegram 账号被接管了。
3. **代理出口 IP 频繁变化。** 同一个 authKey 从多个国家的 IP 出现，会直接回 `AUTH_KEY_DUPLICATED`
   （原文是 "auth key was registered from a different IP address"），并作废该 key。
   请用**固定出口**的代理，不要让节点自动切换。
4. **高频批量抓取。** 一次翻几百条历史、多个频道同时下载、把整个频道扒下来。
5. **自动加入大量频道**（`t.me/+xxx` 邀请链接会被自动 `ImportChatInvite`）。

### 已被处置了怎么办

1. **先停手**：不要再点重新登录，不要删容器重装，不要换代理反复试。
2. 手机 Telegram 打开 **[@SpamBot](https://t.me/SpamBot)**，发送 `/start`，看它给出的账号状态；
   若是 `limited` / `frozen`，按提示提交申诉（英文说明你只是自己备份频道内容、无群发无推广）。
3. 账号恢复后，**换成自己的 api_id**，并把扫描间隔调到 ≥ 30 分钟。
4. 机器人被冻结无法恢复，去 [@BotFather](https://t.me/BotFather) 重新 `/newbot`，把新 Token 填进设置。
5. 强烈建议**不要用主账号**，给这个工具单独注册一个小号。

### 程序侧已有的防护

- **重登闸门**：1 分钟内只允许 1 次登录、24 小时最多 5 次，超限直接拒绝并提示去申诉。
- **登录后延迟 10 秒再做独立重连验证**，避开"刚授权就双连接"导致的 `AUTH_KEY_DUPLICATED`。
- **重连节流**：掉线后按 4s→30s 递增退避，不抢在服务端回收旧连接之前重开。
- **单实例锁**：同一份 `./data` 只允许一个进程，防止双进程共用 authKey。
- **扫描节流**：分页拉取之间 300~900ms 随机间隔，频道之间 1.5~3s 随机间隔。
- 失效原因识别为风控类时，界面直接给出"去申诉"的指引，而不是让你继续点重试。

---

## 安全提示

- `./data` 内含加密 session、bot token 与加密密钥，请勿提交或分享。
- 公网部署请开启 Basic Auth 或使用反向代理 + HTTPS，并限制来源 IP。
- 机器人白名单为空时不会执行任何命令，配置后请立即填入自己的用户 ID。

---

## License

[MIT](LICENSE) © 2026 RDevils7
