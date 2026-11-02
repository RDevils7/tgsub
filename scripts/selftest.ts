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
  ordinalFromFileName,
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
import { mapEmbyPath, normalizeEmbyUrl, parsePathMap } from "../server/src/tg/embypath";
import {
  coverGroupKey,
  humanBytes as humanCacheBytes,
  selectEvictions,
  type CacheGroup,
} from "../server/src/lib/cacheplan";
import {
  explainProxyProblem,
  normalizeProxyUrl,
  parseProxy,
  telegramProxyUnsupported,
} from "../server/src/lib/netprobe";

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
check("中文数字集数也能认", () => {
  assert.deepEqual(parseSeriesCaption("《美人局》第一集 连载中")?.episodes, [1]);
  assert.deepEqual(parseSeriesCaption("《美人局》第十二集 连载中")?.episodes, [12]);
  assert.deepEqual(parseSeriesCaption("《美人局》第一至三集 连载中")?.episodes, [1, 2, 3]);
});

check("从原始文件名里取裸序号", () => {
  assert.equal(ordinalFromFileName("01.mp4"), 1);
  assert.equal(ordinalFromFileName("02 - 片段.mp4"), 2);
  assert.equal(ordinalFromFileName("片段_03.mp4"), 3);
  assert.equal(ordinalFromFileName("美人局 12.mp4"), 12);
  // 数字后面直接跟着文字时不是序号
  assert.equal(ordinalFromFileName("2048真实故事改编 - 妈妈我爱你.mp4"), null);
  assert.equal(ordinalFromFileName("1080p.mp4"), null);
  assert.equal(ordinalFromFileName("S01E02.mp4"), null);
  assert.equal(ordinalFromFileName("VID_20240101_1203.mp4"), null);
  // Telegram 客户端的 video-123.mp4 / 我们自己合成的 photo-456.jpg：数字是 id，不是序号
  assert.equal(ordinalFromFileName("video-123.mp4"), null);
  assert.equal(ordinalFromFileName("photo-456.jpg"), null);
  // 超过集数尺度的数字不算
  assert.equal(ordinalFromFileName("片段 128.mp4"), null);
});

check("一个链接多个视频按原始文件名顺序对集号", () => {
  // 相册的消息顺序是 04/02/03/01，真实顺序要看文件名
  const plan = planFileNames("《美人局》第1-4集 连载中", [
    { ...oneVideo[0], fileName: "04.mp4" },
    { ...oneVideo[0], fileName: "02.mp4" },
    { ...oneVideo[0], fileName: "03.mp4" },
    { ...oneVideo[0], fileName: "01.mp4" },
  ], { artCount: 0 });
  assert.deepEqual(plan.map((p) => p.name), [
    "美人局S01E04.mp4",
    "美人局S01E02.mp4",
    "美人局S01E03.mp4",
    "美人局S01E01.mp4",
  ]);
  assert.deepEqual(plan.map((p) => p.episode), [4, 2, 3, 1]);
});

check("正文没写集数时用文件名序号当集号", () => {
  const plan = planFileNames("《美人局》第四集 连载中", [
    { ...oneVideo[0], fileName: "3 - 片段.mp4" },
    { ...oneVideo[0], fileName: "1 - 片段.mp4" },
    { ...oneVideo[0], fileName: "2 - 片段.mp4" },
  ], { artCount: 0 });
  // 正文声明了第4集但视频有 3 个：按文件名序号从 4 顺延，而不是按相册顺序
  assert.deepEqual(plan.map((p) => p.episode), [6, 4, 5]);
  assert.deepEqual(plan.map((p) => p.name), [
    "美人局S01E06.mp4",
    "美人局S01E04.mp4",
    "美人局S01E05.mp4",
  ]);
});

check("正文没写集数时序号直接当集号", () => {
  const plan = planFileNames("《美人局》连载中", [
    { ...oneVideo[0], fileName: "03.mp4" },
    { ...oneVideo[0], fileName: "01.mp4" },
    { ...oneVideo[0], fileName: "02.mp4" },
  ], { artCount: 0 });
  assert.deepEqual(plan.map((p) => p.name), [
    "美人局S01E03.mp4",
    "美人局S01E01.mp4",
    "美人局S01E02.mp4",
  ]);
});

check("文件名里的中文数字集号", () => {
  const plan = planFileNames("《美人局》连载中", [
    { ...oneVideo[0], fileName: "美人局 第二集.mp4" },
    { ...oneVideo[0], fileName: "美人局 第一集.mp4" },
  ], { artCount: 0 });
  assert.deepEqual(plan.map((p) => p.episode), [2, 1]);
  assert.deepEqual(plan.map((p) => p.name), ["美人局S01E02.mp4", "美人局S01E01.mp4"]);
});

check("序号跨度太大时不采信", () => {
  // 三个文件名里的数字差了几百，不像「一集一个文件」的序号，按消息顺序来
  const plan = planFileNames("《美人局》第1-3集 连载中", [
    { ...oneVideo[0], fileName: "美人局 31.mp4" },
    { ...oneVideo[0], fileName: "美人局 3.mp4" },
    { ...oneVideo[0], fileName: "美人局 88.mp4" },
  ], { artCount: 0 });
  assert.deepEqual(plan.map((p) => p.episode), [1, 2, 3]);
});

