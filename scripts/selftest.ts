/**
 * 核心逻辑自检：不依赖 Telegram 网络，验证关键词匹配、媒体解析与路径生成。
 * 运行：npm run selftest
 */
import assert from "node:assert/strict";
import path from "node:path";
import { matchText } from "../server/src/match";
import { extractMedia, groupIdOf, messageText, targetRelativePath } from "../server/src/tg/media";
import { sanitizeSegment, splitKeywords, toNumber } from "../server/src/utils";
import {
  deriveSeriesFromText,
  fallbackFolderName,
  parseCaptionMeta,
  parseFileNameMarks,
  parseSeriesCaption,
  planFileNames,
  stripLegacyIndex,
} from "../server/src/tg/naming";
import {
  channelEntityKey,
  channelMessageLink,
  fixTelegramLink,
  markedChannelId,
  normalizeEntityKey,
  repairNfoText,
} from "../server/src/tg/entity";
import { Subscription } from "../server/src/types";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

function sub(partial: Partial<Subscription>): Subscription {
  return {
    id: 1,
    name: "test",
    keywords: "4K",
    match_mode: "contains",
    channel_ids: "[]",
    enabled: 1,
    created_at: 0,
    ...partial,
  };
}

console.log("\n关键词匹配");
check("包含模式命中", () => {
  const hit = matchText("这是 4k 资源合集", [sub({})], 1);
  assert.equal(hit?.keyword, "4K");
});
check("包含模式不区分大小写", () => {
  assert.ok(matchText("HELLO WORLD 4k", [sub({})], 1));
});
check("未命中返回 null", () => {
  assert.equal(matchText("无关内容", [sub({})], 1), null);
});
check("多个关键词任意命中", () => {
  const hit = matchText("蓝光原盘", [sub({ keywords: "4K, 蓝光, REMUX" })], 1);
  assert.equal(hit?.keyword, "蓝光");
});
check("完整词模式拒绝子串", () => {
  const s = sub({ keywords: "AI", match_mode: "word" });
  assert.equal(matchText("MAIL 系统", [s], 1), null);
  assert.ok(matchText("AI 与大模型", [s], 1));
});
check("正则模式支持分组", () => {
  const s = sub({ keywords: "(1080P|2160P)", match_mode: "regex" });
  assert.ok(matchText("Movie.2160P.mkv", [s], 1));
  assert.equal(matchText("Movie.720P.mkv", [s], 1), null);
});
check("停用的订阅不参与匹配", () => {
  assert.equal(matchText("4k", [sub({ enabled: 0 })], 1), null);
});
check("频道范围限制生效", () => {
  const s = sub({ channel_ids: "[7]" });
  assert.equal(matchText("4k", [s], 1), null);
  assert.ok(matchText("4k", [s], 7));
});

console.log("\n媒体解析");
const photoMessage = {
  id: 11,
  media: {
    className: "MessageMediaPhoto",
    photo: { id: "999", sizes: [{ size: 1024 }, { className: "PhotoSizeProgressive", sizes: [2048, 8192] }] },
  },
};
const videoMessage = {
  id: 22,
  message: "这是 4K 电影",
  media: {
    className: "MessageMediaDocument",
    document: {
      className: "Document",
      id: "777",
      size: "1048576",
      mimeType: "video/x-matroska",
      attributes: [{ className: "DocumentAttributeFilename", fileName: "电影.2160p.mkv" }, { className: "DocumentAttributeVideo" }],
    },
  },
};
const voiceMessage = {
  id: 33,
  media: {
    className: "MessageMediaDocument",
    document: {
      className: "Document",
      id: "888",
      size: 2048,
      mimeType: "audio/ogg",
      attributes: [{ className: "DocumentAttributeAudio", voice: true }],
    },
  },
};

check("照片解析出尺寸与文件名", () => {
  const info = extractMedia(photoMessage);
  assert.equal(info?.kind, "photo");
  assert.equal(info?.fileName, "photo-11.jpg");
  assert.equal(info?.size, 8192);
});
check("视频解析出原始文件名", () => {
  const info = extractMedia(videoMessage);
  assert.equal(info?.kind, "video");
  assert.equal(info?.fileName, "电影.2160p.mkv");
  assert.equal(info?.size, 1048576);
});
check("语音消息识别为 voice", () => {
  const info = extractMedia(voiceMessage);
  assert.equal(info?.kind, "voice");
  assert.equal(info?.fileName, "voice-33.ogg");
});
check("无媒体消息返回 null", () => {
  assert.equal(extractMedia({ id: 1, message: "纯文本" }), null);
});
check("匹配文本包含正文与文件名", () => {
  const text = messageText(videoMessage);
  assert.ok(text.includes("4K"));
  assert.ok(text.includes("电影.2160p.mkv"));
});
check("相册分组 id 提取", () => {
  assert.equal(groupIdOf({ id: 1, groupedId: "123456" }), "123456");
  assert.equal(groupIdOf({ id: 1 }), null);
});

