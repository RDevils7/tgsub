import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import compression from "compression";
import { env } from "./env";
import { db, getSessionMeta, getSettings } from "./db";
import { logger } from "./logger";
import { HttpError } from "./lib/http";
import { acquireInstanceLock } from "./lib/instance";
import { onShutdown } from "./lib/lifecycle";
import { TgError, disconnectClient, handleDeadSessionError, isConfigured, startAuthWatchdog } from "./tg/client";
import { downloader } from "./tg/downloader";
import { repairLegacyArtifacts } from "./tg/legacy";
import { startScheduler } from "./tg/scanner";
import { startBot, stopBot } from "./tg/bot";
import { authRouter } from "./routes/auth";
import { channelsRouter } from "./routes/channels";
import { subscriptionsRouter } from "./routes/subscriptions";
import { downloadsRouter } from "./routes/downloads";
import { messagesRouter } from "./routes/messages";
import { metadataRouter } from "./routes/metadata";
import { settingsRouter } from "./routes/settings";
import { embyRouter } from "./routes/emby";
import { mediaRouter } from "./routes/media";
import { cacheRouter } from "./routes/cache";
import { systemRouter } from "./routes/system";
import { logsRouter } from "./routes/logs";
import { platformRouter } from "./routes/platform";
import { manualRouter } from "./routes/manual";
import { aiRouter } from "./routes/ai";
import { sessionRouter } from "./routes/login";
import { requireLogin, getAccount } from "./auth/service";
import { hydrateFromFile } from "./lib/logstore";
import { requestCacheTrim } from "./cache";
import { startYtdlpAutoUpdate } from "./platform/updater";
import { hwCapability } from "./tg/ffmpeg";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

/**
 * 所有 JSON 接口与前端 JS/CSS 都开 gzip / brotli。
 *
 * 前端主包 500KB+（gzip 后约 150KB），媒体库列表动辄几百条 JSON —— 不压缩时
 * 在 NAS / 反代 / 手机上慢得很明显。视频流必须原样放行：/api/media/stream 是
 * 无 Content-Length 的 fMP4 实时流，压缩中间件会把它改写成 chunked 并缓冲首包，
 * 直接把「点播放到出画面」拖慢甚至卡住。
 */
app.use(
  compression({
    threshold: 1024,
    filter: (req, res) => {
      if (req.path === "/api/media/stream" || req.path === "/api/media/art" || req.path === "/api/media/thumb") {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

/* 可选的基础认证：把管理界面暴露到公网时建议开启 */
if (env.basicAuth.user && env.basicAuth.pass) {
  const expected = Buffer.from(`${env.basicAuth.user}:${env.basicAuth.pass}`);
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const provided = Buffer.from(Buffer.from(encoded, "base64").toString("utf8"));
      if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
        next();
        return;
      }
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="tgsub", charset="UTF-8"');
    res.status(401).send("需要认证");
  });
}

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/api")) {
      logger.debug({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started }, "api");
    }
  });
  next();
});

/* 管理界面登录：先挂自己的接口，再把后面所有 /api 都拦在登录之后。
   注意顺序 —— 这两行必须在其它业务路由之前，否则保护不到它们。 */
app.use("/api/session", sessionRouter);
app.use("/api", requireLogin);

app.use("/api/auth", authRouter);
app.use("/api/channels", channelsRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/downloads", downloadsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/metadata", metadataRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/emby", embyRouter);
app.use("/api/media", mediaRouter);
app.use("/api/cache", cacheRouter);
app.use("/api/logs", logsRouter);
app.use("/api/platform", platformRouter);
app.use("/api/manual", manualRouter);
app.use("/api/ai", aiRouter);
app.use("/api", systemRouter);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "接口不存在" });
});

/* 前端静态资源 */
const indexHtml = path.join(env.webDist, "index.html");
if (fs.existsSync(indexHtml)) {
  app.use(
    express.static(env.webDist, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  app.get("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexHtml);
  });
} else {
  app.get("/", (_req, res) => {
    res
      .status(200)
      .type("html")
      .send(
        `<!doctype html><html><body style="font-family:system-ui;padding:40px;background:#0b0f17;color:#e6edf7">
         <h2>前端尚未构建</h2>
         <p>请执行 <code>npm run build</code>，或在开发模式下使用 <code>npm run dev</code>。</p>
         </body></html>`,
      );
  });
}

/* 统一错误处理 */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // session 在服务器端已失效：清本地状态并给出可理解的提示，避免暴露原始错误码
  if (handleDeadSessionError(err)) {
    res.status(401).json({ error: "登录状态已失效，请重新登录", code: "NOT_AUTHORIZED" });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof TgError) {
    const status =
      err.code === "NOT_AUTHORIZED"
        ? 401
        : err.code === "NETWORK"
          ? 503
          : err.code === "NOT_CONFIGURED"
            ? 409
            : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  const message = (err as Error)?.message || "服务器内部错误";
  logger.error({ err }, "未处理的请求错误");
  res.status(500).json({ error: message });
});