check("文件名序号重复或缺失时退回消息顺序", () => {
  const dup = planFileNames("《美人局》第1-3集 连载中", [
    { ...oneVideo[0], fileName: "01.mp4" },
    { ...oneVideo[0], fileName: "01.mp4" },
    { ...oneVideo[0], fileName: "02.mp4" },
  ], { artCount: 0 });
  assert.deepEqual(dup.map((p) => p.episode), [1, 2, 3]);
  // 有一个文件没序号，整体不采信
  const partial = planFileNames("《美人局》第1-3集 连载中", [
    { ...oneVideo[0], fileName: "03.mp4" },
    { ...oneVideo[0], fileName: "video.mp4" },
    { ...oneVideo[0], fileName: "01.mp4" },
  ], { artCount: 0 });
  assert.deepEqual(partial.map((p) => p.episode), [1, 2, 3]);
});

check("认不出剧名时序号后缀也按原文件名排", () => {
  const plan = planFileNames("老板今天又发飙了，速看 #日常 完整版 https://t.me/abc/123", [
    { ...oneVideo[0], fileName: "2.mp4" },
    { ...oneVideo[0], fileName: "1.mp4" },
  ], { artCount: 0 });
  assert.deepEqual(plan.map((p) => p.name.endsWith("-01.mp4")), [false, true]);
  assert.equal(plan[0].name, "老板今天又发飙了，速看 完整版-02.mp4");
  assert.equal(plan[1].name, "老板今天又发飙了，速看 完整版-01.mp4");
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

console.log("\nEmby 入库：地址与路径映射");

function embyNotifyChecks(): void {
  // 地址规整：用户常见填法都要能落到同一个根地址
  check("地址补协议并去掉末尾斜杠", () => {
    assert.equal(normalizeEmbyUrl("192.168.1.10:8096"), "http://192.168.1.10:8096");
    assert.equal(normalizeEmbyUrl("  http://192.168.1.10:8096/  "), "http://192.168.1.10:8096");
    assert.equal(normalizeEmbyUrl("https://emby.example.com/"), "https://emby.example.com");
  });
  check("地址去掉管理页后缀 /web", () => {
    assert.equal(normalizeEmbyUrl("http://192.168.1.10:8096/web/index.html"), "http://192.168.1.10:8096");
    assert.equal(normalizeEmbyUrl("http://192.168.1.10:8096/web"), "http://192.168.1.10:8096");
    // /webhooks 不是管理页，别误伤
    assert.equal(normalizeEmbyUrl("http://h:8096/webhooks"), "http://h:8096/webhooks");
  });
  check("空地址返回空串", () => {
    assert.equal(normalizeEmbyUrl("   "), "");
  });

  // 映射规则解析：空格、箭头、中文冒号都要认
  check("解析路径映射的多种写法", () => {
    const rules = parsePathMap("/downloads=/volume1/media/tgsub\n/tmp -> /mnt/tmp\n/data：/mnt/data\n# 注释\n无用行");
    assert.equal(rules.length, 3);
    assert.deepEqual(
      rules.map((r) => r.from).sort(),
      ["/data", "/downloads", "/tmp"],
    );
    assert.equal(parsePathMap("").length, 0);
  });
  check("长前缀优先匹配", () => {
    const rules = parsePathMap("/media=/mnt/a\n/media/tgsub=/mnt/b");
    assert.equal(rules[0].from, "/media/tgsub");
  });

  // 路径映射本体
  check("映射到 Emby 视角的路径", () => {
    const rules = parsePathMap("/downloads=/volume1/media/tgsub");
    assert.equal(
      mapEmbyPath("/downloads/美人局/美人局S01E04.mp4", rules),
      "/volume1/media/tgsub/美人局/美人局S01E04.mp4",
    );
  });
  check("目录本身也能映射", () => {
    const rules = parsePathMap("/downloads=/volume1/media/tgsub");
    assert.equal(mapEmbyPath("/downloads", rules), "/volume1/media/tgsub");
    assert.equal(mapEmbyPath("/downloads/", rules), "/volume1/media/tgsub");
  });
  check("前缀相近的目录不被误判", () => {
    const rules = parsePathMap("/downloads=/mnt/a");
    // /downloads-old 不是 /downloads 的子目录
    assert.equal(mapEmbyPath("/downloads-old/x.mp4", rules), "/downloads-old/x.mp4");
  });
  check("没配映射时原样提交", () => {
    assert.equal(mapEmbyPath("/downloads/a/b.mp4", []), "/downloads/a/b.mp4");
  });
  check("Windows 盘符映射用反斜杠", () => {
    const rules = parsePathMap("D:\\media=D:\\Emby\\media");
    assert.equal(mapEmbyPath("D:\\media\\剧\\01.mp4", rules), "D:\\Emby\\media\\剧\\01.mp4");
  });
  check("密钥掩码不会被当成真密钥", () => {
    // 前端把 •••••••• 回传时，服务端应视为「保持不变」
    const isMask = (v: string) => /^•+$/.test(v);
    assert.equal(isMask("••••••••"), true);
    assert.equal(isMask("a1b2c3d4"), false);
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
  const { encodeMeta, finalizeMedia, buildWritePermissionHint, isPermissionError } = await import(
    "../server/src/tg/emby"
  );
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

  await acheck("权限不足的诊断先说清视频已落盘，再给改属主办法", async () => {
    const err = Object.assign(new Error("EACCES: permission denied, open '/downloads/x/x.nfo'"), { code: "EACCES" });
    assert.equal(isPermissionError(err), true);
    const text = buildWritePermissionHint(dir, "美人局S01E04.nfo", err);
    assert.ok(text.includes("视频已落盘"), "要先说明视频没丢，只是元数据没写进去");
    assert.ok(text.includes(dir), "要指出具体目录");
    assert.ok(text.includes("uid="), "要说明运行身份与目录属主");
    assert.ok(text.includes("chown"), "要给出 chown 解决办法");
    assert.ok(text.includes("CHOWN_RECURSE"), "要提示 CHOWN_RECURSE 一次性修历史文件");
  });

  await acheck("只读挂载点单独提示去掉 :ro", async () => {
    const err = Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    const text = buildWritePermissionHint(dir, "a.nfo", err);
    assert.ok(text.includes(":ro"));
    assert.ok(!text.includes("CHOWN_RECURSE"), "只读挂载不是属主问题，别给错方向");
  });

  await acheck("非权限错误不归到权限问题", async () => {
    // 磁盘满 / 路径过长这些不该建议改属主
    assert.equal(isPermissionError(Object.assign(new Error("x"), { code: "ENOSPC" })), false);
    assert.equal(isPermissionError(new Error("no code")), false);
  });

  await acheck("目录被改成只读时自动补权限并补写 nfo", async () => {
    if (process.platform === "win32") return; // Windows 没有 POSIX 权限位，无法复现
    const roDir = path.join(dir, "ro-case");
    await fs.mkdir(roDir);
    // 老版本以 root 跑过 / 同步工具改权限的典型现场：属主是自己，但少了写位
    const roVideo = path.join(roDir, "只读测试S01E01.mp4");
    await fs.writeFile(roVideo, "fake");
    await fs.chmod(roDir, 0o500);
    try {
      await finalizeMedia(roVideo, encodeMeta({ ...meta, series: "只读测试", episode: 1 }));
    } finally {
      await fs.chmod(roDir, 0o700);
    }
    const files = await fs.readdir(roDir);
    assert.ok(files.includes("只读测试S01E01.nfo"), "应自动补上写权限并写入 nfo");
  });

  await fs.rm(dir, { recursive: true, force: true });
}

console.log("\n缓存：分组、上限与清理顺序");

const MB = 1024 * 1024;

/** 造一个缓存组：mb 是大小，mtime 是最后写入时间 */
function cacheGroup(key: string, mb: number, mtime: number): CacheGroup {
  return { key, scope: "covers", paths: [`/tmp/${key}`], bytes: mb * MB, files: 1, mtime };
}

function cacheChecks(): void {
  check("缓存分组：同一条消息的几张图算一组", () => {
    assert.equal(coverGroupKey("1-10538-1.jpg"), "1-10538");
    assert.equal(coverGroupKey("1-10538-3.jpg"), "1-10538");
    assert.equal(coverGroupKey("1-10538.json"), "1-10538");
    // 频道 ID 可能是负数
    assert.equal(coverGroupKey("-1001234567890-42-2.jpg"), "-1001234567890-42");
    // 认不出格式的名字自己一组
    assert.equal(coverGroupKey("readme.txt"), "readme.txt");
  });

  check("缓存没超上限时什么都不删", () => {
    const groups = [cacheGroup("a", 10, 1000), cacheGroup("b", 20, 2000)];
    assert.deepEqual(selectEvictions(groups, 100 * MB, { now: 9e9 }), []);
    // 刚好等于上限也不删
    assert.deepEqual(selectEvictions(groups, 30 * MB, { now: 9e9 }), []);
  });

  check("超过上限时从最旧的删起，一次清到 80%", () => {
    // 10 组 × 10MB = 100MB，上限 50MB → 目标是 40MB，删最旧的 6 组后剩 40MB
    const groups = Array.from({ length: 10 }, (_, i) => cacheGroup(`g${i + 1}`, 10, (i + 1) * 1000));
    const evicted = selectEvictions(groups, 50 * MB, { now: 9e9 });
    assert.deepEqual(evicted.map((g) => g.key), ["g1", "g2", "g3", "g4", "g5", "g6"]);
  });

  check("keepRatio 决定清到多少", () => {
    const groups = Array.from({ length: 10 }, (_, i) => cacheGroup(`g${i + 1}`, 10, (i + 1) * 1000));
    const evicted = selectEvictions(groups, 50 * MB, { now: 9e9, keepRatio: 0.5 });
    // 目标 25MB，删到只剩 20MB
    assert.equal(evicted.length, 8);
    assert.equal(evicted[evicted.length - 1].key, "g8");
  });

  check("上限为 0 表示不清理", () => {
    const groups = [cacheGroup("a", 500, 1000)];
    assert.deepEqual(selectEvictions(groups, 0, { now: 9e9 }), []);
    assert.deepEqual(selectEvictions(groups, -1, { now: 9e9 }), []);
  });

  check("刚写入过的组先不动，避免删掉正在挑的候选帧", () => {
    const now = 10_000_000;
    const groups = [
      cacheGroup("fresh", 10, now - 1000), // 刚刚生成
      ...Array.from({ length: 9 }, (_, i) => cacheGroup(`old${i + 1}`, 10, (i + 1) * 1000)),
    ];
    const evicted = selectEvictions(groups, 50 * MB, { now });
    assert.equal(evicted.some((g) => g.key === "fresh"), false);
    // 100MB 要清到 40MB，fresh 的 10MB 留着，从旧的里删 6 组
    assert.equal(evicted.length, 6);
  });

  check("全部都是刚生成的就不删（等下一轮）", () => {
    const now = 10_000_000;
    const groups = Array.from({ length: 10 }, (_, i) => cacheGroup(`g${i}`, 10, now - 1000));
    assert.deepEqual(selectEvictions(groups, 50 * MB, { now }), []);
  });

  check("缓存大小的可读格式", () => {
    assert.equal(humanCacheBytes(0), "0 B");
    assert.equal(humanCacheBytes(512), "512 B");
    assert.equal(humanCacheBytes(1536), "1.5 KB");
    assert.equal(humanCacheBytes(3 * MB), "3.0 MB");
    assert.equal(humanCacheBytes(1.5 * 1024 * MB), "1.50 GB");
  });
}

console.log("\n第三方平台：链接识别、Cookie 与 yt-dlp 参数");

/**
 * B站 / 抖音 / 小红书 的链接识别与 yt-dlp 参数拼装。
 *
 * 这些平台最容易出问题的地方是「链接认错了」和「Cookie 拼错了」，
 * 所以这里全部用纯函数验证，不依赖网络与二进制。
 */
async function platformChecks(): Promise<void> {
  const { parsePlatformLink, detectPlatform, splitPlatformLinks, hasPlatformLink } = await import(
    "../server/src/platform/detect"
  );
  const { cookieToNetscape, formatSelector, explainYtdlpError, platformProxyArg, supportsJsRuntime, versionRank, playlistEntries, readPlaylist, MERGE_CONTAINERS } =
    await import("../server/src/platform/ytdlp");
  const { buildEpisodeNfo, decodeMeta } = await import("../server/src/tg/emby");
  const { parseCookiePairs, summarizeCookie, describeCookie, humanAge } = await import(
    "../server/src/platform/cookie"
  );
  const { assetName, normalizeTag } = await import("../server/src/platform/updater");

  check("B站长链接认出 BV 号", () => {
    const link = parsePlatformLink("https://www.bilibili.com/video/BV1xx411c7mD?p=2&t=10");
    assert.equal(link?.platform, "bilibili");
    assert.equal(link?.id, "BV1xx411c7mD");
    // p 参数必须保留（分P），否则会下错集
    assert.ok(link?.url.includes("p=2"));
  });

  check("B站 av 号与番剧 ep 号", () => {
    assert.equal(parsePlatformLink("https://www.bilibili.com/video/av170001")?.id, "av170001");
    assert.equal(parsePlatformLink("https://www.bilibili.com/bangumi/play/ep123456")?.id, "ep123456");
  });

  check("B站短链认不出 ID 但平台认得对", () => {
    const link = parsePlatformLink("https://b23.tv/abcd123");
    assert.equal(link?.platform, "bilibili");
    assert.equal(link?.id, null);
    assert.ok(link?.key.includes("b23.tv"));
  });

  check("抖音长链 / 分享链 / 短链", () => {
    assert.equal(parsePlatformLink("https://www.douyin.com/video/7300000000000000000")?.id, "7300000000000000000");
    assert.equal(
      parsePlatformLink("https://www.iesdouyin.com/share/video/7300000000000000000/")?.id,
      "7300000000000000000",
    );
    const short = parsePlatformLink("https://v.douyin.com/iRxAbCd/");
    assert.equal(short?.platform, "douyin");
    assert.equal(short?.id, null);
  });

  check("小红书笔记链接与短链", () => {
    assert.equal(
      parsePlatformLink("https://www.xiaohongshu.com/explore/64f0c2b1000000001e02a3b4?xsec_token=abc")?.id,
      "64f0c2b1000000001e02a3b4",
    );
    const short = parsePlatformLink("http://xhslink.com/a/AbCdEf");
    assert.equal(short?.platform, "xiaohongshu");
  });

  check("YouTube 各种链接形态", () => {
    assert.equal(parsePlatformLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ")?.id, "dQw4w9WgXcQ");
    assert.equal(parsePlatformLink("https://youtu.be/dQw4w9WgXcQ?t=30")?.id, "dQw4w9WgXcQ");
    assert.equal(parsePlatformLink("https://www.youtube.com/shorts/abc123XYZ_-")?.id, "abc123XYZ_-");
    assert.equal(parsePlatformLink("https://www.youtube.com/embed/dQw4w9WgXcQ")?.id, "dQw4w9WgXcQ");
    assert.equal(parsePlatformLink("https://m.youtube.com/watch?v=dQw4w9WgXcQ")?.platform, "youtube");
    // 频道页认不出视频 ID，但仍然交给 yt-dlp 判定（它会报「不像单条视频」）
    const channel = parsePlatformLink("https://www.youtube.com/@someChannel");
    assert.equal(channel?.platform, "youtube");
    assert.equal(channel?.id, null);
    // 冒充域名
    assert.equal(detectPlatform("https://notyoutube.com/watch?v=abc"), null);
  });

  check("别的站不接", () => {
    assert.equal(detectPlatform("https://t.me/asc2256/10500"), null);
    // 冒充域名：notbilibili.com 不是 B站
    assert.equal(detectPlatform("https://notbilibili.com/video/BV1xx411c7mD"), null);
    assert.equal(parsePlatformLink("随便一段话"), null);
  });

  check("中文标点被清掉，混排文字里能挑出链接", () => {
    const link = parsePlatformLink("https://www.bilibili.com/video/BV1xx411c7mD，");
    assert.equal(link?.id, "BV1xx411c7mD");
    const list = splitPlatformLinks(
      "看这个 https://www.bilibili.com/video/BV1xx411c7mD 还有 https://v.douyin.com/iRxAbCd/ 挺好",
    );
    assert.equal(list.length, 2);
    assert.equal(list[0].platform, "bilibili");
    assert.equal(list[1].platform, "douyin");
    assert.equal(hasPlatformLink("只有一句话"), false);
  });

  check("同一段文字里重复链接只算一次", () => {
    const list = splitPlatformLinks(
      "https://www.bilibili.com/video/BV1xx411c7mD https://www.bilibili.com/video/BV1xx411c7mD?spm=1",
    );
    assert.equal(list.length, 1);
  });

  check("App 分享口令整段粘贴也能认出链接", () => {
    // 小红书：链接被尖括号包着，前后都是文案；短链域名现在是 xhslink.cn
    const xhs =
      "举手大喊：姐姐看我！ 颜值祸国殃民就算了，身材还这... <https://xhslink.cn/o/8c7hpV57rvQ> 复制文本后进入【小红书】，直接查看笔记。";
    const a = splitPlatformLinks(xhs);
    assert.equal(a.length, 1);
    assert.equal(a[0].platform, "xiaohongshu");
    assert.equal(a[0].url, "https://xhslink.cn/o/8c7hpV57rvQ", "尖括号不能带进 URL");

    // 抖音：口令中间夹着「复制打开抖音…」和一串噪声字符
    const douyin =
      "4.87 复制打开抖音，看看【蓝心说影的作品】博物馆双子星联手暴打娇滴滴的马太太！ # 剪映 #... https://v.douyin.com/dVS6cveLVCw/ :1pm j@C.UL KWM:/ 09/14";
    const b = splitPlatformLinks(douyin);
    assert.equal(b.length, 1);
    assert.equal(b[0].platform, "douyin");
    assert.equal(b[0].url, "https://v.douyin.com/dVS6cveLVCw/");

    // B站：【标题-哔哩哔哩】后面跟 <短链>
    const bili = "【李世民已经是太子，为什么还要强行继位？-哔哩哔哩】 <https://b23.tv/29inbIp>";
    const c = splitPlatformLinks(bili);
    assert.equal(c.length, 1);
    assert.equal(c[0].platform, "bilibili");
    assert.equal(c[0].url, "https://b23.tv/29inbIp");

    // 三条口令一起粘：一次全认出来
    const all = splitPlatformLinks([xhs, douyin, bili].join("\n"));
    assert.deepEqual(
      all.map((item) => item.platform),
      ["xiaohongshu", "douyin", "bilibili"],
    );

    // 版本号、普通中文不该被当成链接
    assert.equal(splitPlatformLinks("版本 1.0.6 已发布，看看说明").length, 0);
  });

  check("Cookie 转 Netscape 格式", () => {
    const text = cookieToNetscape("SESSDATA=abc%2C123; bili_jct=xyz; 空项; =bad", "bilibili");
    const lines = text.split("\n").filter((line) => line && !line.startsWith("#"));
    assert.equal(lines.length, 2, "只有两个有效 k=v");
    assert.ok(lines[0].startsWith(".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tabc%2C123"));
    // 值里带 = 时只按第一个 = 切分
    assert.ok(lines[1].endsWith("\tbili_jct\txyz"));
    const douyin = cookieToNetscape("ttwid=1", "douyin");
    assert.ok(douyin.includes(".douyin.com"));
  });

  check("画质映射成 yt-dlp 的格式串", () => {
    assert.equal(formatSelector("best"), "bv*+ba/b");
    assert.equal(formatSelector(""), "bv*+ba/b");
    assert.equal(formatSelector("1080"), "bv*[height<=1080]+ba/b[height<=1080]/b");
    assert.equal(formatSelector("720p"), "bv*[height<=720]+ba/b[height<=720]/b");
    // 脏数据不能把 -f 变成非法参数
    assert.equal(formatSelector("超清"), "bv*+ba/b");
  });

  check("yt-dlp 报错翻成能照做的中文", () => {
    const login = explainYtdlpError("ERROR: [Douyin] xxx: Fresh cookies (not yet expired) are needed", "douyin");
    assert.ok(login.includes("Cookie"), "应提示去填 Cookie");
    const risk = explainYtdlpError("ERROR: [BiliBili] xxx: HTTP Error 412: Precondition Failed", "bilibili");
    assert.ok(risk.includes("风控"));
    const fmt = explainYtdlpError("ERROR: Requested format is not available", "xiaohongshu");
    assert.ok(fmt.includes("画质"));
    // 认不出的错误原样带出来，不要吞掉
    const other = explainYtdlpError("ERROR: 某个没见过的错误", "bilibili");
    assert.ok(other.includes("某个没见过的错误"));
    // YouTube 的两种专属失败要说清「该改代理 / 该填 Cookie」
    const bot = explainYtdlpError("ERROR: Sign in to confirm you're not a bot", "youtube");
    assert.ok(bot.includes("机器人") || bot.includes("Cookie"));
    const geo = explainYtdlpError("ERROR: The uploader has not made this video available in your country", "youtube");
    assert.ok(geo.includes("地区"));
    const net = explainYtdlpError("ERROR: Unable to download webpage: urlopen error timed out", "youtube");
    assert.ok(net.includes("代理"));
    // 代理掐长连接：给出「换节点」而不是含糊的解析失败
    const ssl = explainYtdlpError(
      "ERROR: [download] Got error: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1085). Giving up after 3 retries",
      "youtube",
    );
    assert.ok(ssl.includes("TLS") || ssl.includes("中断"), "SSL 中断要说清是连接被掐");
    // ffmpeg 合并失败：要能指出 opus 装不进 mp4，而不是把最后一行 stream 映射丢出来
    const merge = explainYtdlpError(
      "ERROR: Postprocessing: Stream #1:0 -> #0:1 (copy)\n[mp4 @ 0x55] Could not find tag for codec opus in stream #1, codec not currently supported in container\nCould not write header for output file #0",
      "youtube",
    );
    assert.ok(merge.includes("opus"), "应指出具体编码");
    assert.ok(merge.includes("合并"), "应说明是合并阶段");
    assert.ok(!merge.startsWith("Postprocessing:"), "不能把 ffmpeg 的 stream 映射当错误抛给用户");
    assert.equal(MERGE_CONTAINERS, "mp4/mkv", "合并容器要给 mkv 兜底");
  });

  check("Cookie 串解析与体检", () => {
    const pairs = parseCookiePairs("SESSDATA=abc%2C123; bili_jct=xyz;\n空项; =bad");
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].name, "SESSDATA");
    // 只按第一个 = 切分，值里带着 = 不影响
    assert.equal(parseCookiePairs("a=b=c")[0].value, "b=c");

    const ok = summarizeCookie("SESSDATA=1; bili_jct=2; buvid3=3", "bilibili");
    assert.equal(ok.count, 3);
    assert.equal(ok.missing.length, 0);
    assert.ok(describeCookie(ok).includes("3 项"));

    const lacking = summarizeCookie("buvid3=3; bili_jct=2", "bilibili");
    assert.deepEqual(lacking.missing, ["SESSDATA"]);
    assert.ok(describeCookie(lacking).includes("缺 SESSDATA"));

    // 键名大小写不敏感（浏览器复制出来的大小写不完全统一）
    assert.equal(summarizeCookie("sessdata=1; BILI_JCT=2", "bilibili").missing.length, 0);
    // YouTube 认 SID / SAPISID 任意一个
    assert.equal(summarizeCookie("SID=abc; HSID=1", "youtube").missing.length, 0);
    assert.equal(summarizeCookie("PREF=xx", "youtube").missing.length, 1);
  });

  check("Cookie 保存时间的相对描述", () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    assert.equal(humanAge(now - 5_000, now), "刚刚");
    assert.equal(humanAge(now - 12 * 60_000, now), "12 分钟前");
    assert.equal(humanAge(now - 3 * 3600_000, now), "3 小时前");
    assert.equal(humanAge(now - 5 * 86400_000, now), "5 天前");
    assert.equal(humanAge(null, now), null);
  });

  check("yt-dlp 版本比较与 JS 运行时判断", () => {
    assert.equal(versionRank("2025.11.12"), 20251112);
    assert.equal(versionRank("随便"), 0);
    // --js-runtimes 从 2025.10.22 才有，老版本传了会直接报未知参数
    assert.equal(supportsJsRuntime("2025.10.21"), false);
    assert.equal(supportsJsRuntime("2025.10.22"), true);
    assert.equal(supportsJsRuntime("2026.01.03"), true);
    assert.equal(supportsJsRuntime(null), false);
  });

  check("更新用的文件名与 tag 归一化", () => {
    assert.equal(assetName("win32", "x64"), "yt-dlp.exe");
    assert.equal(assetName("linux", "x64"), "yt-dlp");
    assert.equal(assetName("linux", "arm64"), "yt-dlp_linux_aarch64");
    assert.equal(assetName("linux", "arm"), "yt-dlp_linux_armv7l");
    assert.equal(assetName("darwin", "arm64"), "yt-dlp_macos");
    assert.equal(normalizeTag("v2025.11.12"), "2025.11.12");
    assert.equal(normalizeTag(" 2025.11.12 "), "2025.11.12");
  });

  check("合集条目：只留下带可下载链接的", () => {
    const entries = playlistEntries([
      { id: "BV1xx", title: "第1话", url: "https://www.bilibili.com/video/BV1xx?p=1", uploader: "某UP", duration: 61.5 },
      { id: "BV1xx", title: "第2话", webpage_url: "https://www.bilibili.com/video/BV1xx?p=2" },
      { id: "no-url", title: "坏条目" },
      null,
      "字符串也不是条目",
    ]);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].url, "https://www.bilibili.com/video/BV1xx?p=1");
    assert.equal(entries[0].duration, 62, "时长要四舍五入成整数");
    assert.equal(entries[1].url, "https://www.bilibili.com/video/BV1xx?p=2", "webpage_url 优先");
    assert.equal(entries[1].uploader, "", "缺作者时给空串，别写 undefined");
  });

  check("平台视频的 nfo：分区、时长、播放量与简介兜底", () => {
    const nfo = buildEpisodeNfo({
      series: "某个视频",
      season: 1,
      episode: null,
      firstLine: "某个视频",
      plot: "",
      tags: ["哔哩哔哩", "某UP"],
      studio: "某UP",
      link: "https://www.bilibili.com/video/BV1xx",
      airedAt: Date.parse("2026-10-31T12:00:00Z"),
      messageId: 0,
      kind: "video",
      platform: "bilibili",
      cover: "https://i0.hdslb.com/bfs/archive/x.jpg",
      views: 123456,
      likes: 4567,
      duration: 754,
      categories: ["影视", "解说"],
    });
    assert.ok(nfo.includes("<genre>影视</genre>"), nfo);
    assert.ok(nfo.includes("<runtime>13</runtime>"), "754 秒要写成 13 分钟");
    assert.ok(nfo.includes("播放 12.3 万"), nfo);
    assert.ok(nfo.includes("点赞 4567"), nfo);
    assert.ok(nfo.includes("时长 12:34"), nfo);
    // 抖音/小红书常常没有正文：用标题 + 作者兜底，别留空白简介
    assert.ok(nfo.includes("某个视频，来自 某UP"), nfo);
    assert.ok(!nfo.includes("<episode>"), "平台单条视频不写集号");
  });

  check("老 emby_json 没有新字段也能读，脏值不能带进 nfo", () => {
    const base = {
      series: "x",
      season: 1,
      episode: null,
      firstLine: "x",
      plot: "",
      tags: [],
      studio: null,
      link: null,
      airedAt: 0,
      messageId: 0,
      kind: "video",
    };
    const old = decodeMeta(JSON.stringify(base));
    assert.equal(old?.cover, null);
    assert.deepEqual(old?.categories, []);
    assert.equal(old?.views, null);

    const messy = decodeMeta(
      JSON.stringify({ ...base, categories: ["a", 3, ""], views: "12", likes: -1, cover: "" }),
    );
    assert.deepEqual(messy?.categories, ["a"]);
    assert.equal(messy?.views, 12);
    assert.equal(messy?.likes, null, "负数当没有");
    assert.equal(messy?.cover, null, "空字符串当没有");
  });

  check("合集判定：单条视频不当合集，多P / 播放列表才问", () => {
    // 单条视频即使带 entries 也不该问用户
    assert.equal(readPlaylist({ _type: "video" }), null);
    assert.equal(readPlaylist({ _type: "playlist", entries: [] }), null, "空合集不算");
    assert.equal(readPlaylist({ _type: "playlist", entries: [{ title: "没有链接" }] }), null);

    const list = readPlaylist({
      _type: "playlist",
      entries: [
        { id: "1", title: "a", url: "https://x/1" },
        { id: "2", title: "b", webpage_url: "https://x/2" },
      ],
    });
    assert.equal(list?.count, 2);
    assert.equal(list?.capped, false);
    // yt-dlp 对多P 有时报 multi_video
    assert.equal(readPlaylist({ _type: "multi_video", entries: [{ id: "1", title: "a", url: "https://x/1" }] })?.count, 1);

    const many = Array.from({ length: 200 }, (_, i) => ({ id: String(i), title: `t${i}`, url: `https://x/${i}` }));
    assert.equal(readPlaylist({ _type: "playlist", entries: many })?.capped, true, "到上限要标记 capped");
  });

  check("第三方代理只影响 yt-dlp，坏地址不传下去", () => {
    assert.deepEqual(platformProxyArg(""), []);
    assert.deepEqual(platformProxyArg("http://192.168.5.2:7890"), [
      "--proxy",
      "http://192.168.5.2:7890",
    ]);
    // 不带协议按 socks5 处理，和 Telegram 那套规则一致
    assert.deepEqual(platformProxyArg("192.168.5.2:7890"), ["--proxy", "socks5://192.168.5.2:7890"]);
    // 解析不了就不加参数，别让一个脏值把下载全搞挂
    assert.deepEqual(platformProxyArg("socks5://:7890"), []);
    assert.deepEqual(platformProxyArg("ftp://1.2.3.4:21"), []);
  });
}