console.log("\n路径与工具");
check("路径模板渲染", () => {
  const rel = targetRelativePath("{date}/{channel}/{name}", {
    date: "2026-10-30",
    channel: "科技日报",
    name: "a.mkv",
    messageId: 5,
  });
  assert.equal(rel, path.join("2026-10-30", "科技日报", "a.mkv"));
});
check("路径穿越被清理", () => {
  const rel = targetRelativePath("{name}", {
    date: "d",
    channel: "c",
    name: "../../etc/passwd",
    messageId: 1,
  });
  assert.equal(rel.includes(".."), false);
});
check("文件名非法字符替换", () => {
  assert.equal(sanitizeSegment('a/b:c*?"<>|'), "a_b_c______");
  assert.equal(sanitizeSegment("   "), "untitled");
});
check("关键词分隔支持中英文标点", () => {
  assert.deepEqual(splitKeywords("4K，蓝光\n教程;资源"), ["4K", "蓝光", "教程", "资源"]);
});
check("big-integer 数值转换", () => {
  assert.equal(toNumber({ toString: () => "123456789" }), 123456789);
  assert.equal(toNumber(undefined), 0);
});

console.log("\n剧集命名与 Emby 元信息");
const caption = `《美人局》第4集 连载中 全系列完整版

简介：美人局......美人的老公是个那方面不行的老头？
年轻力壮的我在店里打工被老板娘盯上，
借着送茶水背着老头找我偷情！

#ai成人短剧 #美人局`;
const albumMedia = [
  { kind: "video" as const, fileName: "VID_001.mp4", mimeType: "video/mp4" },
  ...Array.from({ length: 8 }, (_, i) => ({
    kind: "photo" as const,
    fileName: `photo-${100 + i}.jpg`,
    mimeType: "image/jpeg",
  })),
];

check("正文解析出剧名与集数", () => {
  const info = parseSeriesCaption(caption);
  assert.equal(info?.series, "美人局");
  assert.equal(info?.season, 1);
  assert.deepEqual(info?.episodes, [4]);
});
check("视频按剧集命名", () => {
  const plan = planFileNames(caption, albumMedia, { artCount: 3 });
  assert.equal(plan[0].name, "美人局S01E04.mp4");
  assert.equal(plan[0].dir, "美人局");
});
check("图片只保留 3 张封面，其余跳过", () => {
  const plan = planFileNames(caption, albumMedia, { artCount: 3 });
  const arts = plan.slice(1).filter((p) => p.name && p.name.startsWith(".art-"));
  const skipped = plan.slice(1).filter((p) => p.skip);
  assert.equal(arts.length, 3);
  assert.equal(skipped.length, 5);
  assert.deepEqual(
    arts.map((p) => p.name).sort(),
    [".art-1.jpg", ".art-2.jpg", ".art-3.jpg"],
  );
});
check("封面沿用监控历史里预览过的那几张", () => {
  // artPrefer 的序号按「相册里第几张图」算（0 起），要跳过视频与其它附件
  // 用满 3 个槽位，避免「剩下一张随机挑」让断言时好时坏
  const plan = planFileNames(caption, albumMedia, { artCount: 3, artPrefer: [2, 5, 7] });
  const arts = plan.slice(1).filter((p) => p.name && p.name.startsWith(".art-"));
  assert.equal(arts.length, 3);
  // 第 3、6、8 张图（索引 2、5、7）必须被选中
  assert.ok(plan[3].name?.startsWith(".art-"), "索引 2 的图片应被选为封面");
  assert.ok(plan[6].name?.startsWith(".art-"), "索引 5 的图片应被选为封面");
  assert.ok(plan[8].name?.startsWith(".art-"), "索引 7 的图片应被选为封面");
  assert.equal(plan[1].skip, true, "索引 0 的图片应被跳过");
});
check("Emby 模式下图片一律不下载（封面改由视频截帧）", () => {
  const plan = planFileNames(caption, albumMedia, { skipAttachments: true });
  assert.equal(plan[0].name, "美人局S01E04.mp4");
  // 视频之后的所有图片都必须 skip，且不能留下任何文件名
  const attachments = plan.slice(1);
  assert.equal(attachments.every((p) => p.skip === true), true);
  assert.equal(attachments.every((p) => p.name === null), true);
});
check("纯图集不受 skipAttachments 影响", () => {
  const plan = planFileNames(caption, albumMedia.slice(1), { skipAttachments: true });
  assert.equal(plan.some((p) => p.skip), false);
  assert.equal(plan[0].name, "美人局S01E04-p1.jpg");
});
check("纯图集不做封面裁剪", () => {  const plan = planFileNames(caption, albumMedia.slice(1), { artCount: 3 });
  assert.equal(plan.some((p) => p.skip), false);
  assert.equal(plan[0].name, "美人局S01E04-p1.jpg");
  assert.equal(plan[7].name, "美人局S01E04-p8.jpg");
});

