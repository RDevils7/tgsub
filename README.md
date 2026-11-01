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
- **剧集命名**：正文带《剧名》的自动识别为 `美人局/美人局S01E04.mp4`；认不出标题的按正文首行建文件夹，文件夹与文件同名。
- **Emby 元信息**：落盘即写出 `tvshow.nfo` + 单集 nfo，并生成竖版海报 / 横版图 / 背景图三张封面；没图时用 ffmpeg 截帧自动补齐。
- **队列管控**：串行下载（避免 MTProto 切 DC 打断文件），每条任务支持暂停 / 停止 / 继续 / 插队，实时显示速度与剩余时间。
- **元数据编辑页**：按文件夹聚合展示剧集，可手动改 NFO、换封面、ffmpeg 截帧、框选裁剪；也支持登记服务器上的本地视频目录。
- **监控历史**：每次扫描看过的消息全部留痕，可按状态筛选、全文搜索，用来排查「为什么这条没下载」。
- **扫码登录**：手机扫二维码即可，**无需申请 api_id / api_hash**；session 加密落盘，重启不用重登。
- **Telegram 机器人**：手机上发消息就能扫描、加频道、改订阅、看队列、按链接下载。

---

## 快速部署（Docker Compose）

**无需 clone 仓库、无需在服务器上编译** —— 直接从 GitHub Container Registry 拉取已构建好的镜像：

```
ghcr.io/rdevils7/tgsub:latest
```

镜像为 `linux/amd64` 与 `linux/arm64` 双架构，服务器上只要有 Docker 20.10+ 与 docker compose v2 即可。

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
    image: ${IMAGE:-ghcr.io/rdevils7/tgsub:latest}
    container_name: tgsub
    restart: unless-stopped
    init: true
    ports:
      - "${APP_PORT:-3000}:3000"
    environment:
      TZ: ${TZ:-Asia/Shanghai}
      DATA_DIR: /data
      DOWNLOAD_DIR: /downloads
      LOG_LEVEL: ${LOG_LEVEL:-info}
      SESSION_SECRET: "${SESSION_SECRET:-}"
      BASIC_AUTH_USER: "${BASIC_AUTH_USER:-}"
      BASIC_AUTH_PASS: "${BASIC_AUTH_PASS:-}"
    volumes:
      - "${DATA_HOST_DIR:-./data}:/data"
      - "${DOWNLOAD_HOST_DIR:-./downloads}:/downloads"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
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

整个部署过程**只需要这一个文件**，不需要 clone 仓库、不需要在本机编译、也不需要访问 GitHub 源码。
（若网络能访问 raw.githubusercontent.com，也可以直接下载仓库里的同一份文件：
`curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/RDevils7/tgsub/main/docker-compose.yml`）

### 3. 可选：配置 `.env`

不上传也能跑（全部有默认值）。需要改端口、目录、认证时再新建 `.env`：

```bash
APP_PORT=3000                    # 宿主机映射端口
DATA_HOST_DIR=/opt/tgsub/data    # 数据持久化目录
DOWNLOAD_HOST_DIR=/mnt/nas/tgsub # 下载目录（可指向 NAS / 大容量盘）
SESSION_SECRET=                  # 加密 session 的密钥，留空自动生成；换掉需重新登录
BASIC_AUTH_USER=                 # 公网部署建议开启基础认证
BASIC_AUTH_PASS=
```

> `SESSION_SECRET` 留空（或不足 16 位）时，程序会在数据目录自动生成 `/data/.session-secret` 并一直复用；
> 手动设置需 ≥16 位。**一旦设定就不要改** —— 改了数据库里的 session 解不开，得重新扫码。

### 4. 启动

```bash
docker compose up -d
docker compose logs -f --tail=200
```

启动后访问 `http://<服务器IP>:3000`，进入「设置 → Telegram 账号 → 扫码登录」用手机扫码即可。

> **代理**：国内网络直连不上 Telegram，请先在「设置 → API 凭证与网络」填代理地址。
> 容器里的 `127.0.0.1` 是容器自己，访问宿主机代理要用 `host.docker.internal:7890`
> （Linux 需在 compose 中加 `extra_hosts: ["host.docker.internal:host-gateway"]`）或局域网 IP。