// 先拿单实例锁：并发连接会让 Telegram 直接作废 authKey，代价是重新扫码
acquireInstanceLock(path.join(env.dataDir, ".instance.lock"));

// 把磁盘上的历史日志回灌进内存缓冲：容器重启后日志页还能看到上次的记录
try {
  const loaded = hydrateFromFile();
  if (loaded > 0) logger.info({ loaded }, "已载入历史日志");
} catch {
  /* 日志回灌失败不影响启动 */
}

// 修正历史剧集文件名（旧版多带了一截「-NN」序号）与私有频道的失效链接，
// 数据库与磁盘文件一起改。放在下载队列启动之前，避免重试时生成「(2)」副本或留下孤儿文件。
try {
  const report = repairLegacyArtifacts();
  if (report.renamed || report.links || report.series || report.dirs) {
    logger.info(report, "已修正历史剧集文件名与消息链接");
  }
} catch (err) {
  logger.warn({ err: (err as Error).message }, "修正历史剧集数据失败");
}

const server = app.listen(env.port, env.host, () => {
  const settings = getSettings();
  const meta = getSessionMeta();
  logger.info(
    {
      port: env.port,
      host: env.host,
      autoScan: settings.auto_scan,
      interval: settings.scan_interval_minutes,
      sessionState: meta.state,
      sessionSavedAt: meta.savedAt ? new Date(meta.savedAt).toISOString() : null,
    },
    "tgsub 已启动",
  );
  if (env.authDisabled) {
    logger.warn("已通过 AUTH_DISABLED 关闭管理界面登录，任何人都能访问界面与接口，用完请立刻去掉");
  } else if (!getAccount()) {
    logger.warn("尚未设置管理界面登录账号，首次打开网页时会要求设置用户名与密码");
  }
  if (!isConfigured()) {
    logger.warn("当前为自定义 API 模式但未填写 API ID / API Hash，请在设置页补全或切换为内置凭证");
  } else if (meta.state === "none") {
    logger.warn("尚未登录 Telegram 账号，请在设置页扫码登录");
  } else if (meta.state === "ok") {
    logger.info("已加载本地 session，重启无需重新扫码");
  }
});

server.on("error", (err) => {
  logger.error({ err }, "HTTP 服务启动失败（端口可能已被占用）");
  process.exit(1);
});

// 延迟启动下载队列：进程重启后如果立刻恢复队列就会马上重连 Telegram，
// 而上一次进程退出时服务器端的连接状态可能还没释放。留几秒缓冲，降低 authKey 被判异常的概率。
setTimeout(() => downloader.start(), 5000).unref();
const scheduler = startScheduler();
startAuthWatchdog();

// 机器人用独立 authKey（bot token 授权），可以和用户账号同时在线。
// 稍微延后一点启动：先让用户账号的连接稳定下来，避免两个连接同时握手。
setTimeout(() => void startBot(), 8000).unref();

// 启动后按上限收拾一次缓存：上一次进程可能是被强杀的，没来得及清理
setTimeout(() => requestCacheTrim(0), 4000).unref();

// yt-dlp 的解析规则月月在变：按设置的间隔自己去 GitHub 看新版
// （首检延迟在 startYtdlpAutoUpdate 内部，避开启动时的重连高峰）
const stopYtdlpUpdate = startYtdlpAutoUpdate();

// 硬解能力探测要「真编一帧」，冷启动 1~3 秒。放在后台尽早预热（纯本地 ffmpeg，
// 不占 Telegram 连接），别等用户点开媒体库那一刻才开始，否则列表和播放首帧都跟着一起等。
setTimeout(() => void hwCapability(), 500).unref();

async function shutdown(signal: string) {
  logger.info({ signal }, "正在关闭");
  clearInterval(scheduler);
  stopYtdlpUpdate();
  downloader.stop();
  await stopBot().catch(() => undefined);

  // 必须先优雅断开 Telegram：否则进程退出时 TCP 被硬切断，
  // 服务器端连接状态残留，下次启动用同一个 authKey 重连容易被判定异常
  try {
    await disconnectClient();
  } catch {
    /* ignore */
  }

  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}

onShutdown(async (reason) => {
  await shutdown(reason);
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => logger.error({ reason }, "未处理的 Promise 拒绝"));