console.log("\n网络与代理：地址解析");

function proxyChecks(): void {
  check("带协议的代理地址", () => {
    const p = parseProxy("socks5://192.168.5.2:7890");
    assert.equal(p?.scheme, "socks5");
    assert.equal(p?.host, "192.168.5.2");
    assert.equal(p?.port, 7890);
    assert.equal(p?.username, "");
  });

  check("不带协议时按 SOCKS5", () => {
    const p = parseProxy("192.168.5.2:7890");
    assert.equal(p?.scheme, "socks5");
    assert.equal(p?.port, 7890);
  });

  check("http / https / socks4 都认", () => {
    assert.equal(parseProxy("http://proxy.local:8080")?.scheme, "http");
    assert.equal(parseProxy("https://proxy.local:8443")?.scheme, "https");
    assert.equal(parseProxy("socks4://proxy.local:1080")?.scheme, "socks4");
    assert.equal(parseProxy("socks5h://proxy.local:1080")?.scheme, "socks5h");
  });

  check("省略端口时用协议默认值", () => {
    assert.equal(parseProxy("socks5://proxy.local")?.port, 1080);
    assert.equal(parseProxy("socks4://proxy.local")?.port, 1080);
    assert.equal(parseProxy("http://proxy.local")?.port, 8080);
    assert.equal(parseProxy("https://proxy.local")?.port, 8443);
  });

  check("用户名密码会解码", () => {
    const p = parseProxy("socks5://user%40name:p%3Ass@host:1080");
    assert.equal(p?.username, "user@name");
    assert.equal(p?.password, "p:ss");
  });

  check("空串表示直连", () => {
    assert.equal(parseProxy(""), null);
    assert.equal(parseProxy("   "), null);
  });

  check("非法地址返回 null 并给出提示", () => {
    assert.equal(parseProxy("ftp://host:21"), null);
    assert.equal(parseProxy("socks5://"), null);
    assert.equal(parseProxy("socks5://host:99999"), null);
    assert.ok(explainProxyProblem("ftp://host:21"));
    assert.equal(explainProxyProblem(""), null);
    assert.equal(explainProxyProblem("socks5://host:1080"), null);
  });

  check("规整地址：补协议、去末尾斜杠", () => {
    assert.equal(normalizeProxyUrl("192.168.5.2:7890"), "socks5://192.168.5.2:7890");
    assert.equal(normalizeProxyUrl("  socks5://192.168.5.2:7890/  "), "socks5://192.168.5.2:7890");
    assert.equal(normalizeProxyUrl("http://proxy.local"), "http://proxy.local:8080");
  });

  check("规整时保留认证信息", () => {
    assert.equal(
      normalizeProxyUrl("socks5://user:pass@host:1080"),
      "socks5://user:pass@host:1080",
    );
    // 密码里有 @ 时先编码再拼回去，避免下次解析错位
    assert.equal(
      normalizeProxyUrl("socks5://user:p%40ss@host:1080"),
      "socks5://user:p%40ss@host:1080",
    );
  });

  check("IPv6 地址加回方括号", () => {
    const normalized = normalizeProxyUrl("socks5://[::1]:1080");
    assert.equal(normalized, "socks5://[::1]:1080");
  });

  check("HTTP(S) 代理不能用于 Telegram", () => {
    assert.equal(telegramProxyUnsupported("http://127.0.0.1:8080"), true);
    assert.equal(telegramProxyUnsupported("https://127.0.0.1:8443"), true);
    assert.equal(telegramProxyUnsupported("socks5://127.0.0.1:7890"), false);
    assert.equal(telegramProxyUnsupported(""), false);
  });
}

async function main(): Promise<void> {
  const suites: Array<[string, () => unknown]> = [
    ["剧集目录用例", () => seriesDirChecks()],
    ["日志存储用例", () => logStoreChecks()],
    ["权限检查用例", () => permissionChecks()],
    ["Emby 用例", () => embyChecks()],
    ["Emby 入库用例", () => embyNotifyChecks()],
    ["缓存清理用例", () => cacheChecks()],
    ["网络代理用例", () => proxyChecks()],
    ["第三方平台用例", () => platformChecks()],
    ["ffmpeg 解析用例", () => ffmpegProbeChecks()],
  ];
  for (const [name, run] of suites) {
    try {
      await run();
    } catch (err) {
      console.error(`  \u2717 ${name}异常: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n通过 ${passed} 项自检${process.exitCode ? "（存在失败）" : "，全部正常"}\n`);
}

void main();
