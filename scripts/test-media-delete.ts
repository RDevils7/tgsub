/**
 * 元数据页删除功能的集成自检。
 *
 * 跑的是真实数据库 + 真实文件系统（都在临时目录里），
 * 验证「删目录 / 删单集 / 只移出列表」三种操作的副作用都符合预期。
 *
 * 脚本自己建临时数据目录，不碰真实 data / downloads。
 * 运行：npm run test:delete
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

function write(file: string, content = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function main(): Promise<void> {
  // 临时目录：先设好环境变量再动态 import，
  // 否则 ESM 的 import 提升会让 db/env 先加载、读到真实数据目录
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tgsub-del-"));
  const dataDir = path.join(tmp, "data");
  const downloadDir = path.join(tmp, "downloads");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  process.env.DOWNLOAD_DIR = downloadDir;
  process.env.DB_FILE = path.join(dataDir, "test.db");

  const { db } = await import("../server/src/db");
  const {
    addSource,
    collectFolders,
    isExcluded,
    listExcluded,
    listSources,
    restorePath,
  } = await import("../server/src/tg/mediatree");
  const { executeDelete, planDelete } = await import("../server/src/tg/mediamanage");

  /** 插入一条「下载完成」记录 */
  const insertDownload = (filePath: string, messageId: number): number => {
    const info = db
      .prepare(
        "INSERT INTO downloads (channel_id, channel_title, message_id, file_name, file_size, media_kind, status, file_path, created_at, finished_at) " +
          "VALUES (?, ?, ?, ?, ?, 'video', 'done', ?, ?, ?)",
      )
      .run(1, "测试频道", messageId, path.basename(filePath), 1024, filePath, Date.now(), Date.now());
    return Number(info.lastInsertRowid);
  };

  const downloadRows = (): Array<{ id: number; file_path: string }> =>
    db.prepare<[], { id: number; file_path: string }>("SELECT id, file_path FROM downloads").all();

  const root = path.resolve(downloadDir);
  console.log(`\n元数据删除用例（临时数据目录：${dataDir}）`);

  /* ---------------- 准备素材 ---------------- */

  const showA = path.join(root, "我的剧");
  const ep1 = path.join(showA, "我的剧S01E01.mp4");
  const ep2 = path.join(showA, "我的剧S01E02.mp4");
  write(ep1);
  write(ep2);
  write(path.join(showA, "我的剧S01E01.nfo"), "<tvshow/>");
  write(path.join(showA, "我的剧S01E02.nfo"), "<tvshow/>");
  write(path.join(showA, "我的剧S01E01-thumb.jpg"), "jpg");
  write(path.join(showA, "tvshow.nfo"), "<tvshow/>");
  write(path.join(showA, "poster.jpg"), "jpg");
  write(path.join(showA, "字幕.srt"), "字幕");
  const ep1Id = insertDownload(ep1, 1);
  const ep2Id = insertDownload(ep2, 2);

  await check("剧集目录出现在列表里", () => {
    const folders = collectFolders();
    const hit = folders.find((f) => f.dir === showA);
    assert.ok(hit, "剧集目录没出现");
    assert.equal(hit.fileCount, 2);
  });

  /* ---------------- 一、彻底删除整个剧集目录 ---------------- */

  const planA = planDelete(showA, "folder", "purge");

  await check("删除计划：视频 / NFO / 图片都算进去", () => {
    assert.equal(planA.videoCount, 2);
    // 两集的单集 NFO + tvshow.nfo
    assert.equal(planA.nfoCount, 3);
    // 一集缩略图 + 剧集海报
    assert.equal(planA.imageCount, 2);
    assert.equal(planA.totalSize > 0, true);
  });

  await check("删除计划：字幕这类其它文件不删但要列出来", () => {
    assert.equal(planA.kept.some((k) => k.name === "字幕.srt"), true);
  });

  await check("删除计划：连带两条下载记录", () => {
    assert.equal(planA.downloadIds.includes(ep1Id), true);
    assert.equal(planA.downloadIds.includes(ep2Id), true);
  });

  const resultA = await executeDelete(planA);

  await check("执行删除：视频、NFO、封面都没了", () => {
    assert.equal(fs.existsSync(ep1), false);
    assert.equal(fs.existsSync(ep2), false);
    assert.equal(fs.existsSync(path.join(showA, "我的剧S01E01.nfo")), false);
    assert.equal(fs.existsSync(path.join(showA, "tvshow.nfo")), false);
    assert.equal(fs.existsSync(path.join(showA, "poster.jpg")), false);
    assert.equal(fs.existsSync(path.join(showA, "我的剧S01E01-thumb.jpg")), false);
  });

  await check("执行删除：其它文件保留，目录也保留", () => {
    assert.equal(fs.existsSync(path.join(showA, "字幕.srt")), true);
    assert.equal(fs.existsSync(showA), true);
  });

  await check("执行删除：下载记录被清掉", () => {
    assert.equal(downloadRows().some((r) => r.id === ep1Id || r.id === ep2Id), false);
    assert.equal(resultA.removedDownloads, 2);
  });

  await check("执行删除：列表里不再有这个剧集", () => {
    assert.equal(collectFolders().some((f) => f.dir === showA), false);
  });

  /* ---------------- 二、只移出列表（磁盘文件保留） ---------------- */

  const media = path.join(root, "手动媒体");
  const showB = path.join(media, "剧A");
  const showC = path.join(media, "剧B");
  const bEp = path.join(showB, "剧AS01E01.mp4");
  const cEp = path.join(showC, "剧BS01E01.mp4");
  write(bEp);
  write(cEp);
  const sourceId = addSource(media, "dir", "手动媒体").id;

  await check("手动来源展开成两个剧集目录", () => {
    const folders = collectFolders();
    assert.equal(folders.some((f) => f.dir === showB), true);
    assert.equal(folders.some((f) => f.dir === showC), true);
  });

  const planB = planDelete(bEp, "file", "unlink");

  await check("单集删除计划：只算它自己和它的副产物", () => {
    assert.equal(planB.videoCount, 1);
    assert.equal(planB.nfoCount, 0);
    assert.equal(planB.items.every((i) => i.path.startsWith(showB)), true);
  });

  const resultB = await executeDelete(planB);

  await check("只移出列表：磁盘文件还在", () => {
    assert.equal(fs.existsSync(bEp), true);
    assert.equal(resultB.removedFiles, 0);
  });

  await check("只移出列表：目录树里不再显示", () => {
    const folders = collectFolders();
    assert.equal(folders.some((f) => f.dir === showB), false);
    assert.equal(folders.some((f) => f.dir === showC), true, "别的剧不该受影响");
  });

  await check("只移出列表：留下隐藏登记", () => {
    assert.equal(isExcluded(bEp), true);
    assert.equal(listExcluded().some((r) => r.path === bEp), true);
  });

  await check("恢复显示：目录树里又回来了", () => {
    restorePath(bEp);
    assert.equal(isExcluded(bEp), false);
    assert.equal(collectFolders().some((f) => f.dir === showB), true);
  });

  /* ---------------- 三、只移出列表（剧集目录） ---------------- */

  const planC = planDelete(showC, "folder", "unlink");

  await check("剧集目录只移出列表：磁盘文件都保留", () => {
    assert.equal(planC.videoCount, 1);
    assert.equal(planC.mode, "unlink");
  });

  await executeDelete(planC);

  await check("剧集目录只移出列表：文件还在但列表里没了", () => {
    assert.equal(fs.existsSync(cEp), true);
    assert.equal(collectFolders().some((f) => f.dir === showC), false);
    assert.equal(collectFolders().some((f) => f.dir === showB), true);
  });

  await check("剧集目录只移出列表：上级来源登记保留", () => {
    assert.equal(listSources().some((s) => s.id === sourceId), true);
  });

  await check("恢复显示：剧集目录重新出现", () => {
    restorePath(showC);
    assert.equal(collectFolders().some((f) => f.dir === showC), true);
  });

  /* ---------------- 四、单集彻底删除 ---------------- */

  const planD = planDelete(bEp, "file", "purge");

  await check("单集彻底删除：连带它的 NFO 与缩略图", () => {
    write(path.join(showB, "剧AS01E01.nfo"), "<tvshow/>");
    write(path.join(showB, "剧AS01E01-thumb.jpg"), "jpg");
    const plan = planDelete(bEp, "file", "purge");
    assert.equal(plan.nfoCount, 1);
    assert.equal(plan.imageCount, 1);
    assert.equal(planD.videoCount, 1);
  });

  await executeDelete(planDelete(bEp, "file", "purge"));

  await check("单集彻底删除：文件与副产物都没了", () => {
    assert.equal(fs.existsSync(bEp), false);
    assert.equal(fs.existsSync(path.join(showB, "剧AS01E01.nfo")), false);
    assert.equal(fs.existsSync(path.join(showB, "剧AS01E01-thumb.jpg")), false);
  });

  await check("单集彻底删除：同目录其它剧不受影响", () => {
    assert.equal(fs.existsSync(cEp), true);
    assert.equal(collectFolders().some((f) => f.dir === showC), true);
  });

  console.log(`\n通过 ${passed} 项删除用例${process.exitCode ? "（存在失败）" : "，全部正常"}\n`);
  // 关掉数据库再删临时目录（SQLite 句柄占着文件时会 EBUSY）
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}

void main();