const looseText = "老板今天又发飙了，速看 #日常 完整版 https://t.me/abc/123";
const oneVideo = [{ kind: "video" as const, fileName: "VID_002.mp4", mimeType: "video/mp4" }];

check("认不出剧名：一个链接一个文件夹，名字取正文", () => {
  const plan = planFileNames(looseText, oneVideo, { artCount: 0 });
  assert.equal(plan[0].dir, "老板今天又发飙了，速看 完整版");
  assert.equal(plan[0].name, "老板今天又发飙了，速看 完整版.mp4");
  assert.equal(plan[0].loose, true);
});
check("兜底文件夹重名时加消息 id 后缀", () => {
  const plan = planFileNames(looseText, oneVideo, { artCount: 0, uniqueLooseDir: (b) => `${b}-9001` });
  assert.equal(plan[0].dir, "老板今天又发飙了，速看 完整版-9001");
  assert.equal(plan[0].name, "老板今天又发飙了，速看 完整版-9001.mp4");
});
check("同一链接多个视频按序号区分", () => {
  const plan = planFileNames("两个片段合集", [oneVideo[0], { ...oneVideo[0], fileName: "b.mp4" }], { artCount: 0 });
  assert.deepEqual(plan.map((p) => p.name), ["两个片段合集-01.mp4", "两个片段合集-02.mp4"]);
});
check("解析出集号时不再追加序号后缀", () => {
  // 之前会落成「我的妈妈徐秋曼S01E05-05.mp4」，集号重复了
  const plan = planFileNames("《我的妈妈徐秋曼》S01E05 连载中 全系列完整版", oneVideo, { artCount: 0 });
  assert.equal(plan[0].name, "我的妈妈徐秋曼S01E05.mp4");
  assert.equal(plan[0].dir, "我的妈妈徐秋曼");
  assert.equal(plan[0].episode, 5);
});
check("同一条消息里多个视频按集号排序命名，不带序号", () => {
  const plan = planFileNames("《美人局》第4-5集 连载中", [
    { ...oneVideo[0], fileName: "a.mp4" },
    { ...oneVideo[0], fileName: "b.mp4" },
  ], { artCount: 0 });
  assert.deepEqual(plan.map((p) => p.name), ["美人局S01E04.mp4", "美人局S01E05.mp4"]);
});
check("关掉兜底命名 / 没有视频 / 空正文时不建文件夹", () => {
  assert.equal(planFileNames(looseText, oneVideo, { looseFolder: false })[0].dir, null);
  assert.equal(planFileNames("今天的照片", [{ kind: "photo", fileName: "a.jpg", mimeType: "image/jpeg" }])[0].dir, null);
  assert.equal(planFileNames("", oneVideo)[0].dir, null);
});
check("兜底名字去掉链接、@提及与 #标签", () => {
  assert.equal(fallbackFolderName("#标签 标题在这里 https://t.me/x/1 @someone"), "标题在这里");
});
check("简介与标签提取", () => {
  const meta = parseCaptionMeta(caption);
  assert.ok(meta.plot.includes("老板娘"));
  assert.equal(meta.plot.includes("#"), false);
  assert.deepEqual(meta.tags, ["ai成人短剧", "美人局"]);});

console.log("\n剧集命名：正文与文件名双来源");
const albumCaption = "妈妈我爱你  EP1-10";
const epAlbumMedia = Array.from({ length: 10 }, (_, i) => ({
  kind: "video" as const,
  fileName: `2048真实故事改编 - 妈妈我爱你 第${i + 1}集 - AI短剧.mp4`,
  mimeType: "video/mp4",
}));

