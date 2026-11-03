import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const rootDir = process.cwd();

/**
 * 确保目录存在。
 *
 * mkdirSync 在「目录已存在」时不会报错（哪怕属主是 root、当前用户没写权限），
 * 所以真正的权限判断交给后面的探针文件。这里只处理「目录不存在且建不出来」的情况。
 */
function ensureDir(p: string, role: string): string {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    console.error(explainPermissionProblem(p, `${role}（目录不存在且无法创建）`));
    process.exit(1);
  }
  return p;
}

const dataDir = ensureDir(
  path.resolve(process.env.DATA_DIR || path.join(rootDir, "data")),
  "数据目录（数据库、加密 session、封面缓存）",
);
const downloadDir = ensureDir(
  path.resolve(process.env.DOWNLOAD_DIR || path.join(dataDir, "downloads")),
  "下载目录（视频 / 图片 / 剧集文件）",
);

/**
 * 目录是否真的可写。
 *
 * mkdirSync 对已存在的目录不会报错，NAS 上「目录属主是 root、容器内以 node(1000) 运行」
 * 这种情况下目录能进不能写，必须真的写一个探针文件才知道。
 */
export function isDirWritable(dir: string): boolean {
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * 权限不足时打印一段能直接照着做的排查指引。
 *
 * 这个函数在 logger 初始化之前执行（env 是 logger 的依赖），
 * 所以只能用 console 输出，不能用 pino。
 */
export function explainPermissionProblem(target: string, role: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const gid = typeof process.getgid === "function" ? process.getgid() : -1;
  return [
    "",
    "════════════════════════════════════════════════════════════",
    " tgsub 启动失败：目录不可写",
    "════════════════════════════════════════════════════════════",
    ` 目录：${target}`,
    ` 用途：${role}`,
    ` 当前进程身份：uid=${uid} gid=${gid}`,
    "",
    " 常见原因（NAS 部署几乎都是这个）：",
    "   Docker 面板 / docker compose 自动创建的挂载目录属主是 root，",
    "   而容器内的应用以 node(1000) 运行，写不进去。",
    "",
    " 解决办法（任选其一）：",
    "   1) 用本项目提供的最新镜像（入口脚本会自动把目录属主改成当前用户）：",
    "      docker compose pull && docker compose up -d",
    "   2) 手动改宿主机目录属主，和容器内运行用户一致：",
    "      sudo chown -R 1000:1000 <宿主机上的 data 目录> <宿主机上的 downloads 目录>",
    "   3) 在 compose 里指定运行用户（部分 NAS 面板支持）：",
    "      environment:",
    "        PUID: \"1000\"",
    "        PGID: \"1000\"",
    "   4) 若目录本就该由别的账号写入，把 PUID/PGID 改成那个账号的 uid/gid。",
    "",
    "════════════════════════════════════════════════════════════",
    "",
  ].join("\n");
}

/**
 * 会话密钥：优先读环境变量；否则在数据目录生成并持久化。
 * 用于加密 Telegram session（DB 落盘时不存明文）。
 */
function resolveSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const keyFile = path.join(dataDir, ".session-secret");
  if (fs.existsSync(keyFile)) {
    try {
      const saved = fs.readFileSync(keyFile, "utf8").trim();
      if (saved) return saved;
    } catch {
      // 文件在但读不了：多半是旧容器以 root 建的，属主对不上。
      // 密钥丢了会导致已保存的 session 解不开，只能重新扫码，所以这里必须说清楚。
      console.error(explainPermissionProblem(keyFile, "会话密钥文件（内容丢失会导致需要重新扫码登录）"));
      process.exit(1);
    }
  }
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  } catch {
    console.error(explainPermissionProblem(keyFile, "会话密钥文件"));
    process.exit(1);
  }
  return generated;
}

/**
 * 启动前的可写性检查。
 *
 * 之前这里直接调 resolveSecret()，写 .session-secret 失败时抛出一串
 * EACCES 堆栈，用户完全看不出该改什么（NAS 上最常见的故障就是这里反复重启）。
 * 现在先把话说清楚：哪个目录不可写、当前是什么身份、怎么改。
 */
function checkWritable(): void {
  if (!isDirWritable(dataDir)) {
    console.error(explainPermissionProblem(dataDir, "数据目录（数据库、加密 session、封面缓存）"));
    process.exit(1);
  }
  if (!isDirWritable(downloadDir)) {
    // 下载目录不可写不致命：管理界面还能开，只是下载会失败。
    // 这里只提示，不退出，避免整个服务因为一个目录挂错就完全起不来。
    console.warn(explainPermissionProblem(downloadDir, "下载目录（视频 / 图片 / 剧集文件）"));
    console.warn(" tgsub 会继续启动，但下载功能不可用。");
  }
}

checkWritable();

export const env = {
  port: Number(process.env.PORT || 6789),
  host: process.env.HOST || "0.0.0.0",
  dataDir,
  downloadDir,
  dbFile: path.resolve(process.env.DB_FILE || path.join(dataDir, "tgsub.db")),
  webDist: path.resolve(process.env.WEB_DIST || path.join(rootDir, "web", "dist")),
  logLevel: process.env.LOG_LEVEL || "info",
  secret: resolveSecret(),
  basicAuth: {
    user: process.env.BASIC_AUTH_USER || "",
    pass: process.env.BASIC_AUTH_PASS || "",
  },
  /**
   * 临时关闭管理界面登录（AUTH_DISABLED=1）。
   *
   * 单账号登录最怕的情况是「密码忘了，又没有任何入口能改」。
   * 这个开关就是那把备用钥匙：改 compose 加一行、重启、进去重设密码，再把它去掉。
   * 默认永远是开启鉴权的 —— 只有显式写了 1 才关。
   */
  authDisabled: process.env.AUTH_DISABLED === "1" || process.env.AUTH_DISABLED === "true",
  timezone: process.env.TZ || "Asia/Shanghai",
};
