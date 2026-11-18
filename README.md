# tgsub

**Telegram 频道关键词订阅下载器** —— 定时扫描已加入的频道，命中关键词即下载整条消息（含相册），按剧集命名并写入 Emby 元信息；带 Web 管理界面与 Telegram 机器人遥控，也支持 B 站 / 小红书 / YouTube / 网页 m3u8 链接下载。

<p>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-1.3.24-2496ED.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-339933.svg">
</p>

```
频道 → 定时扫描 → 关键词命中 → 下载队列 → 剧集命名 + NFO/封面 → 本地媒体库 / Web 界面
```

配置全集、HTTP 接口与排错细节见 [PROJECT_DOC.md](PROJECT_DOC.md)。

## 功能

- **订阅抓取**：关键词（包含 / 完整 / 正则）定时增量扫描，以消息为单位下载，相册整组归档。
- **命名与元信息**：`《剧名》第4集` → `剧名/剧名S01E04.mp4`，落盘即写 NFO、缩略图与封面，可通知 Emby 增量扫描。
- **本地媒体库**：海报墙浏览、点开即播，自带跳秒 / 倍速 / 截图 / 画中画 / 连播；按文件自动选择 direct / remux / 硬解转码。
- **文件整理**：整剧改名、分集合并、移动 / 复制 / 删除（可恢复），重名自动跳过。
- **多来源**：Telegram、B 站、小红书、YouTube（内置 yt-dlp）、网页 / m3u8（无头浏览器兜底），共用同一队列。
- **管理与遥控**：Web 界面（首访设管理员账号）、扫码登录 Telegram、Telegram 机器人直接收文件与链接。

## 快速开始（Docker Compose）

双架构镜像 `linux/amd64` + `linux/arm64`，无需 clone 或编译。

```bash
mkdir -p tgsub/data tgsub/downloads && cd tgsub
sudo chown -R 1000:1000 data downloads
```

```yaml
services:
  tgsub:
    image: rdevils7/tgsub:latest
    container_name: tgsub
    restart: unless-stopped
    devices: ["/dev/dri:/dev/dri"]   # 硬件转码；无核显 / 无 /dev/dri 的机器请删掉此行
    ports: ["6789:6789"]
    environment:
      TZ: Asia/Shanghai
      PUID: "1000"
      PGID: "1000"
      SESSION_SECRET: ""   # 设了就别改，否则需重新扫码
    volumes:
      - ./data:/data
      - ./downloads:/downloads
```

```bash
docker compose up -d      # 访问 http://<服务器IP>:6789
```

- `./data`：数据库、加密 session、封面缓存、日志
- `./downloads`：媒体文件，按来源分 `telegram / B站 / 小红书 / youtube / m3u8`

**注意事项**

- 挂载目录属主需为 `1000:1000`；NAS 上如报 `EACCES`，把 `PUID/PGID` 改成 NAS 账号的 uid/gid。
- 硬件转码只加 `devices: ["/dev/dri:/dev/dri"]`，**不要**加 `group_add: ["video","render"]`。
- 代理填 `host.docker.internal:7890` 或局域网 IP，**不要**填 `127.0.0.1`（那是容器自己）。
- 拉镜像慢可临时用 `docker.1ms.run/rdevils7/tgsub:latest`。

## 首次使用

1. **设置账号**：首次访问强制设置管理员用户名与密码（≥8 位）。
2. **配置代理**：设置 → 网络与代理，填 SOCKS5 / HTTP 后点「联网测试」。
3. **扫码登录**：设置 → Telegram 账号 → 扫码（手机 Telegram → 设置 → 设备 → 链接桌面设备）。
4. **加频道 + 订阅**：频道页粘 `@channel` 或 `t.me` 链接；订阅页填关键词。
5. **等待扫描**：默认每 15 分钟一次，概览页可「立即扫描」。

> 忘记密码：compose 临时加 `AUTH_DISABLED: "1"` → 重启 → 重设密码 → **删除该行再重启**。

