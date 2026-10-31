/**
 * 机器人命令层自检：不连 Telegram，用临时数据目录跑一遍命令。
 *
 * 目的：验证 /status 之外的命令解析、参数处理、数据库读写都是通的，
 * 免得等真机发消息时才发现某个命令写错。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tgsub-bot-"));
process.env.DATA_DIR = tmp;
process.env.DOWNLOAD_DIR = path.join(tmp, "downloads");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, extra = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${extra ? ` — ${extra}` : ""}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const { runBotCommand } = await import("../server/src/tg/bot");
  const { getSettings } = await import("../server/src/db");

  const ctx = { userId: "123456789", send: async () => undefined };
  const run = (cmd: string, args: string[] = []) => runBotCommand(cmd, args, ctx);

  console.log("\n机器人命令");
  const help = await run("help");
  check("/help 有说明和按钮", help.text.includes("tgsub 控制台") && Boolean(help.buttons?.length));

  const id = await run("id");
  check("/id 回显自己的用户 ID", id.text.includes("123456789"));

  const channels = await run("channels");
  check("/channels 空库提示", channels.text.includes("还没有添加频道"));

  const addNoArg = await run("addch");
  check("/addch 无参数给出用法", addNoArg.text.includes("用法"));

  const subsEmpty = await run("subs");
  check("/subs 空库提示", subsEmpty.text.includes("还没有订阅规则"));

  const created = await run("sub", ["美人局,", "芙蓉", "|", "短剧"]);
  check("/sub 创建订阅", created.text.includes("已创建订阅"), created.text);
  const subId = Number(/#(\d+)/.exec(created.text)?.[1] ?? 0);

  const subs = await run("subs");
  check("/subs 能看到新订阅", subs.text.includes("美人局") && subs.text.includes("短剧"), subs.text);

  const removed = await run("rmsub", [String(subId)]);
  check("/rmsub 删除订阅", removed.text.includes("已删除"));

  const tasks = await run("tasks");
  check("/tasks 空库提示", tasks.text.includes("还没有下载任务"));

  const queue = await run("queue");
  check("/queue 返回队列信息", queue.text.includes("下载队列"));

  const stats = await run("stats");
  check("/stats 返回统计", stats.text.includes("累计统计"));

  await run("pause");
  check("/pause 关闭自动扫描", getSettings().auto_scan === false);
  await run("resume");
  check("/resume 恢复自动扫描", getSettings().auto_scan === true);

  const scan = await run("scan");
  check("/scan 空频道列表有提示", scan.text.includes("没有可扫描的频道"), scan.text);

  const unknown = await run("nope");
  check("未知命令回到帮助", unknown.text.includes("未知命令"));

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);

  // 先关掉数据库句柄，否则 Windows 上删不掉临时目录
  const { db } = await import("../server/src/db");
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