check("正文没有书名号时，用集数标记反推剧名", () => {
  assert.equal(deriveSeriesFromText(albumCaption), "妈妈我爱你");
  const info = parseSeriesCaption(albumCaption);
  assert.equal(info?.series, "妈妈我爱你");
  assert.deepEqual(info?.episodes, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(info?.range, { from: 1, to: 10 });
});
check("宣传语不能当剧名", () => {
  // 「连载中 全系列完整版」是宣传语，宁可退回兜底命名
  assert.equal(deriveSeriesFromText("第1集 连载中 全系列完整版 简介：……"), "");
  assert.equal(deriveSeriesFromText("老板今天又发飙了，速看 完整版"), "");
});
check("原始文件名里解析剧名与集数", () => {
  const marks = parseFileNameMarks("2048真实故事改编 - 妈妈我爱你 第3集 - AI短剧.mp4");
  assert.equal(marks.series, "妈妈我爱你");
  assert.equal(marks.episode, 3);
  assert.equal(parseFileNameMarks("VID_001.mp4").series, "");
});
check("相册逐集编号 S01E01 ~ S01E10", () => {
  const plan = planFileNames(albumCaption, epAlbumMedia, { artCount: 0, messageCount: 10 });
  assert.deepEqual(
    plan.map((p) => p.name),
    Array.from({ length: 10 }, (_, i) => `妈妈我爱你S01E${String(i + 1).padStart(2, "0")}.mp4`),
  );
  assert.equal(plan[0].dir, "妈妈我爱你");
  assert.deepEqual(plan.map((p) => p.episode), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
check("一个视频含多集时用范围名 S01E01-E10", () => {
  const plan = planFileNames(albumCaption, [epAlbumMedia[0]], { artCount: 0, messageCount: 1 });
  assert.equal(plan[0].name, "妈妈我爱你S01E01-E10.mp4");
  const merged = planFileNames(
    "妈妈我爱你 合集",
    [{ kind: "video" as const, fileName: "妈妈我爱你 EP1-10.mp4", mimeType: "video/mp4" }],
    { artCount: 0, messageCount: 1 },
  );
  assert.equal(merged[0].name, "妈妈我爱你S01E01-E10.mp4");
  assert.equal(merged[0].dir, "妈妈我爱你");
});
check("认不出剧名时仍然一个链接一个文件夹", () => {
  const plan = planFileNames(looseText, oneVideo, { artCount: 0 });
  assert.equal(plan[0].dir, "老板今天又发飙了，速看 完整版");
  assert.equal(plan[0].loose, true);
});

console.log("\n频道实体标识");
check("裸号频道 ID 转成 -100 标记形式", () => {
  // 裸号会被 gramjs 当成用户 ID 去查，报 PeerUser 找不到
  assert.equal(markedChannelId("4457697592"), "-1004457697592");
  assert.equal(markedChannelId("-1004457697592"), "-1004457697592");
  assert.equal(markedChannelId("-4457697592"), "-1004457697592");
  assert.equal(markedChannelId(""), null);
  assert.equal(markedChannelId("ASC2256"), null);
});
check("频道实体键优先用 username，其次标记 ID", () => {
  assert.equal(channelEntityKey({ username: "ASC2256", tg_id: "3894893955" }), "ASC2256");
  assert.equal(channelEntityKey({ username: null, tg_id: "4457697592" }), "-1004457697592");
  assert.equal(channelEntityKey({ username: null, tg_id: null }), "");
});
check("实体键归一化：裸数字一律转标记形式", () => {
  assert.equal(normalizeEntityKey("4457697592"), "-1004457697592");
  assert.equal(normalizeEntityKey("ASC2256"), "ASC2256");
  assert.equal(normalizeEntityKey("-1004457697592"), "-1004457697592");
});
check("私有频道消息链接走 t.me/c/", () => {
  assert.equal(
    channelMessageLink({ username: null, tg_id: "4457697592" }, 1373),
    "https://t.me/c/4457697592/1373",
  );
  assert.equal(
    channelMessageLink({ username: "ASC2256", tg_id: "3894893955" }, 10500),
    "https://t.me/ASC2256/10500",
  );
});

console.log("\n历史命名修复");
check("旧版多出来的 -NN 序号被去掉", () => {
  assert.equal(stripLegacyIndex("我的妈妈徐秋曼S01E02-02.mp4"), "我的妈妈徐秋曼S01E02.mp4");
  assert.equal(stripLegacyIndex("美人局S01E04-04.nfo"), "美人局S01E04.nfo");
  assert.equal(stripLegacyIndex("我的妈妈徐秋曼S01E01.mp4"), null);
  assert.equal(stripLegacyIndex(".art-1373-1.jpg"), null);
  assert.equal(stripLegacyIndex("老板今天又发飙了-01.mp4"), null);
});
check("私有频道的失效链接改成 t.me/c/", () => {
  assert.equal(fixTelegramLink("https://t.me/4457697592/1374"), "https://t.me/c/4457697592/1374");
  assert.equal(fixTelegramLink("https://t.me/ASC2256/10500"), "https://t.me/ASC2256/10500");
  assert.equal(fixTelegramLink(null), null);
});
check("nfo 里的失效链接就地修正（tvshow / 剧集通用）", () => {
  const text = [
    '  <uniqueid type="tgsub" default="true">tgsub:我的妈妈徐秋曼</uniqueid>',
    '  <uniqueid type="telegram">https://t.me/4457697592/1374</uniqueid>',
  ].join("\n");
  const fixed = repairNfoText(text);
  assert.ok(fixed.includes("https://t.me/c/4457697592/1374"));
  assert.equal(fixed.includes("https://t.me/4457697592/"), false);
  // 公开频道的链接不受影响
  assert.equal(repairNfoText('<uniqueid type="telegram">https://t.me/ASC2256/105</uniqueid>'),
    '<uniqueid type="telegram">https://t.me/ASC2256/105</uniqueid>');
  // 幂等
  assert.equal(repairNfoText(fixed), fixed);
});

/** 文件类用例：需要 await，单独提供异步断言入口 */
async function acheck(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    console.error(`  \u2717 ${name}`);
    console.error(`    ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

/** 剧集目录拆分：手动添加上级目录时按剧集文件夹展开 */
async function seriesDirChecks(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const { collectSeriesDirs, isSeasonDir } = await import("../server/src/tg/mediatree");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tgsub-tree-"));
  const touch = async (rel: string): Promise<void> => {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, "x");
  };

  // 短剧/美人局/S01E01.mp4、短剧/美人局/S01E02.mp4、短剧/我的妈妈徐秋曼/S01E01.mp4
  await touch("短剧/美人局/美人局S01E01.mp4");
  await touch("短剧/美人局/美人局S01E02.mp4");
  await touch("短剧/我的妈妈徐秋曼/我的妈妈徐秋曼S01E01.mp4");
  // 季目录结构：剧名/Season 01/ep.mkv
  await touch("季结构/我的剧/Season 01/我的剧S01E01.mp4");
  await touch("季结构/我的剧/Season 01/我的剧S01E02.mp4");

  await acheck("手动目录按剧集文件夹拆开", async () => {
    const series = collectSeriesDirs(path.join(root, "短剧"));
    const names = series.map((s) => path.basename(s.dir)).sort();
    assert.deepEqual(names, ["我的妈妈徐秋曼", "美人局"]);
    // 每部剧只收自己的视频，不串味
    const mei = series.find((s) => path.basename(s.dir) === "美人局");
    assert.equal(mei?.files.length, 2);
  });

  await acheck("剧集目录本身有视频时不再往下拆", async () => {
    const series = collectSeriesDirs(path.join(root, "短剧", "美人局"));
    assert.equal(series.length, 1);
    assert.equal(series[0].dir, path.join(root, "短剧", "美人局"));
    assert.equal(series[0].files.length, 2);
  });

  await acheck("季目录结构归到剧名目录下", async () => {
    const series = collectSeriesDirs(path.join(root, "季结构", "我的剧"));
    assert.equal(series.length, 1);
    assert.equal(series[0].dir, path.join(root, "季结构", "我的剧"));
    assert.equal(series[0].files.length, 2);
  });

  check("季目录名识别", () => {
    assert.equal(isSeasonDir("Season 01"), true);
    assert.equal(isSeasonDir("S01"), true);
    assert.equal(isSeasonDir("第1季"), true);
    assert.equal(isSeasonDir("美人局"), false);
    assert.equal(isSeasonDir("Season"), false);
  });

  await fs.rm(root, { recursive: true, force: true });
}

/**
 * 挂载目录权限检查（NAS 反复重启的根因）。
 *
 * 这里验证三件事：
 *  1. 可写目录能被探针文件识别出来；
 *  2. 不可写目录能识别出来（Linux 上靠 chmod 制造只读目录；
 *     Windows 不支持这种权限语义，跳过该断言但仍校验提示文案）；
 *  3. 权限提示文案里包含用户真正需要的信息：目录、当前身份、解决办法。
 */
async function permissionChecks(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const { isDirWritable, explainPermissionProblem } = await import("../server/src/env");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tgsub-perm-"));

  await acheck("可写目录被正确识别", async () => {
    assert.equal(isDirWritable(root), true);
  });

  await acheck("不可写目录被正确识别", async () => {
    const ro = path.join(root, "readonly");
    await fs.mkdir(ro);
    try {
      await fs.chmod(ro, 0o500);
    } catch {
      return; // Windows 上没有 POSIX 权限位，无法制造只读目录
    }
    // Windows 的 chmod 不会真正拒绝写入，只有 Linux 上才能验证这一点
    if (process.platform === "win32") {
      await fs.chmod(ro, 0o700);
      return;
    }
    const writable = isDirWritable(ro);
    await fs.chmod(ro, 0o700); // 还原，避免 rm 失败
    assert.equal(writable, false);
  });

  await acheck("权限提示包含目录、身份与解决办法", async () => {
    const text = explainPermissionProblem("/data", "数据目录");
    assert.ok(text.includes("/data"), "应指出具体目录");
    assert.ok(text.includes("数据目录"), "应说明目录用途");
    assert.ok(text.includes("uid="), "应说明当前进程身份");
    assert.ok(text.includes("chown"), "应给出 chown 解决办法");
    assert.ok(text.includes("PUID"), "应提示 PUID/PGID 方案");
  });

  await fs.rm(root, { recursive: true, force: true });
}

/**
 * 日志存储自检：
 *  1. pino JSON 行能解析成结构化条目（级别、消息、附加字段）；
 *  2. 级别过滤与关键词搜索能正确筛出目标条目；
 *  3. 落盘的文件能重新回灌进内存缓冲。
 */
async function logStoreChecks(): Promise<void> {
  const { queryLogs, clearMemory, hydrateFromFile, logFilePath } = await import(
    "../server/src/lib/logstore"
  );
  const fs = await import("node:fs");
  const path = await import("node:path");

  // 用真实的 pino 写一份日志，走完整的写入 → 解析链路
  const { logger } = await import("../server/src/logger");
  clearMemory();
  logger.info({ probe: "hello", code: "TEST_CODE" }, "这是一条测试日志");
  logger.warn({ probe: "warn" }, "这是一条警告日志");
  logger.error({ probe: "error" }, "这是一条错误日志");

  // 同步写盘，等一小会儿确保流已刷出
  await new Promise((r) => setTimeout(r, 150));

  await acheck("日志能被解析成结构化条目", async () => {
    const res = queryLogs({ limit: 50 });
    assert.ok(res.total >= 3, `至少应有 3 条日志，实际 ${res.total}`);
    const hit = res.items.find((i) => i.msg.includes("这是一条测试日志"));
    assert.ok(hit, "应能按消息找到目标日志");
    assert.equal(hit!.level, "info");
    assert.equal(hit!.fields.probe, "hello");
    assert.equal(hit!.fields.code, "TEST_CODE");
    assert.ok(hit!.time > 0, "应解析出时间戳");
  });

  await acheck("级别过滤只返回该级别及以上的日志", async () => {
    const res = queryLogs({ level: "error", limit: 50 });
    assert.ok(res.total >= 1);
    for (const item of res.items) {
      assert.ok(
        item.level === "error" || item.level === "fatal",
        `级别过滤后不应出现 ${item.level}`,
      );
    }
  });

  await acheck("关键词搜索能命中消息与附加字段", async () => {
    const byMsg = queryLogs({ keyword: "这是一条警告日志", limit: 50 });
    assert.equal(byMsg.total, 1);
    const byField = queryLogs({ keyword: "TEST_CODE", limit: 50 });
    assert.ok(byField.total >= 1, "应能按附加字段搜索");
  });

  await acheck("日志文件已落盘且可重新回灌", async () => {
    const file = logFilePath();
    assert.ok(fs.existsSync(file), "日志文件应存在");
    assert.ok(queryLogs({ limit: 500 }).total > 0);
    clearMemory();
    assert.equal(queryLogs({ limit: 10 }).total, 0, "清空后内存缓冲应为空");
    const loaded = hydrateFromFile();
    assert.ok(loaded > 0, "应能从文件回灌出日志");
    assert.ok(queryLogs({ limit: 500 }).total > 0, "回灌后应能查到日志");
  });

  await acheck("分页参数生效", async () => {
    const all = queryLogs({ limit: 500 });
    if (all.total < 2) return;
    const first = queryLogs({ limit: 1, offset: 0 });
    const second = queryLogs({ limit: 1, offset: 1 });
    assert.equal(first.items.length, 1);
    assert.equal(second.items.length, 1);
    assert.notEqual(
      `${first.items[0].time}${first.items[0].msg}`,
      `${second.items[0].time}${second.items[0].msg}`,
    );
  });

  // 清理测试产生的日志文件，避免污染真实日志目录
  try {
    const dir = path.dirname(logFilePath());
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith("app.log")) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    /* ignore */
  }
  clearMemory();
}

/**
 * ffmpeg -i 解析器：镜像里不再内置 ffprobe 二进制（省 75MB），
 * 元数据探测改走 `ffmpeg -i` 的 stderr 解析，这里验证解析结果与 ffprobe 一致。
 */
async function ffmpegProbeChecks(): Promise<void> {
  const { parseFfmpegProbe } = await import("../server/src/tg/ffmpeg");

  // 真实 `ffmpeg -i` 输出样本（5 秒 1280x720 25fps h264 + aac）
  const stderr = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'C:/tmp/sample.mp4':",
    "  Metadata:",
    "    encoder         : Lavf58.24.101",
    "  Duration: 00:00:05.02, start: 0.000000, bitrate: 396 kb/s",
    "    Stream #0:0(und): Video: h264 (Constrained Baseline) (avc1 / 0x31637661), yuv420p, 1280x720 [SAR 1:1 DAR 16:9], 316 kb/s, 25 fps, 25 tbr, 12800 tbn, 50 tbc (default)",
    "    Metadata:",
    "      handler_name    : VideoHandler",
    "    Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 74 kb/s (default)",
    "At least one output file must be specified",
  ].join("\n");

  await acheck("ffmpeg -i 能解析出时长/分辨率/编码", async () => {
    const probe = parseFfmpegProbe(stderr);
    assert.ok(probe, "解析结果不应为 null");
    assert.equal(probe.width, 1280);
    assert.equal(probe.height, 720);
    assert.equal(probe.videoCodec, "h264");
    assert.equal(probe.audioCodec, "aac");
    assert.equal(probe.fps, 25);
    assert.equal(probe.container, "mov,mp4,m4a,3gp,3g2,mj2");
    // 时长 00:00:05.02 → 5.02 秒
    assert.ok(Math.abs((probe.duration ?? 0) - 5.02) < 0.01, `duration=${probe.duration}`);
  });

  await acheck("ffmpeg 解析的码率换算成 bit/s（与 ffprobe 同量纲）", async () => {
    const probe = parseFfmpegProbe(stderr);
    // ffmpeg 报 396 kb/s → 396000 bit/s；ffprobe 报 398201（整数 kb/s 舍入误差内）
    assert.equal(probe?.bitrate, 396000);
  });

  await acheck("只有视频流没有音频流时也能解析", async () => {
    const only = [
      "Input #0, matroska,webm, from 'a.mkv':",
      "  Duration: 00:02:00.00, start: 0.000000, bitrate: 1200 kb/s",
      "    Stream #0:0: Video: hevc (Main), yuv420p(tv), 3840x2160 [SAR 1:1 DAR 16:9], 60 fps, 60 tbr",
    ].join("\n");
    const probe = parseFfmpegProbe(only);
    assert.ok(probe);
    assert.equal(probe.videoCodec, "hevc");
    assert.equal(probe.width, 3840);
    assert.equal(probe.height, 2160);
    assert.equal(probe.fps, 60);
    assert.equal(probe.audioCodec, null);
    assert.equal(probe.duration, 120);
  });

  await acheck("非媒体文件解析为 null 而不是抛错", async () => {
    assert.equal(parseFfmpegProbe(""), null);
    assert.equal(parseFfmpegProbe("Invalid data found when processing input"), null);
  });
}

async function embyChecks(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const crypto = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const runFfmpeg = promisify(execFile);
  const { default: sharp } = await import("sharp");
  const { encodeMeta, finalizeMedia } = await import("../server/src/tg/emby");
  const { autoCoversFromVideo } = await import("../server/src/tg/autocover");
  const { ffmpegInfo } = await import("../server/src/tg/ffmpeg");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tgsub-emby-"));

  // 老版本会把消息里的图片下成 .art-N.jpg 当封面素材，升级后应被自动清理
  for (const item of [
    { file: ".art-1.jpg", width: 1920, height: 1080 },
    { file: ".art-2.jpg", width: 1080, height: 1920 },
    { file: ".art-3.jpg", width: 1280, height: 720 },
  ]) {
    await sharp({
      create: { width: item.width, height: item.height, channels: 3, background: { r: 30, g: 40, b: 60 } },
    })
      .jpeg()
      .toFile(path.join(dir, item.file));
  }

  const video = path.join(dir, "美人局S01E04.mp4");
  await fs.writeFile(video, "fake");

  const meta = {
    series: "美人局",
    season: 1,
    episode: 4,
    firstLine: "《美人局》第4集 连载中 全系列完整版",
    plot: parseCaptionMeta(caption).plot,
    tags: parseCaptionMeta(caption).tags,
    studio: "AI成人短剧 免费看 【黄果短剧】",
    link: "https://t.me/ASC2256/10500",
    airedAt: Date.parse("2026-10-31T12:00:00Z"),
    messageId: 10500,
    kind: "video" as const,
  };

  await finalizeMedia(video, encodeMeta(meta));

  await acheck("剧集 nfo 含集数、简介与标签", async () => {
    const nfo = await fs.readFile(path.join(dir, "美人局S01E04.nfo"), "utf8");
    assert.ok(nfo.includes("<episode>4</episode>"));
    assert.ok(nfo.includes("<showtitle>美人局</showtitle>"));
    assert.ok(nfo.includes("老板娘"));
    assert.ok(nfo.includes("<tag>ai成人短剧</tag>"));
  });
  await acheck("剧集目录写入 tvshow.nfo", async () => {
    const show = await fs.readFile(path.join(dir, "tvshow.nfo"), "utf8");
    assert.ok(show.includes("<tvshow>"));
    assert.ok(show.includes("<title>美人局</title>"));
  });
  await acheck("老版本临时封面图被清理，不会混进媒体库", async () => {
    const left = (await fs.readdir(dir)).filter((n) => n.startsWith(".art-"));
    assert.equal(left.length, 0);
  });
  await acheck("假视频截帧失败不抛错、也不留半成品", async () => {
    const files = await fs.readdir(dir);
    assert.ok(!files.some((n) => n.endsWith("-thumb.jpg")));
  });

  const info = await ffmpegInfo();
  if (!info.available) {
    console.log("  - 跳过截帧用例（ffmpeg 不可用）");
    await fs.rm(dir, { recursive: true, force: true });
    return;
  }

  const clipA = path.join(dir, "clipA.mp4");
  const clipB = path.join(dir, "clipB.mp4");
  const sources: Array<[string, string]> = [
    ["testsrc=size=640x360:rate=25", clipA],
    ["smptebars=size=640x360:rate=25", clipB],
  ];
  for (const [src, out] of sources) {
    await runFfmpeg(
      info.ffmpeg as string,
      ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", src, "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "mpeg4", out],
      { timeout: 120_000 },
    );
  }

  const sha1 = async (file: string): Promise<string> => {
    const buf = await fs.readFile(file);
    return crypto.createHash("sha1").update(buf).digest("hex");
  };

  const madeFirst = await autoCoversFromVideo(clipA, dir, { base: "美人局S01E01", isFirst: true });
  await acheck("第一集生成单集缩略图与三张剧集封面", async () => {
    assert.ok(madeFirst.includes("美人局S01E01-thumb.jpg"), "缺单集缩略图");
    assert.ok(madeFirst.includes("poster.jpg"), "缺 poster");
    assert.ok(madeFirst.includes("landscape.jpg"), "缺 landscape");
    assert.ok(madeFirst.includes("fanart.jpg"), "缺 fanart");
  });
  await acheck("缩略图保持视频原始比例且不超过 1280 宽", async () => {
    const thumb = await sharp(path.join(dir, "美人局S01E01-thumb.jpg")).metadata();
    assert.equal(thumb.width, 640);
    assert.equal(thumb.height, 360);
  });
  await acheck("剧集封面尺寸符合 Emby 规格", async () => {
    const poster = await sharp(path.join(dir, "poster.jpg")).metadata();
    assert.deepEqual([poster.width, poster.height], [1000, 1500]);
    const landscape = await sharp(path.join(dir, "landscape.jpg")).metadata();
    assert.deepEqual([landscape.width, landscape.height], [1920, 1080]);
    const fanart = await sharp(path.join(dir, "fanart.jpg")).metadata();
    assert.deepEqual([fanart.width, fanart.height], [1920, 1080]);
  });

  const posterBefore = await sha1(path.join(dir, "poster.jpg"));
  const madeSecond = await autoCoversFromVideo(clipB, dir, { base: "美人局S01E02", isFirst: false });
  await acheck("第二集只生成自己的缩略图，不动剧集封面", async () => {
    assert.ok(madeSecond.includes("美人局S01E02-thumb.jpg"), "第二集缺缩略图");
    assert.ok(!madeSecond.includes("poster.jpg"), "非第一集不该重做剧集封面");
    assert.equal(await sha1(path.join(dir, "poster.jpg")), posterBefore);
  });

  const madeAgain = await autoCoversFromVideo(clipB, dir, { base: "美人局S01E01", isFirst: true });
  await acheck("第一集重跑时覆盖剧集封面（目录图始终同第一集）", async () => {
    assert.ok(madeAgain.includes("poster.jpg"));
    assert.ok(!madeAgain.includes("美人局S01E01-thumb.jpg"), "缩略图已存在不该重做");
    assert.notEqual(await sha1(path.join(dir, "poster.jpg")), posterBefore);
  });

  await fs.rm(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  try {
    await seriesDirChecks();
  } catch (err) {
    console.error(`  \u2717 剧集目录用例异常: ${(err as Error).message}`);
    process.exitCode = 1;
  }
  try {
  try {
  try {
    await logStoreChecks();
  } catch (err) {
    console.error(`  \u2717 \u65e5\u5fd7\u5b58\u50a8\u7528\u4f8b\u5f02\u5e38: ${(err as Error).message}`);
    process.exitCode = 1;
  }
    await permissionChecks();
  } catch (err) {
    console.error(`  \u2717 \u6743\u9650\u68c0\u67e5\u7528\u4f8b\u5f02\u5e38: ${(err as Error).message}`);
    process.exitCode = 1;
  }
    await embyChecks();
  } catch (err) {
    console.error(`  \u2717 Emby 用例异常: ${(err as Error).message}`);
    process.exitCode = 1;
  }
  try {
    await ffmpegProbeChecks();
  } catch (err) {
    console.error(`  \u2717 ffmpeg 解析用例异常: ${(err as Error).message}`);
    process.exitCode = 1;
  }
  console.log(`\n通过 ${passed} 项自检${process.exitCode ? "（存在失败）" : "，全部正常"}\n`);
}

void main();