## 常用环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `6789` | 监听端口 |
| `DATA_DIR` / `DOWNLOAD_DIR` | `/data` / `/downloads` | 数据 / 下载目录 |
| `SESSION_SECRET` | 自动生成 | 加密 session 的密钥，改动需重新扫码 |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | 空 | 同时设置即开启 HTTP Basic |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `AUTH_DISABLED` | 空 | 应急关闭登录，用完必须删除 |
| `TZ` | `Asia/Shanghai` | 时区 |

界面内的设置（扫描间隔、路径、画质、代理、Cookie、机器人等）存数据库，改完即生效。

## 升级与备份

```bash
docker compose pull && docker compose up -d   # 升级，数据保留
docker compose stop                            # 优雅停止
```

- 备份：`docker compose stop` 后打包 `./data` 即可（恢复时保持 `SESSION_SECRET` 不变）。
- 镜像标签：`latest` 为最新正式版；生产建议锁定具体版本，如 `v1.3.24`。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 反复重启 / `EACCES` | `chown -R 1000:1000 data downloads` 或改 `PUID/PGID` |
| 网页打不开但容器在跑 | 检查端口映射 / 防火墙；用 `http://` 而非 `https://` |
| 登录框刷「连接异常，延迟重连」 | 代理未生效，设置页点「联网测试」 |
| 机器人无响应 | 确认 bot 在线、Token 有效；纯图片需开「🖼 图片下载」 |
| 新集不进 Emby | 检查地址 / API Key / 路径映射，Emby 勾「优先使用本地 NFO」 |
| 视频一直缓冲 | 1.3.21+ 非 faststart MP4 自动走兼容通道；可先用「下载」取原文件 |

更多见 [PROJECT_DOC.md](PROJECT_DOC.md)。

## 更新日志

> 每次发版同步更新本节（新的在上）。更早版本见 git 提交历史。

### v1.3.24
- **AI 媒体信息整理**：手动网页 / m3u8 链接、平台链接（B站 / 小红书 / YouTube）、转发消息或文案，在自动识别出的标题/剧名不可靠时，由 AI 读取网页标题、描述、站点名或分享文案，生成干净的作品名 + 简介 + 标签；失败不影响下载。（设置 → AI「AI 智能命名与媒体信息整理」）
- **AI 故障报告**：内置 AI 结合日志与运行状态（会话、机器人、下载队列、工具链、磁盘、错误日志）自动生成结构化问题报告，落盘 `data/reports/`（含 `latest.json`），便于排查或交给其他智能体修复。接口 `POST /api/ai/report`、`GET /api/ai/report/latest`、`GET /api/ai/report/signals`；设置页「故障自动报告」开关（默认开，同一事件只报一次）。

### v1.3.23
- 修复媒体库视频无法播放：换封装(remux)在容器内偶发长时间零输出，导致「一直缓冲 / 15 秒后报『没收到可解码字节』」。现在 remux 6 秒内无首字节、ffmpeg 无输出退出、或无 ffmpeg 时，自动回退为直连 Range 播放。
- 直连响应补 `X-Accel-Buffering: no`，缓解反向代理缓冲大响应。

### v1.3.22
- 链路冷却：连不上 Telegram 时整体停手一段时间（5→10→20→40→60 分钟指数退避，到点只试一次，成功即恢复），降低高频重连引发的风控。
- 心跳对 `AUTH_KEY_DUPLICATED` 等可自愈错误改为多轮确认再判死；修复断开后重连定时器未取消导致的僵尸重连。
- 新增机器人看门狗：静默掉线后按指数退避自动重启。

### v1.3.21
- 非 faststart MP4 自动走兼容播放通道（实时换封装 fMP4），缓解「海报正常、视频一直缓冲」；会话 cookie 自动补种。

## 说明

本工具以你的 Telegram 账号身份读取频道内容，请自行评估风险；改名 / 合并会真实移动磁盘文件，建议先在副本目录试用。本工具不提供任何内容，仅用于归档你有权限访问的内容。

## License

[MIT](LICENSE)