### 运维命令

```bash
docker compose pull                 # 拉取最新镜像
docker compose up -d                # 用新镜像重建容器（数据保留）
docker compose logs -f --tail=200   # 看日志
docker compose restart              # 优雅重启（会先断开 Telegram 再退出）
docker compose down                 # 停止容器，数据保留在 ./data 与 ./downloads
```

### 可用镜像标签

| 标签 | 含义 |
| --- | --- |
| `latest` | 最新一次 `main` 推送或 `v*` 发布构建的镜像 |
| `v1.0.0` / `1.0.0` | 打标签时产生的固定版本（**生产环境建议锁定**） |
| `1.0` | 只带大版本号的滚动标签 |
| `sha-<完整提交号>` | 每个提交一个不可变版本，便于回滚定位 |

```bash
# 锁定版本部署
IMAGE=ghcr.io/rdevils7/tgsub:v1.0.0 docker compose up -d
```

> 镜像仓库是公开的，任何人都能 `docker pull`。若你的 fork 需保持私有，去 GitHub 仓库
> `Settings → Packages` 改为 Private，拉取前先 `docker login ghcr.io -u <用户名>`（密码用 PAT，勾选 `read:packages`）。

### 不用 compose？

```bash
docker pull ghcr.io/rdevils7/tgsub:latest
docker run -d --name tgsub -p 3000:3000 \
  -v "$(pwd)/data:/data" -v "$(pwd)/downloads:/downloads" \
  -e DATA_DIR=/data -e DOWNLOAD_DIR=/downloads -e TZ=Asia/Shanghai \
  --restart unless-stopped ghcr.io/rdevils7/tgsub:latest
```

### 其他部署方式

需要改代码或本地开发时，见 [PROJECT_DOC.md](PROJECT_DOC.md) 的「快速开始」章节（含本地构建镜像、本地运行）。

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
| `PORT` / `APP_PORT` | `3000` | 监听端口 / 宿主机映射端口 |
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
| `./data` | `tgsub.db`（频道、订阅、下载记录、监控历史、设置、加密 session）、`.session-secret`、`covers/`、`frames/`、`app.log` |
| `./downloads` | 实际下载的媒体文件（视频 / 图片 / nfo / 封面） |

- **备份**打包 `./data` 即可恢复全部配置与记录；下载文件在 `./downloads`，可按需单独备份。
- 建议先 `docker compose stop`（让 SQLite 的 WAL 落盘）再拷贝。
- **恢复**时保持 `SESSION_SECRET`（或 `.session-secret`）不变，否则 session 解不开，需重新扫码。

---

## 常见问题

**私有频道下载报 `Could not find the input entity ... className: PeerUser`**
频道 ID 必须用 Telegram 的标记形式（`-100` 开头）解析，裸号会被当成用户 ID。程序内部已统一处理；若手动改过数据库里的 `channels.tg_id`，改回未标记的裸号即可。

**扫码登录失败 / 二维码加载不出来**
先确认代理已保存且可用；一直卡在「等待扫描…」时检查手机是否为同一账号、入口是否为「设置 → 设备 → 链接桌面设备」。

**重启后提示未登录**
正常只需扫码一次，session 加密写入数据库，重启自动复用。仍然失效时依次排查：日志里的错误码与 authKey 指纹 → 是否有别的进程用过同一 session → `.session-secret` 是否被删除。

**点「继续」后进度回到 0**
gramjs 的 `downloadMedia` 不支持断点续传，暂停/停止/让位后都会从头下载。

**磁盘涨得快**
在设置里配好最小/最大文件大小、封面数量，或给订阅限定频道；下载记录页可按状态筛选后批量删除。

更多问题见 [PROJECT_DOC.md](PROJECT_DOC.md#常见问题)。

---

## 安全提示

- `./data` 内含加密 session、bot token 与加密密钥，请勿提交或分享。
- 公网部署请开启 Basic Auth 或使用反向代理 + HTTPS，并限制来源 IP。
- 机器人白名单为空时不会执行任何命令，配置后请立即填入自己的用户 ID。

---

## License

[MIT](LICENSE) © 2026 RDevils7
