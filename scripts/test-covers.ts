/**
 * 封面缓存的端到端自检（不联网）：
 *   1) 下载完成 → 拼图之前把 3 张封面原图复制进 data/covers，并标记来源为 download
 *   2) 预览阶段缓存的「第几张图」能被下载复用（preferredArtOrdinals）
 *
 * 运行：npx tsx scripts/test-covers.ts
 * 全程使用临时 DATA_DIR，不会动到真实数据。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tgsub-covers-"));
process.env.DATA_DIR = tmp;
process.env.SESSION_SECRET = "test-secret-key-0123456789abcdef";

async function main(): Promise<void> {
  const { db } = await import("../server/src/db");
  const { env } = await import("../server/src/env");
  const { finalizeMedia, encodeMeta } = await import("../server/src/tg/emby");
  const { listCovers, readCoverMeta, preferredArtOrdinals, coverKey } = await import("../server/src/tg/covers");
  const sharp = (await import("sharp")).default;

  let passed = 0;
  const check = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn();
      passed += 1;
      console.log(`  \u2713 ${name}`);
    } catch (err) {
      console.error(`  \u2717 ${name}`);
      console.error(`    ${(err as Error).message}`);
      process.exitCode = 1;
    }
  };

  // 准备：频道 + 3 张封面任务（.art-<消息号>-N.jpg）+ 正片
  const channelId = 1;
  const messageId = 10500;
  db.prepare("INSERT INTO channels(tg_id, username, title, enabled, created_at) VALUES (?,?,?,?,?)").run(
    "-100123",
    "ASC2256",
    "测试频道",
    1,
    Date.now(),
  );
  const dir = path.join(env.downloadDir, "美人局");
  await fs.promises.mkdir(dir, { recursive: true });
  const sizes: Array<[number, number]> = [
    [600, 900],
    [1600, 900],
    [900, 1200],
  ];
  for (const [index, size] of sizes.entries()) {
    const name = `.art-${messageId}-${index + 1}.jpg`;
    await sharp({ create: { width: size[0], height: size[1], channels: 3, background: { r: 20 * index, g: 60, b: 90 } } })
      .jpeg()
      .toFile(path.join(dir, name));
    db.prepare(
      `INSERT INTO downloads(channel_id, channel_title, message_id, file_name, file_size, media_kind, status, progress, created_at, save_dir, save_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(channelId, "测试频道", messageId + index, name, 1000, "photo", "done", 100, Date.now(), "美人局", name);
  }
  const video = path.join(dir, "美人局S01E04.mp4");
  await fs.promises.writeFile(video, "fake");

  const meta = {
    series: "美人局",
    season: 1,
    episode: 4,
    firstLine: "《美人局》第4集",
    plot: "简介：美人局......",
    tags: ["美人局"],
    studio: "测试频道",
    link: "https://t.me/ASC2256/10500",
    airedAt: Date.now(),
    messageId,
    kind: "video" as const,
  };

  await finalizeMedia(video, encodeMeta(meta));

  await check("下载产生的 3 张封面被存进 covers 目录", async () => {
    const list = await listCovers(channelId, messageId);
    assert.equal(list.length, 3, `实际 ${list.length} 张`);
    for (const item of list) {
      const stat = await fs.promises.stat(path.join(env.dataDir, "covers", item.file));
      assert.ok(stat.size > 0);
    }
  });

  await check("封面来源标记为 download", async () => {
    const saved = readCoverMeta(channelId, messageId);
    assert.equal(saved?.source, "download");
    assert.equal(saved?.files.length, 3);
  });

  await check("临时 .art 文件已清理", async () => {
    const left = (await fs.promises.readdir(dir)).filter((n) => n.startsWith(".art-"));
    assert.equal(left.length, 0);
  });

  await check("下载来源不参与封面复用", () => {
    assert.equal(preferredArtOrdinals(channelId, messageId), null);
  });

  // 预览场景：悬停时抓的缩略图 + 序号记录 → 下载时要沿用同样这几张
  await check("预览记录能让下载复用同样的图", async () => {
    const key = coverKey(2, 20001);
    const coverDir = path.join(env.dataDir, "covers");
    for (const index of [1, 2, 3]) {
      await fs.promises.writeFile(path.join(coverDir, `${key}-${index}.jpg`), Buffer.from([0xff, 0xd8, 0xff]));
    }
    await fs.promises.writeFile(
      path.join(coverDir, `${key}.json`),
      JSON.stringify({ photos: [2, 5, 7], files: [`${key}-1.jpg`, `${key}-2.jpg`, `${key}-3.jpg`], source: "telegram", at: Date.now() }),
    );
    assert.deepEqual(preferredArtOrdinals(2, 20001), [2, 5, 7]);
  });

  // Windows 下 SQLite 还占着句柄，删不掉就直接留着（在系统临时目录里）
  await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n通过 ${passed} 项封面缓存自检${process.exitCode ? "（存在失败）" : "，全部正常"}\n`);
}

void main();
