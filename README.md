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
- **剧集命名**：剧名与集数从正文和原始文件名两处识别，`《美人局》第4集` → `美人局/美人局S01E04.mp4`，`妈妈我爱你 EP1-10` 的相册逐集编成 `S01E01` ~ `S01E10`；认不出标题的按正文首行建文件夹，文件夹与文件同名。
- **Emby 元信息**：落盘即写出 `tvshow.nfo` + 单集 nfo，并生成竖版海报 / 横版图 / 背景图三张封面；没图时用 ffmpeg 截帧自动补齐。
- **队列管控**：串行下载（避免 MTProto 切 DC 打断文件），每条任务支持暂停 / 停止 / 继续 / 插队，实时显示速度与剩余时间。
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
| 换镜像版本 | `image:` → `rdevils7/tgsub:v1.0.0` |
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
| `latest` | 最新一次 `main` 推送或 `v*` 发布构建的镜像 |
| `v1.0.0` / `1.0.0` | 打标签时产生的固定版本（**生产环境建议锁定**） |
| `1.0` | 只带大版本号的滚动标签 |
| `sha-<完整提交号>` | 每个提交一个不可变版本，便于回滚定位 |

```bash
# 锁定版本部署：把 compose 里 image: 一行改成 rdevils7/tgsub:v1.0.0
docker compose up -d
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

1. **配代理** —— 「设置 → API 凭证与网络」填 SOCKS5 / HTTP 代理。
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

界面设置项（扫描间隔、路径模板、封面数量、ffmpeg 路径、机器人开关等）存在数据库里，在「设置」页改完即生效，无需重启。

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
在设置里配好最小/最大文件大小、封面数量，或给订阅限定频道；下载记录页可按状态筛选后批量删除。

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

## 安全提示

- `./data` 内含加密 session、bot token 与加密密钥，请勿提交或分享。
- 公网部署请开启 Basic Auth 或使用反向代理 + HTTPS，并限制来源 IP。
- 机器人白名单为空时不会执行任何命令，配置后请立即填入自己的用户 ID。

---

## License

[MIT](LICENSE) © 2026 RDevils7
