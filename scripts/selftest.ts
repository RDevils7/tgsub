/**
 * 核心逻辑自检：不依赖 Telegram 网络，验证关键词匹配、媒体解析与路径生成。
 * 运行：npm run selftest
 */
import assert from "node:assert/strict";
import path from "node:path";
import bigInt from "big-integer";
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
import {
  DEFAULT_SOURCE_DIRS,
  DIR_KEYS,
  joinRel,
  parseDirSetting,
  platformDirKey,
  sanitizeRelDir,
} from "../server/src/tg/mediadir";
import { pickNext, type JobRef } from "../server/src/tg/queueplan";
import {
  cleanTitle,
  decodeHtmlEntities,
  extractM3u8FromHtml,
  isRetryableResolve,
  isSignatureError,
  normalizeMediaUrl,
  ROUTE_FALLBACK_NOTE,
  shouldRetryRoute,
} from "../server/src/tg/m3u8";
import {
  DEFAULT_CHECK_HOURS,
  MAX_RETRY_DELAY_MS,
  daysToHours,
  retryDelayMs,
  shouldRunCheck,
} from "../server/src/platform/updateplan";
import {
  applyOrder,
  buildRenamePlan,
  canRenameDir,
  countEffective,
  episodeFileName,
  naturalCompare,
  samePath,
  seriesDirName,
  sortEpisodeSources,
  type EpisodeSource,
} from "../server/src/tg/renameplan";
import { clamp, directNote, kindOfLink, manualStatus, platformNote, webNote } from "../server/src/manual/note";
import { commentIdOf, extractTelegramLinks, isCommentLink, parseTelegramLink } from "../server/src/tg/link";
import {
  chatInfoOf,
  discussionEntityKey,
  groupsFromChats,
  hashString,
  idString,
  linkedGroupId,
  pickDiscussionGroup,
  postReplyInfo,
  threadGroupId,
  validId,
} from "../server/src/tg/discussionplan";
import { confirmProblem, hashPassword, passwordProblem, usernameProblem, verifyPassword } from "../server/src/auth/password";
import { parseCookie, parseCookies } from "../server/src/auth/cookie";
import { dirMapOf, mergeOrigins, originOf, originOfRelPath } from "../server/src/tg/origin";
import { isUnder, planTransfer, replacePrefix } from "../server/src/tg/transferplan";
import { normalizeSortKey, normalizeSortOrder, sortFiles, sortFolders } from "../server/src/tg/mediasort";
import {
  diskLevel,
  ellipsizePath,
  humanUptime,
  statusRank,
  summarizeProbes,
  toolStatus,
  type ProbeLike,
} from "../server/src/system/overviewFormat";
import {
  applyFields,
  buildNfo,
  displayText,
  EMPTY_FIELDS as EMPTY_NFO_FIELDS,
  fieldsFromNfo,
  isNfoEditable,
  mergeGeneratedNfo,
  parseNfo,
  unwrapCdata,
  validateNfo,
  type NfoFields,
} from "../server/src/tg/nfo";
import { nfoTraceOf } from "../server/src/tg/nfotrace";

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

/** 口令哈希是异步的（scrypt 不阻塞事件循环），所以需要一个 async 版本 */
async function checkAsync(name: string, fn: () => Promise<void>) {
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

/** 元数据页以文件系统为准：下载根下的所有视频都会列出，无论是否由 tgsub 下载 */
async function fileManagerChecks(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const { env } = await import("../server/src/env");
  const { collectFolders, excludePath, restorePath } = await import("../server/src/tg/mediatree");

  const realDownloadDir = env.downloadDir;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tgsub-fm-"));
  const touch = async (rel: string): Promise<void> => {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, "x");
  };

  // tgsub 风格路径（平台子目录） + 完全未知的子目录（手动拷入 / 其它工具下载）
  await touch("B站/剧名A/剧名A S01E01.mp4");
  await touch("B站/剧名A/剧名A S01E02.mp4");
  await touch("外部拷贝/随手拍/随手一集.mp4");
  await touch("其它/单集/我的短片.mp4");

  // 关键：不写任何 downloads 记录，验证「文件系统为准」——
  // 改动前这些文件不会出现在元数据页，因为 collectFolders 只认 downloads 表 + 手动来源。
  env.downloadDir = root;
  try {
    await acheck("下载根下的所有视频都被列出（含非 tgsub 下载的）", async () => {
      const folders = collectFolders();
      const a = folders.find((f) => f.name === "剧名A");
      assert.ok(a, "剧名A 应被列出");
      assert.equal(a.files.length, 2);
      const ext = folders.find((f) => f.name === "随手拍");
      assert.ok(ext, "随手拍 应被列出");
      assert.equal(ext.files.length, 1);
      assert.equal(ext.files[0].name, "随手一集.mp4");
    });

    await acheck("未由 tgsub 下载的文件标记为 manual / 外部来源，来源按物理路径推断", async () => {
      const folders = collectFolders();
      const a = folders.find((f) => f.name === "剧名A")!;
      // 没有 downloads 记录，整部剧都是外部文件
      assert.equal(a.source, "manual");
      assert.ok(a.files.every((x) => x.source === "manual" && x.downloadId === null));
      // 来源按物理路径推断：B站 子目录 → bilibili
      assert.equal(a.origin, "bilibili");
      const ext = folders.find((f) => f.name === "随手拍")!;
      assert.equal(ext.origin, "manual");
    });

    await acheck("隐藏（登记 media_excluded）后，collectFolders 不再列出该文件夹及其视频", async () => {
      const a = collectFolders().find((f) => f.name === "剧名A")!;
      assert.ok(a, "隐藏前应存在");
      excludePath(a.dir);
      const after = collectFolders().find((f) => f.name === "剧名A");
      assert.equal(after, undefined, "隐藏后剧名A 不应再出现");
    });

    await acheck("恢复（删掉 media_excluded 登记）后，文件夹重新出现在列表里", async () => {
      const dirA = path.join(root, "B站", "剧名A");
      const missing = collectFolders().find((f) => f.name === "剧名A");
      assert.equal(missing, undefined, "恢复前不应出现");
      restorePath(dirA);
      const back = collectFolders().find((f) => f.name === "剧名A");
      assert.ok(back, "恢复后剧名A 应重新出现");
      assert.equal(back!.files.length, 2);
    });

    await acheck("隐藏是前缀匹配：隐藏父目录会连带隐藏其下所有视频", async () => {
      const other = collectFolders().find((f) => f.name === "单集")!;
      assert.ok(other, "单集 应存在");
      const parent = path.dirname(other.dir); // 「其它」整个父目录
      excludePath(parent);
      const still = collectFolders().some((f) => f.name === "单集");
      assert.equal(still, false, "隐藏父目录后，子目录单集不应出现");
      restorePath(parent);
    });
  } finally {
    env.downloadDir = realDownloadDir;
    await fs.rm(root, { recursive: true, force: true });
  }
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
 * ffmpeg -i 解析器：项目里唯一的媒体信息探测路径（只有 ffmpeg 一个二进制），
 * 这里验证从 stderr 抽出的时长 / 分辨率 / 编码 / 码率是否准确。
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

  await acheck("ffmpeg 解析的码率换算成 bit/s", async () => {
    const probe = parseFfmpegProbe(stderr);
    // ffmpeg 报 396 kb/s → 396000 bit/s（统一量纲，界面不会一会儿 396 一会儿 398201）
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

  await finalizeMedia(video, encodeMeta(meta), {
    file_name: "原始消息视频.mp4",
    save_name: "美人局S01E04.mp4",
    source: "telegram",
    source_url: null,
    channel_title: "AI短剧频道",
  });

  await acheck("自动生成的 nfo 保留原文件名与来源", async () => {
    const nfo = await fs.readFile(path.join(dir, "美人局S01E04.nfo"), "utf8");
    assert.ok(nfo.includes("<originalfilename>原始消息视频.mp4</originalfilename>"));
    assert.ok(nfo.includes("<source>Telegram · AI短剧频道</source>"));
    const show = await fs.readFile(path.join(dir, "tvshow.nfo"), "utf8");
    assert.ok(show.includes("<source>Telegram · AI短剧频道</source>"));
  });

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

  const madeFirst = await autoCoversFromVideo(clipA, dir, { base: "美人局S01E01", series: "force" });
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
  const madeSecond = await autoCoversFromVideo(clipB, dir, { base: "美人局S01E02", series: "skip" });
  await acheck("第二集只生成自己的缩略图，不动剧集封面", async () => {
    assert.ok(madeSecond.includes("美人局S01E02-thumb.jpg"), "第二集缺缩略图");
    assert.ok(!madeSecond.includes("poster.jpg"), "非第一集不该重做剧集封面");
    assert.equal(await sha1(path.join(dir, "poster.jpg")), posterBefore);
  });

  const madeAgain = await autoCoversFromVideo(clipB, dir, { base: "美人局S01E01", series: "force" });
  await acheck("第一集重跑时覆盖剧集封面（目录图始终同第一集）", async () => {
    assert.ok(madeAgain.includes("poster.jpg"));
    assert.ok(!madeAgain.includes("美人局S01E01-thumb.jpg"), "缩略图已存在不该重做");
    assert.notEqual(await sha1(path.join(dir, "poster.jpg")), posterBefore);
  });

  await acheck("if-missing 模式只补缺的剧集封面", async () => {
    const gapDir = path.join(dir, "gap-case");
    await fs.mkdir(gapDir, { recursive: true });
    const made = await autoCoversFromVideo(clipA, gapDir, { base: "缺图S01E01", series: "if-missing" });
    assert.ok(made.includes("poster.jpg"), "缺 poster 时应该补上");
    assert.ok(made.includes("缺图S01E01-thumb.jpg"), "缺缩略图时应该补上");
    const before = await sha1(path.join(gapDir, "poster.jpg"));
    const again = await autoCoversFromVideo(clipB, gapDir, { base: "缺图S01E02", series: "if-missing" });
    assert.ok(!again.includes("poster.jpg"), "已有 poster 不该重做");
    assert.equal(await sha1(path.join(gapDir, "poster.jpg")), before);
  });

  await acheck("季目录结构下剧集封面落在剧集根目录", async () => {
    const root = path.join(dir, "season-case");
    const season = path.join(root, "Season 01");
    await fs.mkdir(season, { recursive: true });
    const made = await autoCoversFromVideo(clipA, season, {
      base: "季目录S01E01",
      series: "force",
      seriesDir: root,
    });
    assert.ok(made.includes("poster.jpg"), "缺 poster");
    const exists = async (p: string) => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    };
    assert.ok(await exists(path.join(root, "poster.jpg")), "poster 应在剧集根目录");
    assert.ok(!(await exists(path.join(season, "poster.jpg"))), "poster 不应落在季目录");
    assert.ok(await exists(path.join(season, "季目录S01E01-thumb.jpg")), "缩略图应跟视频同目录");
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
 * B站 / 小红书 / YouTube 的链接识别与 yt-dlp 参数拼装。
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
  const { parseCookiePairs, summarizeCookie, describeCookie, humanAge, normalizeCookie } = await import(
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

  check("抖音链接不再被识别（1.2.1 移除该平台）", () => {
    // yt-dlp 的 DouyinIE 生成不出接口要的 a_bogus 签名，Cookie 再对也会被风控拦下，
    // 所以整块摘掉了。抖音链接要当成「不是本程序支持的链接」，不能误识别成别的平台。
    assert.equal(parsePlatformLink("https://www.douyin.com/video/7300000000000000000"), null);
    assert.equal(parsePlatformLink("https://www.iesdouyin.com/share/video/7300000000000000000/"), null);
    assert.equal(parsePlatformLink("https://v.douyin.com/iRxAbCd/"), null);
    assert.equal(detectPlatform("https://www.douyin.com/"), null);
    assert.equal(splitPlatformLinks("https://v.douyin.com/iRxAbCd/").length, 0);
  });

  check("小红书笔记链接与短链", () => {
    assert.equal(
      parsePlatformLink("https://www.xiaohongshu.com/explore/64f0c2b1000000001e02a3b4?xsec_token=abc")?.id,
      "64f0c2b1000000001e02a3b4",
    );
    const short = parsePlatformLink("http://xhslink.com/a/AbCdEf");
    assert.equal(short?.platform, "xiaohongshu");
  });

  check("缺登录态的报错会提示去填 Cookie", () => {
    // yt-dlp 三个平台统一说「Fresh cookies are needed」，翻成「要求登录」并指出去哪里填
    const bili = explainYtdlpError("ERROR: Fresh cookies are needed", "bilibili");
    assert.ok(/要求登录/.test(bili), `B站应提示登录：${bili}`);
    const xhs = explainYtdlpError("ERROR: [Xiaohongshu] Fresh cookies are needed", "xiaohongshu");
    assert.ok(/要求登录/.test(xhs), `小红书应提示登录：${xhs}`);
    assert.ok(/第三方平台/.test(bili), `应指出去哪里填：${bili}`);
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
      "看这个 https://www.bilibili.com/video/BV1xx411c7mD 还有 https://xhslink.cn/o/8c7hpV57rvQ 挺好",
    );
    assert.equal(list.length, 2);
    assert.equal(list[0].platform, "bilibili");
    assert.equal(list[1].platform, "xiaohongshu");
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

    // B站：【标题-哔哩哔哩】后面跟 <短链>
    const bili = "【李世民已经是太子，为什么还要强行继位？-哔哩哔哩】 <https://b23.tv/29inbIp>";
    const c = splitPlatformLinks(bili);
    assert.equal(c.length, 1);
    assert.equal(c[0].platform, "bilibili");
    assert.equal(c[0].url, "https://b23.tv/29inbIp");

    // 两条口令一起粘：一次全认出来
    const all = splitPlatformLinks([xhs, bili].join("\n"));
    assert.deepEqual(
      all.map((item) => item.platform),
      ["xiaohongshu", "bilibili"],
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
    const yt = cookieToNetscape("SID=1", "youtube");
    assert.ok(yt.includes(".youtube.com"));
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
    const login = explainYtdlpError("ERROR: [BiliBili] xxx: Fresh cookies (not yet expired) are needed", "bilibili");
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
    // B站 567：默认没开代理，文案不能让用户去关一个没开的开关
    const denied = explainYtdlpError(
      "ERROR: unable to download video data: HTTP Error 567: Unknown Status",
      "bilibili",
    );
    assert.ok(denied.includes("567"), "要说明是 CDN 拒绝");
    assert.ok(!denied.includes("关掉"), "没有启用代理时不该让用户去关代理开关");
    assert.ok(denied.includes("Cookie") || denied.includes("更新"), "要给出可照做的下一步");
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

  check("Cookie 的四种粘法都能认出来", () => {
    // Cookie-Editor 导出的 JSON 数组
    const json = JSON.stringify([
      { name: "ttwid", value: "1|abc" },
      { name: "sessionid", value: "def" },
      { name: "空值", value: "" },
    ]);
    assert.equal(normalizeCookie(json), "ttwid=1|abc; sessionid=def");
    // 小红书要 web_session 与 a1，这串里没有，所以两项都该被提示
    const xhsSummary = summarizeCookie(json, "xiaohongshu");
    assert.ok(xhsSummary.missing.includes("web_session"), `应提示缺 web_session：${xhsSummary.missing.join(",")}`);
    assert.ok(xhsSummary.missing.includes("a1"), `应提示缺 a1：${xhsSummary.missing.join(",")}`);
    // 补齐之后才算齐全
    const withAll = summarizeCookie(
      JSON.stringify([
        { name: "web_session", value: "def" },
        { name: "a1", value: "abc" },
      ]),
      "xiaohongshu",
    );
    assert.equal(withAll.missing.length, 0, `补齐了就不该再缺：${withAll.missing.join(",")}`);

    // 简化的 {name: value} 对象
    assert.equal(parseCookiePairs('{"ttwid":"1","msToken":"x"}').length, 2);

    // Netscape cookies.txt（Get cookies.txt 扩展导出的样子）
    const netscape = [
      "# Netscape HTTP Cookie File",
      ".xiaohongshu.com\tTRUE\t/\tTRUE\t0\ta1\t1",
      "#HttpOnly_.xiaohongshu.com\tTRUE\t/\tTRUE\t0\tweb_session\tdef",
      "",
    ].join("\n");
    const pairs = parseCookiePairs(netscape);
    assert.equal(pairs.length, 2, "注释行要跳过");
    assert.equal(pairs[1].name, "web_session");

    // F12 复制时连带 "Cookie: " 前缀
    assert.equal(normalizeCookie("Cookie: ttwid=1; a=2"), "ttwid=1; a=2");

    // 只粘了值 / 只粘了字段名：认不出，界面要明确说「没认出键值对」
    assert.equal(summarizeCookie("abc123", "xiaohongshu").count, 0);
    assert.equal(summarizeCookie("web_session a1", "xiaohongshu").count, 0);

    // 小红书：web_session 与 a1 各是一组，缺一个都要提示
    const onlyA1 = summarizeCookie("a1=1", "xiaohongshu");
    assert.ok(onlyA1.missing.includes("web_session"), `缺 web_session 应被提示：${onlyA1.missing.join(",")}`);
    // YouTube 的 SID 实际种在 google.com，也要认
    assert.equal(summarizeCookie("__Secure-3PSID=1", "youtube").missing.length, 0);
  });

  check("Cookie 文件按平台写全多个域名", () => {
    const yt = cookieToNetscape("SID=1", "youtube");
    assert.ok(yt.includes(".google.com"), "SID / SAPISID 种在 google.com 上");
    // 换行分隔的粘贴要拆成两条，而不是当成一条
    const multi = cookieToNetscape("a=1\nb=2", "bilibili")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    assert.equal(multi.length, 2);
    // JSON 导出直接粘进来也能写
    const fromJson = cookieToNetscape('[{"name":"SESSDATA","value":"x"}]', "bilibili");
    assert.ok(fromJson.includes("\tSESSDATA\tx"));
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
    // 小红书常常没有正文：用标题 + 作者兜底，别留空白简介
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

/* ------------------------------------------------------------------ */
/* 网络线路：直连优先、失败回退代理                                   */
/* ------------------------------------------------------------------ */

function netRouteChecks(): void {
  const {
    clearDirectFailures,
    clearRouteMemory,
    directFailedRecently,
    forgetDirectFailure,
    hostOfUrl,
    isInternalProxy,
    isNetworkError,
    orderRoutes,
    pickProxyFrom,
    planRoutes,
    rememberDirectFailure,
    rememberRoute,
    rememberedRoute,
    routeLabel,
  } = require("../server/src/tg/netroute") as typeof import("../server/src/tg/netroute");

  check("内部代理要被排除", () => {
    assert.equal(isInternalProxy("127.0.0.1:7890"), true);
    assert.equal(isInternalProxy("http://127.0.0.1:58906"), true);
    assert.equal(isInternalProxy("localhost:1080"), true);
    assert.equal(isInternalProxy("http://[::1]:1080"), true);
    assert.equal(isInternalProxy("192.168.5.2:7890"), false);
    assert.equal(isInternalProxy(""), false);
  });

  check("候选代理里跳过内部地址与空值", () => {
    assert.equal(pickProxyFrom(["", "127.0.0.1:7890", "socks5://192.168.5.2:7890"]), "socks5://192.168.5.2:7890");
    assert.equal(pickProxyFrom(["127.0.0.1:1", "localhost:2"]), undefined);
    assert.equal(pickProxyFrom([]), undefined);
  });

  check("直连优先：auto 的尝试顺序是 直连 → 代理", () => {
    assert.deepEqual(planRoutes("auto", true), ["direct", "proxy"]);
    assert.deepEqual(planRoutes("auto", false), ["direct"]);
    assert.deepEqual(planRoutes("always", true), ["proxy"]);
    assert.deepEqual(planRoutes("always", false), ["direct"]);
    assert.deepEqual(planRoutes("off", true), ["direct"]);
  });

  check("上次走通的线路会被排到前面", () => {
    clearRouteMemory();
    rememberRoute("v.example.com", "proxy");
    assert.equal(rememberedRoute("v.example.com"), "proxy");
    assert.deepEqual(orderRoutes(["direct", "proxy"], "v.example.com"), ["proxy", "direct"]);
    // 不在候选里的线路不参与排序
    assert.deepEqual(orderRoutes(["direct"], "v.example.com"), ["direct"]);
    clearRouteMemory();
    assert.equal(rememberedRoute("v.example.com"), undefined);
  });

  check("直连失败会被记住，恢复后清掉", () => {
    clearDirectFailures();
    assert.equal(directFailedRecently("a.example.com"), false);
    rememberDirectFailure("a.example.com");
    assert.equal(directFailedRecently("a.example.com"), true);
    forgetDirectFailure("a.example.com");
    assert.equal(directFailedRecently("a.example.com"), false);
  });

  check("只有网络类错误才值得换线路", () => {
    assert.equal(isNetworkError("Connection timed out"), true);
    assert.equal(isNetworkError("ECONNRESET"), true);
    assert.equal(isNetworkError("Could not resolve host"), true);
    assert.equal(isNetworkError("Connection refused"), true);
    // 403 / 签名失效换线路也没用
    assert.equal(isNetworkError("下载被拒绝（403）"), false);
    assert.equal(isNetworkError("视频地址已失效（404）"), false);
    assert.equal(isNetworkError(""), false);
  });

  check("取 host 与线路文案", () => {
    assert.equal(hostOfUrl("https://a.example.com/x.m3u8"), "a.example.com");
    assert.equal(hostOfUrl("不是网址"), "");
    assert.equal(routeLabel("direct"), "直连");
    assert.equal(routeLabel("proxy"), "代理");
    assert.equal(routeLabel("auto"), "自动");
    assert.equal(routeLabel(null), "未知");
  });
}

/* ------------------------------------------------------------------ */
/* yt-dlp 自动检查更新的排期                                          */
/* ------------------------------------------------------------------ */

function updatePlanChecks(): void {
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  check("默认检查间隔是 15 天", () => {
    assert.equal(DEFAULT_CHECK_HOURS, 15 * 24);
    assert.equal(daysToHours(15), 360);
    assert.equal(daysToHours(1), 24);
    assert.equal(daysToHours(0), 24, "非法天数按 1 天兜底");
    assert.equal(daysToHours(-3), 24);
  });

  check("没查过就直接查", () => {
    assert.equal(shouldRunCheck({ autoUpdate: true, checkHours: 360, now: 1000 }), true);
  });

  check("关掉自动更新就不查", () => {
    assert.equal(
      shouldRunCheck({ autoUpdate: false, checkHours: 360, checkAt: 0, now: 1000 }),
      false,
    );
  });

  check("周期没到不查、到了才查", () => {
    const now = 1000 * DAY;
    // 15 天的周期：第 14 天不查，第 15 天查
    assert.equal(
      shouldRunCheck({ autoUpdate: true, checkHours: 360, checkAt: now - 14 * DAY, now }),
      false,
    );
    assert.equal(
      shouldRunCheck({ autoUpdate: true, checkHours: 360, checkAt: now - 15 * DAY, now }),
      true,
    );
  });

  check("失败重试：没到点不查，到了就重试一次", () => {
    const now = 1000 * DAY;
    assert.equal(
      shouldRunCheck({
        autoUpdate: true,
        checkHours: 360,
        checkAt: now - 15 * DAY,
        retryAt: now + 10 * 60_000,
        now,
      }),
      false,
    );
    assert.equal(
      shouldRunCheck({
        autoUpdate: true,
        checkHours: 360,
        checkAt: now - 15 * DAY,
        retryAt: now - 1,
        now,
      }),
      true,
    );
  });

  // 这一条是 1.3.0 的真 bug：只要失败过（retryAt 存在且早已过期），
  // 旧实现 `if (retryAt) return true` 会让每次 tick 都查，周期设置彻底失效
  check("失败重试到点后不再无脑每次都查（周期仍然生效）", () => {
    const now = 1000 * DAY;
    // 重试时间早已过去，但周期还没到 → 应该只重试这一次，之后回到周期判断
    assert.equal(
      shouldRunCheck({
        autoUpdate: true,
        checkHours: 360,
        checkAt: now - 1 * DAY,
        retryAt: now - 5 * DAY,
        now,
      }),
      true,
      "重试时间已过：允许重试一次",
    );
    // 重试完成后 retryAt 被清空，此时周期没到就不该再查
    assert.equal(
      shouldRunCheck({ autoUpdate: true, checkHours: 360, checkAt: now - 1 * DAY, now }),
      false,
      "retryAt 已清空：回到 15 天周期，第 1 天不应检查",
    );
    // 每小时醒一次，连醒 10 次也只会在第一天那次判定为 true 之后不再触发
    let fired = 0;
    for (let i = 0; i < 10; i++) {
      const t = now + i * HOUR;
      if (shouldRunCheck({ autoUpdate: true, checkHours: 360, checkAt: now - 1 * DAY, now: t })) {
        fired += 1;
      }
    }
    assert.equal(fired, 0, "周期未到，tick 再多也不该检查");
  });

  check("检查周期按设置生效，非法值退回默认", () => {
    const now = 10 * DAY;
    assert.equal(
      shouldRunCheck({ autoUpdate: true, checkHours: 24, checkAt: now - 25 * HOUR, now }),
      true,
    );
    assert.equal(
      shouldRunCheck({ autoUpdate: true, checkHours: 24, checkAt: now - 23 * HOUR, now }),
      false,
    );
    // 0 / 负数兜底成默认 15 天
    assert.equal(
      shouldRunCheck({ autoUpdate: true, checkHours: 0, checkAt: now - 1 * DAY, now }),
      false,
    );
    assert.equal(
      shouldRunCheck({ autoUpdate: true, checkHours: 0, checkAt: now - 16 * DAY, now }),
      true,
    );
  });

  check("失败退避：30 分钟起翻倍，封顶 24 小时", () => {
    assert.equal(retryDelayMs(1), 30 * 60_000);
    assert.equal(retryDelayMs(2), 60 * 60_000);
    assert.equal(retryDelayMs(3), 120 * 60_000);
    assert.equal(retryDelayMs(4), 240 * 60_000);
    // 一路翻到封顶
    assert.equal(retryDelayMs(10), MAX_RETRY_DELAY_MS);
    assert.equal(retryDelayMs(99), MAX_RETRY_DELAY_MS);
    // 非法输入按第一次算
    assert.equal(retryDelayMs(0), 30 * 60_000);
    assert.equal(retryDelayMs(-5), 30 * 60_000);
  });
}

/* ------------------------------------------------------------------ */
/* 剧集改名 / 合并的排序与命名                                        */
/* ------------------------------------------------------------------ */

function renamePlanChecks(): void {
  const src = (name: string, episode: number | null, season: number | null = 1): EpisodeSource => ({
    path: `/media/剧/${name}`,
    name,
    episode,
    season,
  });

  check("自然排序：数字按大小比", () => {
    assert.ok(naturalCompare("第2集.mp4", "第10集.mp4") < 0, "2 应排在 10 前");
    assert.ok(naturalCompare("E9.mp4", "E10.mp4") < 0);
    assert.ok(naturalCompare("a.mp4", "b.mp4") < 0);
    assert.equal(naturalCompare("同名.mp4", "同名.mp4"), 0);
  });

  check("排序：有集号的在前，按集号升序", () => {
    const sorted = sortEpisodeSources([src("b.mp4", 10), src("a.mp4", null, null), src("c.mp4", 2)]);
    assert.deepEqual(
      sorted.map((s) => s.name),
      ["c.mp4", "b.mp4", "a.mp4"],
    );
  });

  check("排序：集号相同按文件名自然序", () => {
    const sorted = sortEpisodeSources([src("第2版.mp4", 5), src("第10版.mp4", 5)]);
    assert.deepEqual(
      sorted.map((s) => s.name),
      ["第2版.mp4", "第10版.mp4"],
    );
  });

  check("集号重排成连续的 E01…EN（顺序不变）", () => {
    const plan = buildRenamePlan({
      sources: [src("第12集.mp4", 12), src("第3集.mp4", 3), src("第7集.mp4", 7)],
      title: "我的剧",
      targetDir: "/media/我的剧",
    });
    assert.deepEqual(
      plan.items.map((i) => i.newEpisode),
      [1, 2, 3],
    );
    // 原顺序 3 → 7 → 12 保持不变
    assert.deepEqual(
      plan.items.map((i) => i.oldEpisode),
      [3, 7, 12],
    );
    assert.equal(plan.items[0].to, path.resolve("/media/我的剧", "我的剧S01E01.mp4"));
    assert.equal(plan.items[2].to, path.resolve("/media/我的剧", "我的剧S01E03.mp4"));
  });

  check("确认顺序：applyOrder 完全按用户给的路径顺序重排", () => {
    const sources = [src("a.mp4", 1), src("b.mp4", 2), src("c.mp4", 3)];
    const ordered = applyOrder(sources, ["/media/剧/c.mp4", "/media/剧/a.mp4", "/media/剧/b.mp4"]);
    assert.deepEqual(ordered.map((s) => s.name), ["c.mp4", "a.mp4", "b.mp4"]);
    // 不改入参
    assert.deepEqual(sources.map((s) => s.name), ["a.mp4", "b.mp4", "c.mp4"]);
  });

  check("确认顺序：没出现在 order 里的文件按原序垫在末尾，不丢文件", () => {
    const sources = [src("a.mp4", 1), src("b.mp4", 2), src("c.mp4", 3)];
    const ordered = applyOrder(sources, ["/media/剧/b.mp4"]);
    assert.deepEqual(ordered.map((s) => s.name), ["b.mp4", "a.mp4", "c.mp4"]);
  });

  check("确认顺序：buildRenamePlan 按 order 编号，而不是按原集号", () => {
    const plan = buildRenamePlan({
      sources: [src("第3集.mp4", 3), src("第1集.mp4", 1)],
      title: "剧名",
      targetDir: "/media/剧名",
      // 用户把「第3集」拖到第一位
      order: ["/media/剧/第3集.mp4", "/media/剧/第1集.mp4"],
    });
    assert.deepEqual(plan.items.map((i) => i.oldEpisode), [3, 1]);
    assert.deepEqual(
      plan.items.map((i) => i.newEpisode),
      [1, 2],
    );
    assert.ok(plan.items[0].to.endsWith("剧名S01E01.mp4"));
  });

  check("保存改名：目录名等于旧剧名时才允许把目录一起改", () => {
    assert.ok(canRenameDir("美人局", "美人局"));
    // 清洗后的比较：剧名前后的空格会被去掉
    assert.ok(canRenameDir("美人局", "  美人局  "));
    // 大小写差异在 Windows 上是同一个名字
    assert.ok(canRenameDir("The Show", "the show"));
    // 非法字符会被替换成下划线，清洗后与目录名不一致 → 保守地不动目录
    assert.equal(canRenameDir("美人局", "美人/局"), false);
  });

  check("保存改名：平台目录 / 外部大目录不会被当成剧集目录", () => {
    // 目录名不等于旧剧名 → 只改文件名，不动目录
    assert.equal(canRenameDir("telegram", "美人局"), false);
    assert.equal(canRenameDir("影片", "美人局"), false);
    assert.equal(canRenameDir("Season 01", "美人局"), false);
    // 旧剧名为空（还没有 tvshow.nfo）时一律不动目录
    assert.equal(canRenameDir("美人局", ""), false);
    assert.equal(canRenameDir("美人局", "   "), false);
  });

  check("保留原扩展名（mkv 不会变成 mp4）", () => {
    const plan = buildRenamePlan({
      sources: [src("第一集.mkv", 1)],
      title: "剧名",
      targetDir: "/media/剧名",
    });
    assert.ok(plan.items[0].to.endsWith("剧名S01E01.mkv"));
  });

  check("剧名里的非法字符被清洗", () => {
    assert.equal(seriesDirName("剧/名:测试?"), sanitizeSegment("剧/名:测试?", 120));
    const plan = buildRenamePlan({
      sources: [src("a.mp4", 1)],
      title: "剧/名",
      targetDir: "/media/x",
    });
    assert.ok(!plan.title.includes("/"), "剧名里不该留下路径分隔符");
  });

  check("临时名在每个源文件自己的目录里且互不相同", () => {
    const plan = buildRenamePlan({
      sources: [src("a.mp4", 1), src("b.mp4", 2)],
      title: "T",
      targetDir: "/media/T",
    });
    const tmps = plan.items.map((i) => i.tmp);
    assert.equal(new Set(tmps).size, tmps.length, "临时名必须唯一");
    for (const item of plan.items) {
      assert.equal(path.dirname(item.tmp), path.dirname(item.from));
      assert.ok(path.basename(item.tmp).startsWith(".tgsub-rn-"));
    }
  });

  check("冲突检测：目标已有同名且不在本次清单里", () => {
    const plan = buildRenamePlan({
      sources: [src("a.mp4", 1), src("b.mp4", 2)],
      title: "T",
      targetDir: "/media/T",
      existingNames: ["TS01E01.mp4"],
    });
    assert.deepEqual(plan.conflicts, ["TS01E01.mp4"]);
  });

  check("冲突检测：目标是本次要移动的文件本身不算冲突", () => {
    // 原地改名：文件已经在目标位置，名字也正好对
    const plan = buildRenamePlan({
      sources: [
        { path: "/media/T/TS01E01.mp4", name: "TS01E01.mp4", episode: 1, season: 1 },
        { path: "/media/T/TS01E02.mp4", name: "TS01E02.mp4", episode: 2, season: 1 },
      ],
      title: "T",
      targetDir: "/media/T",
      existingNames: ["TS01E01.mp4", "TS01E02.mp4"],
    });
    assert.deepEqual(plan.conflicts, []);
    assert.equal(countEffective(plan), 0, "已经叫对的文件不该再动");
  });

  check("集号重复与无集号都会给出提醒", () => {
    const plan = buildRenamePlan({
      sources: [src("a.mp4", 3), src("b.mp4", 3), src("c.mp4", null, null)],
      title: "T",
      targetDir: "/media/T",
    });
    assert.ok(
      plan.warnings.some((w) => w.includes("集号重复")),
      `应提醒集号重复，实际：${plan.warnings.join(" | ")}`,
    );
    assert.ok(
      plan.warnings.some((w) => w.includes("没有集号")),
      `应提醒缺集号，实际：${plan.warnings.join(" | ")}`,
    );
  });

  check("多季混在一起会提醒并统一按第一季编号", () => {
    const plan = buildRenamePlan({
      sources: [src("a.mp4", 1, 1), src("b.mp4", 1, 2)],
      title: "T",
      targetDir: "/media/T",
    });
    assert.equal(plan.season, 1);
    assert.ok(plan.warnings.some((w) => w.includes("多个季号")));
  });

  check("单集命名与路径同一套规则", () => {
    assert.equal(episodeFileName("剧名", 1, 5, ".mp4"), "剧名S01E05.mp4");
    assert.equal(episodeFileName("剧名", 2, 12, "mkv"), "剧名S02E12.mkv");
    // 空剧名走 sanitizeSegment 的兜底（"untitled"），路由层本来也不允许空剧名
    assert.equal(episodeFileName("", 1, 1, ".mp4"), `${sanitizeSegment("", 120)}S01E01.mp4`);
  });

  check("samePath 在当前平台上按大小写规则比较", () => {
    assert.equal(samePath("/a/b.mp4", "/a/b.mp4"), true);
    assert.equal(samePath("/a/b.mp4", "/a/c.mp4"), false);
    if (process.platform === "win32") {
      assert.equal(samePath("/a/B.mp4", "/a/b.mp4"), true);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 媒体删除相关的路径规则                                             */
/* ------------------------------------------------------------------ */

async function mediaPathChecks(): Promise<void> {
  const { collectVideos, episodeArtifacts, isUnderPath, isVideoFile } = await import(
    "../server/src/tg/mediapath"
  );
  const fs = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");

  const root = nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), "tgsub-mp-")), "剧");
  fs.mkdirSync(nodePath.join(root, "Season 01"), { recursive: true });
  const ep1 = nodePath.join(root, "剧S01E01.mp4");
  const ep2 = nodePath.join(root, "Season 01", "剧S01E02.mkv");
  fs.writeFileSync(ep1, "x");
  fs.writeFileSync(ep2, "x");
  fs.writeFileSync(nodePath.join(root, "剧S01E01.nfo"), "x");
  fs.writeFileSync(nodePath.join(root, "剧S01E01-thumb.jpg"), "x");
  fs.writeFileSync(nodePath.join(root, "poster.jpg"), "x");
  fs.writeFileSync(nodePath.join(root, "说明.txt"), "x");

  check("视频后缀识别", () => {
    assert.equal(isVideoFile("a.mp4"), true);
    assert.equal(isVideoFile("a.MKV"), true);
    assert.equal(isVideoFile("a.nfo"), false);
    assert.equal(isVideoFile("a.jpg"), false);
  });

  check("递归找视频：季目录里的也算", () => {
    const found = collectVideos(root).map((p) => nodePath.basename(p)).sort();
    assert.deepEqual(found, ["剧S01E01.mp4", "剧S01E02.mkv"]);
  });

  check("单集副产物：NFO 与 <base>-*.图片", () => {
    const art = episodeArtifacts(ep1);
    assert.equal(nodePath.basename(art.nfo), "剧S01E01.nfo");
    assert.deepEqual(art.images.map((p) => nodePath.basename(p)), ["剧S01E01-thumb.jpg"]);
  });

  check("剧集级封面不算进单集副产物", () => {
    const art = episodeArtifacts(ep2);
    assert.equal(art.images.length, 0);
  });

  check("路径包含判断", () => {
    assert.equal(isUnderPath(nodePath.join(root, "Season 01"), root), true);
    assert.equal(isUnderPath(root, root), true);
    assert.equal(isUnderPath(nodePath.dirname(root), root), false);
    assert.equal(isUnderPath(root, nodePath.join(root, "剧")), false);
  });

  fs.rmSync(nodePath.dirname(root), { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 网页 / m3u8 解析：HTML 转义、地址归一化、错误分类                   */
/* ------------------------------------------------------------------ */

function m3u8ParseChecks(): void {
  check("HTML 实体还原：&amp; 与数字实体", () => {
    assert.equal(decodeHtmlEntities("a=1&amp;b=2"), "a=1&b=2");
    assert.equal(decodeHtmlEntities("a=1&#38;b=2"), "a=1&b=2");
    assert.equal(decodeHtmlEntities("a=1&#x26;b=2"), "a=1&b=2");
    // 不认识的实体原样保留，别把正常文本改坏
    assert.equal(decodeHtmlEntities("100%&nbsp;ok"), "100% ok");
    assert.equal(decodeHtmlEntities("&notareal;"), "&notareal;");
  });

  check("媒体地址归一化：还原转义并去掉包裹引号", () => {
    const url = normalizeMediaUrl('"https://cdn.x/a.m3u8?auth_key=1-2-3&amp;v=3&amp;time=0"');
    assert.equal(url, "https://cdn.x/a.m3u8?auth_key=1-2-3&v=3&time=0");
    assert.ok(!url.includes("&amp;"));
  });

  check("从 HTML 里抽 m3u8 时就把 &amp; 解开", () => {
    const html = `<script>var u="https://cdn.x/v/a.m3u8?auth_key=1-2-3&amp;v=3&amp;via=hgdj";</script>`;
    const found = extractM3u8FromHtml(html, "https://site.com/video/1/");
    assert.equal(found, "https://cdn.x/v/a.m3u8?auth_key=1-2-3&v=3&via=hgdj");
  });

  check("相对地址按页面地址补全", () => {
    const html = `<video src="/hls/abc/master.m3u8"></video>`;
    assert.equal(extractM3u8FromHtml(html, "https://site.com/video/1/"), "https://site.com/hls/abc/master.m3u8");
  });

  check("页面标题去掉站名后缀", () => {
    assert.equal(cleanTitle("合租室友 - 短剧视频在线观看 | 黄果短剧"), "合租室友");
    assert.equal(cleanTitle("糖糖负债百万 - 91茄子 - 小黄书 xChina"), "糖糖负债百万");
    assert.equal(cleanTitle("没有分隔符的标题"), "没有分隔符的标题");
  });

  check("签名失效判定：403 / 404 / 签名类文案命中", () => {
    assert.equal(isSignatureError("源站拒绝下载（403）"), true);
    assert.equal(isSignatureError("视频地址已失效（404）"), true);
    assert.equal(isSignatureError("网络拉取失败，确认服务器能访问该地址"), false);
  });

  check("下载换线路判定：直连失败一律再试代理，用户取消除外", () => {
    assert.equal(shouldRetryRoute("源站拒绝下载（403）"), true);
    assert.equal(shouldRetryRoute("Connection timed out"), true);
    // ffmpeg 报错被 parseFfmpegError 翻成中文后，原来的英文正则一个都认不出，
    // 结果就是「直连优先」卡在第一次失败上 —— 这两条必须能换线路
    assert.equal(shouldRetryRoute("网络拉取失败，确认服务器能访问该地址（必要时配置代理）"), true);
    assert.equal(shouldRetryRoute("无法解析该 m3u8（可能是加密 / 非常规格式 / 源站返回错误）"), true);
    assert.equal(shouldRetryRoute("下载被取消"), false);
    assert.equal(shouldRetryRoute("下载已取消"), false);
    assert.equal(shouldRetryRoute("镜像里没有可用的 ffmpeg，无法下载 m3u8"), false);
  });

  check("线路切换提示文案与用户要求一致", () => {
    assert.equal(ROUTE_FALLBACK_NOTE, "因直连下载失败，使用代理进行下载");
  });

  check("解析换线路判定：403 / 挑战页也算可重试", () => {
    assert.equal(isRetryableResolve("抓取失败：HTTP 403"), true);
    assert.equal(isRetryableResolve("抓取失败：HTTP 429"), true);
    assert.equal(isRetryableResolve("连接超时"), true);
    assert.equal(isRetryableResolve("链接格式不对"), false);
  });
}

/* ------------------------------------------------------------------ */
/* 手动下载提交记录：状态判定与一行摘要                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 管理界面登录：口令哈希、输入校验、cookie 解析                       */
/* ------------------------------------------------------------------ */

async function loginChecks(): Promise<void> {
  await checkAsync("口令哈希按 scrypt 参数格式落盘，且不含明文", async () => {
    const hash = await hashPassword("Sup3r-secret");
    const parts = hash.split("$");
    assert.equal(parts.length, 6);
    assert.equal(parts[0], "scrypt");
    assert.equal(parts[1], "16384");
    assert.equal(parts[2], "8");
    assert.ok(parts[4].length > 10, "盐太短");
    assert.ok(parts[5].length > 40, "哈希太短");
    assert.ok(!hash.includes("Sup3r-secret"), "哈希里不该出现明文");
  });

  await checkAsync("正确密码校验通过（含中文与符号）", async () => {
    const hash = await hashPassword("口令-with-中文-1234");
    assert.equal(await verifyPassword("口令-with-中文-1234", hash), true);
  });

  await checkAsync("错误密码一律不通过", async () => {
    const hash = await hashPassword("correct-horse");
    assert.equal(await verifyPassword("correct-hors", hash), false);
    assert.equal(await verifyPassword("Correct-horse", hash), false);
    assert.equal(await verifyPassword("", hash), false);
    assert.equal(await verifyPassword("correct-horse ", hash), false);
  });

  await checkAsync("同一密码两次哈希不同（盐随机），但都能校验", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("same-password", a), true);
    assert.equal(await verifyPassword("same-password", b), true);
  });

  await checkAsync("坏掉/伪造的哈希记录只判失败，不抛错", async () => {
    const bad = [
      "",
      "plaintext",
      "scrypt$1$2$3",
      "bcrypt$16384$8$1$AAAA$BBBB",
      "scrypt$16384$8$1$$",
      "scrypt$0$8$1$AAAA$BBBB",
      // N 被改到超大：读库前就该拒，否则一次登录能把 CPU 钉死
      "scrypt$999999999$8$1$AAAA$BBBB",
    ];
    for (const value of bad) {
      assert.equal(await verifyPassword("anything", value), false, `应拒绝：${value}`);
    }
  });

  check("用户名规则", () => {
    assert.equal(usernameProblem("admin"), null);
    assert.equal(usernameProblem("张三"), null);
    assert.equal(usernameProblem("ops.admin-1"), null);
    assert.ok(usernameProblem(""));
    assert.ok(usernameProblem("a"), "单字符太短");
    assert.ok(usernameProblem("a b"), "不能有空格");
    assert.ok(usernameProblem("x".repeat(33)), "超过 32 位");
    assert.ok(usernameProblem("admin/root"), "不允许斜杠");
  });

  check("密码规则：拦太短、纯重复、纯顺序", () => {
    assert.equal(passwordProblem("abcd1234"), null);
    assert.ok(passwordProblem(""), "空密码");
    assert.ok(passwordProblem("abcd123"), "7 位太短");
    assert.ok(passwordProblem("aaaaaaaa"), "纯重复");
    assert.ok(passwordProblem("0123456789"), "纯顺序且不足 12 位");
    assert.equal(passwordProblem("0123456789ab"), null, "长度够了就放行");
    assert.ok(passwordProblem("x".repeat(129)), "超长");
  });

  check("两次输入不一致", () => {
    assert.equal(confirmProblem("abcdefgh", "abcdefgh"), null);
    assert.ok(confirmProblem("abcdefgh", "abcdefgi"));
  });

  check("Cookie 解析：同名子串、引号、空值、编码", () => {
    assert.equal(parseCookie("a=1; tgsub_sid=abc-123", "tgsub_sid"), "abc-123");
    assert.equal(parseCookie(undefined, "tgsub_sid"), "");
    assert.equal(parseCookie("", "tgsub_sid"), "");
    assert.equal(parseCookie("tgsub_sid=", "tgsub_sid"), "");
    assert.equal(parseCookie('tgsub_sid="quoted"', "tgsub_sid"), "quoted");
    // x 前缀同名不能被当成目标 cookie
    assert.equal(parseCookie("xtgsub_sid=nope; tgsub_sid=ok", "tgsub_sid"), "ok");
    assert.equal(parseCookie("tgsub_sid=a%3Db%26c", "tgsub_sid"), "a=b&c");
    // 孤立的 % 不合法，按原样返回，而不是当作没有
    assert.equal(parseCookie("tgsub_sid=bad%zz", "tgsub_sid"), "bad%zz");
  });

  /**
   * 浏览器可能同时发多个同名 cookie（换了访问地址、旧版本写过一份）。
   * 校验会话时要挨个试 —— 只认第一个的话，排在前面那份失效的旧 cookie
   * 会让「登录成功 → 马上又弹回登录页」反复发生。
   */
  check("Cookie 解析：同名多值全部解出来，顺序保持不变", () => {
    const values = parseCookies("tgsub_sid=old; theme=dark; tgsub_sid=new", "tgsub_sid");
    assert.equal(values.length, 2);
    assert.equal(values[0], "old");
    assert.equal(values[1], "new");
    // parseCookie 保持「只取第一个」的旧语义
    assert.equal(parseCookie("tgsub_sid=old; tgsub_sid=new", "tgsub_sid"), "old");
    // 空值不计入（浏览器偶尔会带 name= 的空 cookie）
    assert.equal(parseCookies("tgsub_sid=; tgsub_sid=ok", "tgsub_sid").length, 1);
    assert.deepEqual(parseCookies(null, "tgsub_sid"), []);
  });
}

/* ------------------------------------------------------------------ */
/* 分来源下载目录：默认值、路径拼接、用户输入校验                     */
/* ------------------------------------------------------------------ */

function mediaDirChecks(): void {
  check("默认目录：telegram / B站 / 小红书 / youtube / m3u8", () => {
    assert.equal(DEFAULT_SOURCE_DIRS.dir_telegram, "telegram");
    assert.equal(DEFAULT_SOURCE_DIRS.dir_bilibili, "B站");
    assert.equal(DEFAULT_SOURCE_DIRS.dir_xiaohongshu, "小红书");
    assert.equal(DEFAULT_SOURCE_DIRS.dir_youtube, "youtube");
    assert.equal(DEFAULT_SOURCE_DIRS.dir_m3u8, "m3u8");
    assert.equal(DIR_KEYS.length, 5);
  });

  check("平台 id 映射到各自的目录设置项", () => {
    assert.equal(platformDirKey("bilibili"), "dir_bilibili");
    assert.equal(platformDirKey("xiaohongshu"), "dir_xiaohongshu");
    assert.equal(platformDirKey("youtube"), "dir_youtube");
    assert.equal(platformDirKey("douyin"), null);
  });

  check("拼接：过滤空段、统一斜杠、去掉首尾斜杠", () => {
    assert.equal(joinRel("telegram", "美人局"), "telegram/美人局");
    assert.equal(joinRel("", "美人局"), "美人局");
    assert.equal(joinRel(null, undefined, ""), "");
    assert.equal(joinRel("/m3u8/", "/标题/"), "m3u8/标题");
    assert.equal(joinRel("影视\\B站", "UP"), "影视/B站/UP");
    assert.equal(joinRel("影视//B站", "UP"), "影视/B站/UP");
  });

  check("拼接：来源目录留空时文件直接落在下载根下", () => {
    assert.equal(joinRel("", "美人局") || null, "美人局");
    assert.equal(joinRel("", "") || null, null);
  });

  check("逐段清洗：斜杠保留，段内非法字符被替换", () => {
    assert.equal(sanitizeRelDir("telegram/美人局", 60), "telegram/美人局");
    assert.equal(sanitizeRelDir("a/b:c", 60), "a/b_c");
    assert.equal(sanitizeRelDir("   ", 60), "");
    assert.equal(sanitizeRelDir(null, 60), "");
  });

  check("用户输入：普通相对路径原样通过", () => {
    assert.equal(parseDirSetting("telegram", "/downloads").dir, "telegram");
    assert.equal(parseDirSetting(" 影视/B站 ", "/downloads").dir, "影视/B站");
    assert.equal(parseDirSetting("", "/downloads").dir, "");
    assert.equal(parseDirSetting(undefined, "/downloads").dir, "");
  });

  check("用户输入：下载根内的绝对路径自动转成相对", () => {
    assert.equal(parseDirSetting("/downloads/B站", "/downloads").dir, "B站");
    assert.equal(parseDirSetting("/downloads/影视/小红书/", "/downloads").dir, "影视/小红书");
    assert.equal(parseDirSetting("C:/downloads/youtube", "C:/downloads").dir, "youtube");
  });

  check("用户输入：下载根外的绝对路径被拒绝", () => {
    const r = parseDirSetting("/etc/passwd", "/downloads");
    assert.equal(r.dir, "");
    assert.ok(Boolean(r.error), "应当报错");
  });

  check("用户输入：.. 与 . 片段被拒绝", () => {
    assert.ok(Boolean(parseDirSetting("../../etc", "/downloads").error), ".. 应当报错");
    assert.ok(Boolean(parseDirSetting("a/../b", "/downloads").error), "夹在中间的 .. 也报错");
    assert.ok(Boolean(parseDirSetting("./B站", "/downloads").error), ". 也报错");
  });

  check("用户输入：非法字符与过深层级被拒绝", () => {
    assert.ok(Boolean(parseDirSetting("B站?", "/downloads").error), "问号应当报错");
    assert.ok(Boolean(parseDirSetting("a/b/c/d/e/f/g", "/downloads").error), "超过 6 层应当报错");
  });

  check("目录结构：telegram 剧集路径与平台路径不会重复套平台名", () => {
    const telegram = joinRel(DEFAULT_SOURCE_DIRS.dir_telegram, "美人局");
    assert.equal(telegram, "telegram/美人局");
    const bili = joinRel(DEFAULT_SOURCE_DIRS.dir_bilibili, "影视飓风", "标题 [BV1xx]");
    assert.equal(bili, "B站/影视飓风/标题 [BV1xx]");
    const web = joinRel(DEFAULT_SOURCE_DIRS.dir_m3u8, "标题");
    assert.equal(web, "m3u8/标题");
  });
}

function manualNoteChecks(): void {
  check("提交结果状态：入队 > 之前下过 > 没入队", () => {
    assert.equal(manualStatus({ queued: 2, existing: 3 }), "ok");
    assert.equal(manualStatus({ queued: 0, existing: 3 }), "existing");
    assert.equal(manualStatus({ queued: 0, existing: 0 }), "empty");
  });

  check("链接归类：t.me 算 Telegram，其余算网页", () => {
    assert.equal(kindOfLink("https://t.me/abc/123"), "telegram");
    assert.equal(kindOfLink("http://t.me/c/1234567890/45"), "telegram");
    assert.equal(kindOfLink("https://b23.tv/29inbIp"), "web");
    assert.equal(kindOfLink("https://example.com/a/index.m3u8"), "web");
  });

  check("Telegram 摘要：频道 · 消息号 · 文件数 · 入队数", () => {
    assert.equal(
      directNote({ channelTitle: "某频道", messageId: 1234, files: 2, queued: 2, existing: 0, skipped: 0 }),
      "某频道 · #1234 · 2 个文件 · 入队 2",
    );
  });

  check("Telegram 摘要：之前下过的不写「入队」", () => {
    assert.equal(
      directNote({ channelTitle: "某频道", messageId: 7, files: 3, queued: 0, existing: 3, skipped: 0 }),
      "某频道 · #7 · 3 个文件 · 已下过 3",
    );
  });

  check("第三方平台摘要：合集 + UP 主 + 时长 + 大小", () => {
    const note = platformNote(
      [{ title: "x", uploader: "影视飓风", duration: 1122, filesize: 419430400 }],
      { count: 12, mode: "one", capped: false },
    );
    assert.ok(note.startsWith("合集 12 个（只下第一个）"), note);
    assert.ok(note.includes("影视飓风"), note);
    assert.ok(note.includes("18:42"), note);
    assert.ok(note.includes("400.0 MB"), note);
  });

  check("第三方平台摘要：单个视频不写合集", () => {
    assert.equal(platformNote([{ uploader: "阿宇剪辑", duration: 178 }], null), "阿宇剪辑 · 2:58");
  });

  check("网页 / m3u8 摘要用保存目录", () => {
    assert.equal(webNote({ saveDir: "m3u8/测试视频" }), "m3u8/测试视频/");
    assert.equal(webNote({ saveDir: null }), "");
  });

  check("报错文案压缩成一行并截断", () => {
    assert.equal(clamp("  a\n\n  b\t c  "), "a b c");
    const long = clamp("错".repeat(400), 10);
    assert.equal(long.length, 10);
    assert.ok(long.endsWith("…"));
  });
}

/* ------------------------------------------------------------------ */
/* Telegram 消息链接 / 帖子评论链接解析（纯函数层）                      */
/* ------------------------------------------------------------------ */

function telegramLinkChecks(): void {
  check("公开频道消息链接：用户名 + 帖子 ID", () => {
    const p = parseTelegramLink("https://t.me/MMWYX1/3516");
    assert.equal(p?.kind, "public");
    assert.equal(p?.username, "mmwyx1");
    assert.equal(p?.messageId, 3516);
    assert.equal(p?.commentId, null);
    assert.equal(p?.postId, null);
  });

  check("私有频道消息链接：t.me/c/<id>/<msg>", () => {
    const p = parseTelegramLink("https://t.me/c/1234567890/3516");
    assert.equal(p?.kind, "private");
    assert.equal(p?.internalId, "1234567890");
    assert.equal(p?.messageId, 3516);
  });

  check("评论链接：?comment= 解析出帖子 ID 与评论 ID", () => {
    const p = parseTelegramLink("https://t.me/MMWYX1/3516?comment=55488");
    assert.equal(p?.messageId, 3516, "路径里的 ID 仍是帖子");
    assert.equal(p?.postId, 3516);
    assert.equal(p?.commentId, 55488);
    assert.equal(isCommentLink(p), true);
  });

  check("评论链接：私有频道 + 多参数 + fragment", () => {
    const p = parseTelegramLink("https://t.me/c/1234567890/3516?thread=3516&comment=55499#reply");
    assert.equal(p?.postId, 3516);
    assert.equal(p?.commentId, 55499);
    assert.equal(isCommentLink(p), true);
  });

  check("?single 等普通查询串不算评论", () => {
    const p = parseTelegramLink("https://t.me/MMWYX1/3516?single");
    assert.equal(p?.messageId, 3516);
    assert.equal(p?.commentId, null);
    assert.equal(isCommentLink(p), false);
  });

  check("comment 参数没数字 / 为 0 时忽略", () => {
    assert.equal(commentIdOf("https://t.me/a/1?comment="), null);
    assert.equal(commentIdOf("https://t.me/a/1?comment=0"), null);
    assert.equal(commentIdOf("https://t.me/a/1?comment=abc"), null);
    assert.equal(parseTelegramLink("https://t.me/MMWYX1/3516?comment=abc")?.commentId, null);
  });

  check("省略协议 / www / telegram.me 也能认", () => {
    assert.equal(parseTelegramLink("t.me/MMWYX1/3516?comment=55488")?.commentId, 55488);
    assert.equal(parseTelegramLink("https://www.telegram.me/MMWYX1/3516")?.username, "mmwyx1");
  });

  check("不是消息链接时返回 null", () => {
    assert.equal(parseTelegramLink(""), null);
    assert.equal(parseTelegramLink("https://b23.tv/29inbIp"), null);
    assert.equal(parseTelegramLink("https://t.me/MMWYX1"), null);
    assert.equal(parseTelegramLink("https://t.me/MMWYX1/not-a-number"), null);
  });

  check("从文字里挑链接时保留 ?comment= 且去重", () => {
    const links = extractTelegramLinks(
      "看这个 https://t.me/MMWYX1/3516?comment=55488 还有 https://t.me/MMWYX1/3516?comment=55488 " +
        "https://t.me/MMWYX1/3516?comment=55499",
    );
    assert.equal(links.length, 2);
    assert.ok(links.every((l) => l.includes("?comment=")));
    assert.ok(parseTelegramLink(links[0])?.commentId);
  });

  check("idString 兼容 bigint / 字符串 / PeerChannel / -100 标记", () => {
    assert.equal(idString(BigInt("1234567890")), "1234567890");
    assert.equal(idString("-1001234567890"), "1234567890");
    assert.equal(idString({ className: "PeerChannel", channelId: BigInt("77") }), "77");
    assert.equal(idString(undefined), null);
  });

  /* 1.3.10 报「帖子 replies 无 channel_id（comments=true, 90 条）」的真实原因：
   * gramjs 的 long 是 big-integer 的 BigInteger 实例 —— typeof 是 object、
   * 身上没有 channelId / id 字段，只能靠 toString()。只认原生 bigint 就会全解析成 null。 */
  check("idString 认得 gramjs 的 BigInteger（long 不是原生 bigint）", () => {
    const long = bigInt("1965425283");
    assert.equal(typeof long, "object");
    assert.equal((long as { channelId?: unknown }).channelId, undefined);
    assert.equal(idString(long), "1965425283");
    assert.equal(idString(bigInt("-1001234567890")), "1234567890");
    // PeerChannel / Channel / Message 里的 long 字段都是这种对象
    assert.equal(idString({ className: "PeerChannel", channelId: long }), "1965425283");
    assert.equal(idString({ className: "Channel", id: long }), "1965425283");
    assert.equal(idString({ id: bigInt("3516") }), "3516");
    // 脏对象依然返回 null，别把 "[object Object]" 当 ID
    assert.equal(idString({}), null);
    assert.equal(idString([1, 2]), null);
  });

  check("真实 gramjs 形状：replies / peerId / chats 全是 BigInteger", () => {
    const info = postReplyInfo(
      {
        messages: [
          { id: bigInt("3516"), replies: { comments: true, replies: 90, channelId: bigInt("1965425283") } },
        ],
      },
      3516,
    );
    assert.equal(info.comments, true);
    assert.equal(info.count, 90);
    assert.equal(info.channelId, "1965425283");

    const replies = {
      messages: [{ id: bigInt("55488"), peerId: { className: "PeerChannel", channelId: bigInt("1965425283") } }],
      chats: [
        {
          className: "Channel",
          id: bigInt("1965425283"),
          megagroup: true,
          title: "讨论组",
          accessHash: bigInt("-7123456789012345678"),
        },
      ],
    };
    assert.equal(threadGroupId(replies, "1001"), "1965425283");
    const group = pickDiscussionGroup(replies, "1001");
    assert.equal(group?.id, "1965425283");
    assert.equal(group?.accessHash, "-7123456789012345678");
    assert.equal(discussionEntityKey(group!), "-1001965425283");
    assert.equal(chatInfoOf(replies, "1965425283")?.accessHash, "-7123456789012345678");
    assert.equal(groupsFromChats(replies, "1001")[0]?.id, "1965425283");
    // getFullChannel 的 linkedChatId 也是同一个形状
    assert.equal(linkedGroupId({ fullChat: { linkedChatId: bigInt("1965425283") } }), "1965425283");
  });

  check("从 GetDiscussionMessage 返回里挑出讨论组（peerId 优先）", () => {
    const group = pickDiscussionGroup(
      {
        messages: [{ id: 900, peerId: { className: "PeerChannel", channelId: BigInt("2002") } }],
        chats: [
          { id: BigInt("1001"), title: "频道", className: "Channel" },
          { id: BigInt("2002"), title: "频道评论区", username: "mmwyx_chat", megagroup: true, className: "Channel" },
        ],
      },
      "1001",
    );
    assert.equal(group?.id, "2002");
    assert.equal(group?.username, "mmwyx_chat");
    assert.equal(group?.title, "频道评论区");
    assert.equal(discussionEntityKey(group!), "mmwyx_chat");
  });

  check("peerId 指向频道自己时回退到 megagroup", () => {
    const group = pickDiscussionGroup(
      {
        messages: [{ id: 3516, peerId: { channelId: BigInt("1001") } }],
        chats: [
          { id: BigInt("1001"), title: "频道", className: "Channel" },
          { id: BigInt("2002"), title: "评论组", megagroup: true, className: "Channel" },
        ],
      },
      "1001",
    );
    assert.equal(group?.id, "2002");
    assert.equal(discussionEntityKey(group!), "-1002002");
  });

  check("没有评论组时返回 null，entityKey 用 -100 标记形式", () => {
    assert.equal(pickDiscussionGroup({ messages: [], chats: [] }, "1001"), null);
    assert.equal(discussionEntityKey({ id: "42", username: null, accessHash: null, title: "" }), "-10042");
  });

  check("讨论组的 access_hash 会被带出来（不加入群组取评论的关键）", () => {
    const group = pickDiscussionGroup(
      {
        messages: [{ id: 900, peerId: { channelId: BigInt("2002") } }],
        chats: [
          { id: BigInt("1001"), title: "频道", className: "Channel" },
          {
            id: BigInt("2002"),
            title: "私密讨论组",
            megagroup: true,
            className: "Channel",
            accessHash: BigInt("-7123456789012345678"),
          },
        ],
      },
      "1001",
    );
    assert.equal(group?.username, null);
    assert.equal(group?.accessHash, "-7123456789012345678");
    // 没有 username 只能用 -100 标记键 + 库里存的 hash
    assert.equal(discussionEntityKey(group!), "-1002002");
  });

  check("hashString 只认整数串，脏值一律 null", () => {
    assert.equal(hashString(BigInt("-9007199254740993")), "-9007199254740993");
    assert.equal(hashString("12345"), "12345");
    assert.equal(hashString({ toString: () => "777" }), "777");
    assert.equal(hashString(null), null);
    assert.equal(hashString(""), null);
    assert.equal(hashString("abc"), null);
    assert.equal(hashString(undefined), null);
  });

  check("帖子 replies 字段能读出讨论组 ID 和评论开关", () => {
    const post = {
      messages: [
        {
          id: 3516,
          replies: { comments: true, replies: 12, channelId: BigInt("1965425283") },
        },
      ],
    };
    const info = postReplyInfo(post, 3516);
    assert.equal(info.comments, true);
    assert.equal(info.count, 12);
    assert.equal(info.channelId, "1965425283");
  });

  check("没开评论时 channelId 是 0，不能当成合法 ID", () => {
    const info = postReplyInfo({ messages: [{ id: 3516, replies: { comments: false, replies: 0, channelId: 0 } }] }, 3516);
    assert.equal(info.comments, false);
    assert.equal(info.channelId, null);
    // 字段缺失（老版本帖子）也当没开评论
    assert.equal(postReplyInfo({ messages: [{ id: 3516 }] }, 3516).channelId, null);
  });

  check("validId 把 0 当没有", () => {
    assert.equal(validId(0), null);
    assert.equal(validId("0"), null);
    assert.equal(validId(BigInt("2002")), "2002");
  });

  check("getReplies 的 chats 里能补到 access_hash / username", () => {
    const payload = {
      messages: [{ id: 55488, peerId: { channelId: BigInt("2002") } }],
      chats: [
        { id: BigInt("1001"), className: "Channel", title: "频道" },
        { id: BigInt("2002"), megagroup: true, title: "评论组", accessHash: BigInt("42"), username: "g" },
      ],
    };
    const info = chatInfoOf(payload, "2002");
    assert.equal(info?.accessHash, "42");
    assert.equal(info?.username, "g");
    assert.equal(info?.title, "评论组");
    assert.equal(chatInfoOf(payload, "9999"), null);
  });

  check("线程首条消息的 peerId 就是讨论组", () => {
    const payload = { messages: [{ id: 1, peerId: { channelId: BigInt("2002") } }] };
    assert.equal(threadGroupId(payload, "1001"), "2002");
    // 指回频道自己就丢掉
    assert.equal(threadGroupId({ messages: [{ peerId: { channelId: BigInt("1001") } }] }, "1001"), null);
  });

  check("getFullChannel 的 linked_chat_id 能取出讨论组（免加群的主路径）", () => {
    const payload = {
      fullChat: { id: BigInt("1001"), linkedChatId: BigInt("2002") },
      chats: [{ id: BigInt("2002"), megagroup: true, title: "评论组", accessHash: BigInt("77") }],
    };
    assert.equal(linkedGroupId(payload), "2002");
    // 频道没开评论 / 没关联讨论组时是 0
    assert.equal(linkedGroupId({ fullChat: { linkedChatId: 0 } }), null);
    assert.equal(linkedGroupId({ fullChat: {} }), null);
    assert.equal(linkedGroupId({}), null);
    // 同一份返回里的 chats 还带着 hash，一步就能补上
    assert.equal(chatInfoOf(payload, "2002")?.accessHash, "77");
  });

  check("对话框列表里排除频道自己和普通用户", () => {
    const chats = [
      { id: BigInt("1001"), className: "Channel", title: "频道" },
      { id: BigInt("2002"), className: "Channel", megagroup: true, accessHash: BigInt("7"), title: "讨论组" },
      { id: BigInt("3003"), className: "User", title: "某用户" },
    ];
    const groups = groupsFromChats({ chats }, "1001");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, "2002");
    assert.equal(groups[0].accessHash, "7");
  });

  check("讨论组没给 access_hash 时不硬编一个假值", () => {
    const group = pickDiscussionGroup(
      { messages: [{ id: 1, peerId: { channelId: BigInt("2002") } }], chats: [{ id: BigInt("2002"), megagroup: true }] },
      "1001",
    );
    assert.equal(group?.accessHash, null);
  });
}

/* ------------------------------------------------------------------ */
/* 下载队列调度：车道分配与封面 / 正片分阶段                           */
/* ------------------------------------------------------------------ */

function queuePlanChecks(): void {
  const tg = (id: number, kind: "art" | "video" | "other", priority = false): JobRef => ({
    id,
    external: false,
    kind,
    priority,
  });
  const ext = (id: number, priority = false): JobRef => ({ id, external: true, kind: "video", priority });
  const pick = (queue: JobRef[], active: JobRef[] = [], platformSlots = 3) =>
    pickNext({ queue, active, tgSlots: 1, platformSlots });

  check("空闲时只有正片：直接开下", () => {
    const r = pick([tg(1, "video")]);
    assert.equal(r?.job.id, 1);
  });

  check("空闲时先下封面图，再下正片", () => {
    const r = pick([tg(1, "video"), tg(2, "art")]);
    assert.equal(r?.job.id, 2);
    assert.equal(r?.reason, "cover");
  });

  check("没有可跑的封面图时不会被挡住", () => {
    // 队列里唯一的「封面」被标成外部任务（老库脏数据 / 已失效的 .art- 行）
    const dirty: JobRef = { id: 9, external: true, kind: "art", priority: false };
    assert.equal(pick([dirty, tg(1, "video")])?.job.id, 9); // 外部车道先跑它
    assert.equal(pick([dirty, tg(1, "video")], [], 0)?.job.id, 1); // 外部没空位时正片照下，不许干等
  });

  check("正片下载中：不插封面图（tgSlots=1 时车道已满）", () => {
    assert.equal(pick([tg(2, "art")], [tg(1, "video")]), null);
  });

  check("正片下载中（多车道）：只接非封面图", () => {
    const r = pickNext({
      queue: [tg(2, "art"), tg(3, "video")],
      active: [tg(1, "video")],
      tgSlots: 2,
      platformSlots: 3,
    });
    assert.equal(r?.job.id, 3);
    assert.equal(r?.reason, "video");
  });

  check("封面图下载中：不启动正片", () => {
    assert.equal(pick([tg(2, "video")], [tg(1, "art")]), null);
  });

  check("插队任务排到最后也能先跑", () => {
    const r = pick([tg(1, "video"), tg(2, "video", true)]);
    assert.equal(r?.job.id, 2);
    assert.equal(r?.reason, "priority");
  });

  check("第三方车道与 Telegram 车道互不排队", () => {
    const r = pick([tg(1, "video"), ext(2)]);
    assert.equal(r?.job.id, 2);
    assert.equal(r?.reason, "platform");
  });

  check("Telegram 在跑时第三方照样能并发", () => {
    assert.equal(pick([tg(2, "video")], [tg(1, "video")]), null); // tg 车道满、没外部任务
    assert.equal(pick([ext(3)], [tg(1, "video")])?.job.id, 3);
  });

  check("两条车道都占满时不再启动新任务", () => {
    assert.equal(pick([], [tg(1, "video"), ext(2)], 1), null);
  });

  check("空队列返回 null（调度器据此结束这一轮）", () => {
    assert.equal(pick([]), null);
  });
}

/**
 * 元数据页按来源分区：判定只依赖「下载记录的 source」与「相对下载根的第一段目录」，
 * 目录名取自设置（用户改名后仍要能认出来）。
 */
function originChecks(): void {
  const dirs = dirMapOf({});

  check("不同来源的目录名有默认值", () => {
    assert.equal(dirs.dir_telegram, "telegram");
    assert.equal(dirs.dir_bilibili, "B站");
    assert.equal(dirs.dir_m3u8, "m3u8");
  });

  check("空字符串回落默认目录（设置项被清空时不会认不出来）", () => {
    const map = dirMapOf({ dir_bilibili: "", dir_youtube: null });
    assert.equal(map.dir_bilibili, "B站");
    assert.equal(map.dir_youtube, "youtube");
  });

  check("用户改过的目录名照样能认出来", () => {
    const map = dirMapOf({ dir_bilibili: "影视/bili" });
    // 首段是「影视」而不是 bili —— 与 setDir 的设定一致：只比对第一段
    assert.equal(originOfRelPath("影视/bili/某剧/a.mp4", map), null);
    const flat = dirMapOf({ dir_bilibili: "bili" });
    assert.equal(originOfRelPath("bili/某剧/a.mp4", flat), "bilibili");
  });

  check("Telegram 下载直接归 telegram", () => {
    assert.equal(originOf("telegram", "telegram/某剧/a.mp4", dirs), "telegram");
  });

  check("m3u8 下载归 m3u8", () => {
    assert.equal(originOf("m3u8", "m3u8/某剧/a.mp4", dirs), "m3u8");
  });

  check("第三方平台按目录区分 B站 / 小红书 / YouTube", () => {
    assert.equal(originOf("platform", "B站/UP主/某剧/a.mp4", dirs), "bilibili");
    assert.equal(originOf("platform", "小红书/博主/某剧/a.mp4", dirs), "xiaohongshu");
    assert.equal(originOf("platform", "youtube/频道/某剧/a.mp4", dirs), "youtube");
  });

  check("第三方平台认不出目录时归到其它", () => {
    assert.equal(originOf("platform", "第三方/某剧/a.mp4", dirs), "other");
    assert.equal(originOf("platform", null, dirs), "other");
  });

  check("手动登记的条目：下载根外的算外部目录，根内的按位置归档", () => {
    assert.equal(originOf(null, null, dirs), "manual");
    assert.equal(originOf(null, "D:\\别的盘\\某剧\\a.mp4", dirs), "manual");
    assert.equal(originOf(null, "B站/UP主/某剧/a.mp4", dirs), "bilibili");
  });

  check("Windows 反斜杠路径也能判定", () => {
    assert.equal(originOf("platform", "B站\\UP主\\某剧\\a.mp4", dirs), "bilibili");
  });

  check("多个来源合成：单个取自己，多个是 mixed", () => {
    assert.equal(mergeOrigins(["telegram"]), "telegram");
    assert.equal(mergeOrigins([]), "other");
    assert.equal(mergeOrigins(["telegram", "bilibili"]), "mixed");
  });
}

/** 移动 / 复制：路径规划与记录前缀替换 */
function transferPlanChecks(): void {
  const exists = (p: string) => p.endsWith("已存在");

  check("正常搬运：目标目录下保持原名", () => {
    const plan = planTransfer([{ path: "/dl/B站/某剧", kind: "folder" }], "/dl/telegram", () => false);
    assert.equal(plan.items.length, 1);
    // Windows 上 path.join 用反斜杠，比对前统一成正斜杠
    assert.equal(plan.items[0].to.replace(/\\/g, "/").endsWith("/telegram/某剧"), true);
  });

  check("目标已有同名条目时跳过（不覆盖用户的影视文件）", () => {
    const plan = planTransfer([{ path: "/dl/B站/某剧", kind: "folder" }], "/dl/已存在", () => true);
    assert.equal(plan.items.length, 0);
    assert.match(plan.skipped[0].reason, /同名/);
  });

  check("同一批里重名也只搬第一个", () => {
    const plan = planTransfer(
      [
        { path: "/dl/B站/某剧", kind: "folder" },
        { path: "/dl/小红书/某剧", kind: "folder" },
      ],
      "/dl/telegram",
      () => false,
    );
    assert.equal(plan.items.length, 1);
    assert.equal(plan.skipped.length, 1);
  });

  check("原地搬运跳过", () => {
    const plan = planTransfer([{ path: "/dl/telegram/某剧", kind: "folder" }], "/dl/telegram", () => false);
    assert.equal(plan.items.length, 0);
    assert.match(plan.skipped[0].reason, /已经在这个目录/);
  });

  check("不能把目录移进它自己的子目录", () => {
    const plan = planTransfer([{ path: "/dl/某剧", kind: "folder" }], "/dl/某剧/子目录", () => false);
    assert.equal(plan.items.length, 0);
    assert.match(plan.skipped[0].reason, /自己内部/);
  });

  check("under 判定：相等算在下面", () => {
    assert.equal(isUnder("/dl/a", "/dl/a"), true);
    assert.equal(isUnder("/dl/a/b", "/dl/a"), true);
    assert.equal(isUnder("/dl/ab", "/dl/a"), false);
  });

  check("记录路径跟着搬：相等、子路径、无关", () => {
    const norm = (v: string | null) => (v === null ? null : v.replace(/\\/g, "/"));
    assert.equal(norm(replacePrefix("/dl/a/x.mp4", "/dl/a", "/dl/b")), "/dl/b/x.mp4");
    assert.equal(norm(replacePrefix("/dl/a", "/dl/a", "/dl/b")), "/dl/b");
    assert.equal(replacePrefix("/dl/ab/x.mp4", "/dl/a", "/dl/b"), null);
  });
}

/** 元数据页的排列方式：目录与分集各一套，取值非法要能回落 */
function sortChecks(): void {
  const folder = (name: string, fileCount: number, totalSize: number, updatedAt: number) => ({
    name,
    fileCount,
    totalSize,
    updatedAt,
  });
  const file = (name: string, size: number, episode: number | null, updatedAt: number) => ({
    name,
    size,
    episode,
    updatedAt,
  });

  check("排序参数非法时回落到名称升序", () => {
    assert.equal(normalizeSortKey("bogus"), "name");
    assert.equal(normalizeSortKey(undefined), "name");
    assert.equal(normalizeSortKey("size"), "size");
    assert.equal(normalizeSortOrder("sideways"), "asc");
    assert.equal(normalizeSortOrder("desc"), "desc");
  });

  check("目录按名称自然序：第2集排在 第10集 前面", () => {
    const list = [folder("剧 第10集", 1, 10, 0), folder("剧 第2集", 1, 10, 0)];
    const sorted = sortFolders(list, "name", "asc");
    assert.deepEqual(
      sorted.map((f) => f.name),
      ["剧 第2集", "剧 第10集"],
    );
  });

  check("目录按最近更新：降序是最新的在前", () => {
    const list = [
      folder("老剧", 3, 100, 1_000),
      folder("新剧", 3, 100, 9_000),
      folder("中剧", 3, 100, 5_000),
    ];
    assert.deepEqual(
      sortFolders(list, "updated", "desc").map((f) => f.name),
      ["新剧", "中剧", "老剧"],
    );
    assert.deepEqual(
      sortFolders(list, "updated", "asc").map((f) => f.name),
      ["老剧", "中剧", "新剧"],
    );
  });

  check("目录按体积与集数", () => {
    const list = [
      folder("大", 5, 9_000, 0),
      folder("小", 5, 1_000, 0),
      folder("多集", 40, 5_000, 0),
    ];
    assert.deepEqual(
      sortFolders(list, "size", "desc").map((f) => f.name),
      ["大", "多集", "小"],
    );
    assert.deepEqual(
      sortFolders(list, "episodes", "desc").map((f) => f.name),
      ["多集", "大", "小"],
    );
  });

  check("排序值相同时次级键仍是名称升序（降序也不反转）", () => {
    const list = [folder("乙", 1, 100, 5), folder("甲", 1, 100, 5), folder("丙", 1, 100, 5)];
    const sorted = sortFolders(list, "size", "desc");
    assert.deepEqual(
      sorted.map((f) => f.name),
      ["丙", "甲", "乙"],
    );
  });

  check("分集按集号排；认不出集号的永远垫底", () => {
    const files = [
      file("第10集.mp4", 1, 10, 0),
      file("花絮.mp4", 1, null, 0),
      file("第2集.mp4", 1, 2, 0),
    ];
    assert.deepEqual(
      sortFiles(files, "episodes", "asc").map((f) => f.name),
      ["第2集.mp4", "第10集.mp4", "花絮.mp4"],
    );
    // 降序时没集号的仍然垫底，不跟着倒到第一行
    assert.deepEqual(
      sortFiles(files, "episodes", "desc").map((f) => f.name),
      ["第10集.mp4", "第2集.mp4", "花絮.mp4"],
    );
  });

  check("分集按体积 / 最近更新", () => {
    const files = [
      file("a.mp4", 300, 1, 1_000),
      file("b.mp4", 100, 2, 5_000),
      file("c.mp4", 200, 3, 3_000),
    ];
    assert.deepEqual(
      sortFiles(files, "size", "asc").map((f) => f.name),
      ["b.mp4", "c.mp4", "a.mp4"],
    );
    assert.deepEqual(
      sortFiles(files, "updated", "desc").map((f) => f.name),
      ["b.mp4", "c.mp4", "a.mp4"],
    );
  });

  check("排序不改入参（返回新数组）", () => {
    const list = [folder("b", 1, 2, 0), folder("a", 1, 1, 0)];
    const sorted = sortFolders(list, "name", "asc");
    assert.notEqual(sorted, list);
    assert.deepEqual(
      list.map((f) => f.name),
      ["b", "a"],
    );
  });
}

function overviewChecks(): void {
  const probe = (status: ProbeLike["status"], label: string, note: string | null = null): ProbeLike => ({
    status,
    label,
    note,
  });

  check("概览状态权重：异常 > 留意 > 正常 > 未启用", () => {
    assert.ok(statusRank("error") > statusRank("warn"));
    assert.ok(statusRank("warn") > statusRank("ok"));
    assert.ok(statusRank("ok") > statusRank("off"));
  });

  check("概览汇总：跨分组统计，未启用不计入待处理", () => {
    const s = summarizeProbes([
      [probe("ok", "ffmpeg"), probe("warn", "sharp", "图片处理降级"), probe("off", "机器人")],
      [probe("error", "yt-dlp", "没装"), probe("ok", "队列")],
    ]);
    assert.equal(s.ok, 2);
    assert.equal(s.warn, 1);
    assert.equal(s.error, 1);
    assert.equal(s.off, 1);
    assert.equal(s.overall, "error");
    assert.equal(s.issues.length, 2);
  });

  check("概览汇总：异常排前面，同级保持原顺序", () => {
    const s = summarizeProbes([
      [probe("warn", "yt-dlp", "旧版"), probe("error", "ffmpeg", "挂了"), probe("warn", "sharp", "降级")],
    ]);
    assert.equal(s.overall, "error");
    assert.deepEqual(s.issues, ["ffmpeg：挂了", "yt-dlp：旧版", "sharp：降级"]);
  });

  check("概览汇总：只有留意或全未启用时整体状态正确", () => {
    assert.equal(summarizeProbes([[probe("ok", "Node"), probe("warn", "磁盘", "85%")]]).overall, "warn");
    assert.equal(summarizeProbes([[probe("off", "Emby"), probe("off", "Bot")]]).overall, "off");
    assert.equal(summarizeProbes([]).overall, "off");
    assert.deepEqual(summarizeProbes([[probe("off", "Bot", "用户主动关的")]]).issues, []);
  });

  check("磁盘占用率分档：80% 留意、92% 异常", () => {
    assert.equal(diskLevel(null), "off");
    assert.equal(diskLevel(NaN), "off");
    assert.equal(diskLevel(26), "ok");
    assert.equal(diskLevel(80), "warn");
    assert.equal(diskLevel(92), "error");
  });

  check("工具状态：可选组件缺失只算留意，有新版算留意", () => {
    assert.equal(toolStatus({ available: true }), "ok");
    assert.equal(toolStatus({ available: false }), "error");
    assert.equal(toolStatus({ available: false, optional: true }), "warn");
    assert.equal(toolStatus({ available: true, degraded: true }), "warn");
    assert.equal(toolStatus({ available: true, outdated: true }), "warn");
  });

  check("运行时长文案", () => {
    assert.equal(humanUptime(-1), "—");
    assert.equal(humanUptime(0), "0 秒");
    assert.equal(humanUptime(90), "1 分钟");
    assert.equal(humanUptime(3661), "1 小时 1 分");
    assert.equal(humanUptime(90000), "1 天 1 小时");
  });

  check("长路径省略保留头尾且不超长", () => {
    assert.equal(ellipsizePath(null), "—");
    assert.equal(ellipsizePath("/data/tgsub.db"), "/data/tgsub.db");
    const shortened = ellipsizePath("/a/very/long/path/to/chromium/chrome.exe", 16);
    assert.equal(shortened.length, 16);
    assert.ok(shortened.includes("…"));
    assert.ok(shortened.endsWith("e.exe"));
  });
}

/**
 * NFO 表单编辑：曾经因为嵌套块（actor / fileinfo）把后面的字段全吞掉，
 * 表现为「showtitle 填了保存后还是空的」且 NFO 里多出重复标签。
 */
function nfoChecks(): void {
  const HEAD = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>';
  const ep = (body: string) => `${HEAD}\n<episodedetails>\n${body}\n</episodedetails>\n`;
  const fill = (raw: string, patch: Partial<NfoFields>): string => {
    const parsed = parseNfo(raw);
    assert.ok(parsed, "NFO 应可解析");
    return applyFields(parsed, { ...EMPTY_NFO_FIELDS, ...fieldsFromNfo(parsed), ...patch });
  };

  check("常规单集 NFO 读出标题 / 集号，缺失标签为空", () => {
    const raw = ep("  <title>剧 S01E07</title>\n  <originaltitle>剧</originaltitle>\n  <season>1</season>\n  <episode>7</episode>");
    const fields = fieldsFromNfo(parseNfo(raw));
    assert.equal(fields.title, "剧 S01E07");
    assert.equal(fields.originaltitle, "剧");
    assert.equal(fields.episode, "7");
    assert.equal(fields.showtitle, "");
  });

  check("actor 嵌套块之后的 showtitle 不再被吞掉", () => {
    const raw = ep(
      "  <title>剧 S01E07</title>\n  <aired>2026-11-02</aired>\n  <actor>\n    <name>张三</name>\n    <role>爸爸</role>\n  </actor>\n  <showtitle></showtitle>",
    );
    const parsed = parseNfo(raw)!;
    assert.ok(parsed.children.some((c) => c.name === "actor" && c.nested));
    assert.equal(fieldsFromNfo(parsed).aired, "2026-11-02");
    assert.equal(fieldsFromNfo(parsed).showtitle, "");
    assert.equal(isNfoEditable(parsed), true, "嵌套块本身不该禁止表单编辑");
  });

  check("含 actor 时保存 showtitle：只写一个标签、值可重读、嵌套块原样保留", () => {
    const raw = ep(
      "  <title>剧 S01E07</title>\n  <actor>\n    <name>张三</name>\n  </actor>\n  <showtitle></showtitle>",
    );
    const out = fill(raw, { showtitle: "新剧名" });
    assert.equal((out.match(/<showtitle>/g) ?? []).length, 1);
    assert.equal(fieldsFromNfo(parseNfo(out)!).showtitle, "新剧名");
    assert.ok(out.includes("<name>张三</name>"));
    assert.ok(out.includes("<actor>"));
  });

  check("多层嵌套 fileinfo 不吞后续字段", () => {
    const raw = ep(
      "  <fileinfo>\n    <streamdetails>\n      <video><codec>h264</codec></video>\n    </streamdetails>\n  </fileinfo>\n  <title>剧 S01E01</title>\n  <aired>2026-11-02</aired>",
    );
    const fields = fieldsFromNfo(parseNfo(raw));
    assert.equal(fields.title, "剧 S01E01");
    assert.equal(fields.aired, "2026-11-02");
    assert.equal(isNfoEditable(parseNfo(raw)), true);
  });

  check("注释与 CDATA 里的尖括号不当成标签", () => {
    const raw = ep(
      "  <!-- <actor><name>假标签</name></actor> -->\n  <plot><![CDATA[<b>粗体</b> 与 <i>斜体</i>]]></plot>\n  <showtitle>真剧名</showtitle>",
    );
    const fields = fieldsFromNfo(parseNfo(raw));
    assert.equal(fields.showtitle, "真剧名");
    assert.equal(isNfoEditable(parseNfo(raw)), true);
  });

  check("CDATA 只是容器：读出来的 plot 不带 <![CDATA[", () => {
    const raw = ep("  <plot><![CDATA[小镇熟母……竟然偷偷钻进男厕所露出？]]></plot>");
    const fields = fieldsFromNfo(parseNfo(raw));
    assert.equal(fields.plot, "小镇熟母……竟然偷偷钻进男厕所露出？");
    assert.ok(!fields.plot.includes("CDATA"));
  });

  check("畸形 CDATA（<![[CDATA[ / 残留 ]]>）也能剥干净", () => {
    assert.equal(unwrapCdata("<![[CDATA[正文]]>"), "正文");
    assert.equal(unwrapCdata("<![[CDATA[正文]]>>"), "正文");
    assert.equal(unwrapCdata("普通正文"), "普通正文");
  });

  check("displayText 去掉 CDATA、HTML 标签并压掉空白", () => {
    assert.equal(displayText("<![CDATA[<b>粗体</b>\n  与 <i>斜体</i>]]>"), "粗体 与 斜体");
    assert.equal(displayText(""), "");
  });

  check("同名标签优先显示非空值，保存时收敛成一个", () => {
    const raw = ep("  <showtitle></showtitle>\n  <showtitle>旧剧名</showtitle>\n  <title>剧</title>");
    assert.equal(fieldsFromNfo(parseNfo(raw)).showtitle, "旧剧名");
    const out = fill(raw, { showtitle: "新剧名" });
    assert.equal((out.match(/<showtitle>/g) ?? []).length, 1);
    assert.equal(fieldsFromNfo(parseNfo(out)!).showtitle, "新剧名");
  });

  check("清空字段会删掉标签，其它字段不受影响", () => {
    const out = fill(ep("  <title>剧</title>\n  <studio>制片厂</studio>"), { studio: "" });
    assert.ok(!out.includes("studio"));
    assert.ok(out.includes("<title>剧</title>"));
  });

  check("特殊字符写入时转义、读回时还原", () => {
    const out = fill(ep("  <title>剧</title>"), { showtitle: 'A & B <C> "D"' });
    assert.ok(out.includes("<showtitle>A &amp; B &lt;C&gt; &quot;D&quot;</showtitle>"));
    assert.equal(fieldsFromNfo(parseNfo(out)!).showtitle, 'A & B <C> "D"');
  });

  check("自闭合 showtitle 可以被替换成有值的标签", () => {
    const out = fill(ep("  <title>剧</title>\n  <showtitle/>"), { showtitle: "新剧名" });
    assert.equal(fieldsFromNfo(parseNfo(out)!).showtitle, "新剧名");
  });

  check("可编辑字段自身含子标签时才禁止表单保存", () => {
    const raw = ep("  <plot><b>粗体</b></plot>\n  <title>剧</title>");
    assert.equal(isNfoEditable(parseNfo(raw)), false);
    assert.equal(fieldsFromNfo(parseNfo(raw)!).title, "剧");
  });

  check("解析不出来时不可编辑，且不会误判为可新建", () => {
    assert.equal(parseNfo("不是 XML"), null);
    assert.equal(isNfoEditable(null), false);
    assert.equal(isNfoEditable(parseNfo("不是 XML")), false);
  });

  check("新建的单集 NFO 合法且能读回 showtitle", () => {
    const raw = buildNfo("episode", {
      ...EMPTY_NFO_FIELDS,
      title: "剧 S01E01",
      showtitle: "剧",
      season: "1",
      episode: "1",
    });
    assert.equal(validateNfo(raw, "episode"), null);
    assert.equal(fieldsFromNfo(parseNfo(raw)!).showtitle, "剧");
  });

  check("畸形未闭合的内层标签不会让后续字段消失", () => {
    const raw = ep("  <actor><name>张三</actor>\n  <title>剧</title>\n  <showtitle>真剧名</showtitle>");
    const fields = fieldsFromNfo(parseNfo(raw));
    assert.equal(fields.title, "剧");
    assert.equal(fields.showtitle, "真剧名");
  });
}

/** 自动 / 一键生成 NFO 时的追溯字段与「合并而非覆盖」 */
function nfoTraceChecks(): void {
  const generated = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<episodedetails>
  <title>新剧名 S01E07</title>
  <showtitle>新剧名</showtitle>
  <originalfilename>生成时的文件名.mp4</originalfilename>
  <source>Telegram · 新频道</source>
  <uniqueid type="tgsub" default="true">tgsub:剧:S01E07</uniqueid>
</episodedetails>
`;
  const existing = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<episodedetails>
  <title>旧标题</title>
  <originalfilename>用户手写原名.mp4</originalfilename>
  <source>用户手写来源</source>
  <custom>保留我</custom>
  <actor><name>张三</name></actor>
</episodedetails>
`;

  check("Telegram 来源带频道名，原文件名优先取 file_name", () => {
    const trace = nfoTraceOf(
      {
        file_name: "原始视频.mp4",
        save_name: "剧名S01E01.mp4",
        source: "telegram",
        channel_title: "短剧频道",
        source_url: null,
      },
      "兜底.mp4",
    );
    assert.equal(trace.originalFileName, "原始视频.mp4");
    assert.equal(trace.sourceLabel, "Telegram · 短剧频道");
    assert.equal(trace.sourceUrl, null);
  });

  check("平台来源从原链接判定 B站 / 小红书 / YouTube", () => {
    const label = (url: string) =>
      nfoTraceOf({ source: "platform", source_url: url, file_name: "a.mp4" }, "x.mp4").sourceLabel;
    assert.equal(label("https://www.bilibili.com/video/BV1xx"), "B站");
    assert.equal(label("https://xhslink.cn/o/abc"), "小红书");
    assert.equal(label("https://youtu.be/abc"), "YouTube");
  });

  check("m3u8 与外部目录来源，原文件名回退链", () => {
    const m3u8 = nfoTraceOf({ source: "m3u8", source_url: "https://example.com/a.m3u8", file_name: "" }, "本地.mp4");
    assert.equal(m3u8.sourceLabel, "网页 / m3u8");
    assert.equal(m3u8.originalFileName, "本地.mp4");
    assert.equal(m3u8.sourceUrl, "https://example.com/a.m3u8");
    const manual = nfoTraceOf(null, "手动添加.mp4");
    assert.equal(manual.sourceLabel, "外部目录");
    assert.equal(manual.originalFileName, "手动添加.mp4");
    assert.equal(
      nfoTraceOf({ save_name: "落盘名.mp4", file_name: "" }, "x.mp4").originalFileName,
      "落盘名.mp4",
    );
  });

  check("生成 NFO 时保留已写过的原文件名与来源", () => {
    const out = mergeGeneratedNfo(existing, generated);
    assert.ok(out.includes("<originalfilename>用户手写原名.mp4</originalfilename>"));
    assert.ok(out.includes("<source>用户手写来源</source>"));
    assert.ok(!out.includes("生成时的文件名"));
    assert.ok(out.includes("<title>新剧名 S01E07</title>"));
    assert.ok(out.includes("<showtitle>新剧名</showtitle>"));
    assert.ok(out.includes("<uniqueid"));
    assert.ok(out.includes("<custom>保留我</custom>"));
    assert.ok(out.includes("<name>张三</name>"));
    assert.equal((out.match(/<title>/g) ?? []).length, 1);
  });

  check("原文没有追溯字段时由生成结果补写", () => {
    const raw = '<?xml version="1.0"?>\n<episodedetails>\n  <title>旧</title>\n</episodedetails>\n';
    const out = mergeGeneratedNfo(raw, generated);
    assert.ok(out.includes("<originalfilename>生成时的文件名.mp4</originalfilename>"));
    assert.ok(out.includes("<source>Telegram · 新频道</source>"));
    assert.ok(out.includes("<title>新剧名 S01E07</title>"));
    assert.equal(validateNfo(out, "episode"), null);
  });

  check("原文里是空的追溯标签时用生成结果补上", () => {
    const raw =
      "<episodedetails>\n  <originalfilename></originalfilename>\n  <source></source>\n  <title>旧</title>\n</episodedetails>\n";
    const out = mergeGeneratedNfo(raw, generated);
    assert.ok(out.includes("<originalfilename>生成时的文件名.mp4</originalfilename>"));
    assert.ok(out.includes("<source>Telegram · 新频道</source>"));
    assert.equal((out.match(/<source>/g) ?? []).length, 1);
  });

  check("多值模板字段整组刷新，生成结果里没有的标签保留", () => {
    const raw = "<episodedetails>\n  <tag>旧1</tag>\n  <tag>旧2</tag>\n  <genre>旧分类</genre>\n</episodedetails>\n";
    const gen = "<episodedetails>\n  <tag>新1</tag>\n  <tag>新2</tag>\n  <tag>新3</tag>\n</episodedetails>\n";
    const out = mergeGeneratedNfo(raw, gen);
    assert.equal((out.match(/<tag>/g) ?? []).length, 3);
    assert.ok(!out.includes("旧1") && !out.includes("旧2"));
    assert.ok(out.includes("<genre>旧分类</genre>"));
  });

  check("解析不出来时生成不动原文", () => {
    const bad = "这不是 XML";
    assert.equal(mergeGeneratedNfo(bad, generated), bad);
  });
}

async function embyViewChecks(): Promise<void> {
  // embyview 顶层 import 了 db，动态引入避免自检一启动就建库
  const { toCard } = await import("../server/src/tg/embyview");

  check("媒体卡片：评分保留一位小数并四舍五入", () => {
    assert.equal(toCard({ Id: "a", Name: "x", CommunityRating: 8.46 }).rating, 8.5);
    assert.equal(toCard({ Id: "a", Name: "x", CommunityRating: 7 }).rating, 7);
  });

  check("媒体卡片：缺少年份 / 评分 / 片长时给 null，不显示成 0", () => {
    const card = toCard({ Id: "a", Name: "x" });
    assert.equal(card.rating, null);
    assert.equal(card.year, null);
    assert.equal(card.runtimeMinutes, null);
    assert.equal(card.imageTag, null);
  });

  check("媒体卡片：RunTimeTicks 换算成分钟", () => {
    assert.equal(toCard({ Id: "a", Name: "x", RunTimeTicks: 6_000_000_000 }).runtimeMinutes, 10);
  });

  check("媒体卡片：季集号与已看进度（按秒）", () => {
    const card = toCard({
      Id: "e",
      Name: "第2集",
      Type: "Episode",
      ParentIndexNumber: 1,
      IndexNumber: 2,
      UserData: { Played: false, PlaybackPositionTicks: 30_000_000 },
    });
    assert.equal(card.season, 1);
    assert.equal(card.episode, 2);
    assert.equal(card.played, false);
    assert.equal(card.positionSeconds, 3);
  });

  check("媒体卡片：容器与分辨率取第一个媒体源里的视频轨", () => {
    const card = toCard({
      Id: "m",
      Name: "x",
      MediaSources: [
        { Container: "MKV", MediaStreams: [{ Type: "Audio", Height: 0 }, { Type: "Video", Height: 2160 }] },
      ],
    });
    assert.equal(card.container, "MKV");
    assert.equal(card.height, 2160);
  });
}

/**
 * 本地媒体库：封面槽位查找与「怎么播」的判定。
 *
 * 这两件事决定了界面上的两个关键表现 —— 有没有海报、点下去能不能播，
 * 所以单独盯住，别让后来改封面命名或加扩展名时悄悄退化。
 */
async function mediaLibChecks(): Promise<void> {
  // medialib 顶层 import 了 db / env，动态引入避免自检一启动就建库
  const { existingEpisodeThumb, findSeriesArt, isTrialCodec, playModeOf, streamUrl, thumbTimeFor } = await import(
    "../server/src/tg/medialib"
  );
  const fs = await import("node:fs");
  const os = await import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tgsub-medialib-"));
  const touch = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
  };

  try {
    check("封面：优先用目录里的 poster 槽位", () => {
      const dir = path.join(root, "a");
      touch(path.join(dir, "poster.jpg"));
      touch(path.join(dir, "fanart.jpg"));
      const art = findSeriesArt(dir);
      assert.equal(path.basename(art.poster ?? ""), "poster.jpg");
      assert.equal(path.basename(art.landscape ?? ""), "fanart.jpg");
    });

    check("封面：没有海报时回退到第一集的缩略图", () => {
      const dir = path.join(root, "b");
      const video = path.join(dir, "剧名S01E01.mp4");
      touch(video);
      touch(path.join(dir, "剧名S01E01-thumb.jpg"));
      const art = findSeriesArt(dir, video);
      assert.equal(path.basename(art.poster ?? ""), "剧名S01E01-thumb.jpg");
    });

    check("封面：什么都没有就返回 null，界面显示占位", () => {
      const dir = path.join(root, "c");
      fs.mkdirSync(dir, { recursive: true });
      assert.equal(findSeriesArt(dir).poster, null);
    });

    const probe = (codec: string | null) => ({
      duration: 1,
      width: 1920,
      height: 1080,
      videoCodec: codec,
      audioCodec: "aac",
      bitrate: 1000,
      fps: 25,
      container: "matroska",
      sizeBytes: 100,
    });

    check("播放：mp4 + h264 走原生直出（可拖进度条）", () => {
      assert.equal(playModeOf("a.mp4", probe("h264")), "direct");
      assert.equal(playModeOf("a.webm", probe("vp9")), "direct");
    });

    check("播放：mkv / ts 里的 h264 换封装后能播", () => {
      assert.equal(playModeOf("a.mkv", probe("h264")), "remux");
      assert.equal(playModeOf("a.ts", probe("h264")), "remux");
      assert.equal(playModeOf("a.AVI", probe("mpeg4")), "remux");
    });

    check("播放：没有显卡时 HEVC / H.265 判为播不了，别假装能播", () => {
      assert.equal(playModeOf("a.mp4", probe("hevc")), "unsupported");
      assert.equal(playModeOf("a.mkv", probe("hevc")), "unsupported");
      assert.equal(playModeOf("a.mp4", probe("h265")), "unsupported");
      // 关掉直连开关与不传 opts 的行为必须一致（默认不变）
      assert.equal(playModeOf("a.mp4", probe("hevc"), { allowHevc: false }), "unsupported");
      assert.equal(playModeOf("a.mp4", probe("hevc"), { allowHevc: false, hw: false }), "unsupported");
    });

    check("播放：有显卡时 HEVC 改走显卡转码（不再标播不了）", () => {
      // 容器是什么都无所谓：转码输出统一是 fMP4 + H.264
      assert.equal(playModeOf("a.mp4", probe("hevc"), { hw: true }), "transcode");
      assert.equal(playModeOf("a.mkv", probe("h265"), { hw: true }), "transcode");
      assert.equal(playModeOf("a.ts", probe("hevc"), { hw: true }), "transcode");
    });

    check("播放：直连开关优先于转码（Safari 这类能自解的不烧显卡）", () => {
      assert.equal(playModeOf("a.mp4", probe("hevc"), { allowHevc: true, hw: true }), "direct");
      assert.equal(playModeOf("a.mkv", probe("hevc"), { allowHevc: true, hw: true }), "remux");
    });

    check("播放：其它浏览器解不了的编码（ProRes / MPEG-2）有显卡也转码", () => {
      assert.equal(playModeOf("a.mov", probe("prores"), { hw: true }), "transcode");
      assert.equal(playModeOf("a.mpg", probe("mpeg2video"), { hw: true }), "transcode");
      // 没有显卡时这些照样是播不了
      assert.equal(playModeOf("a.mov", probe("prores")), "unsupported");
    });

    check("播放：直连开关只放行 HEVC，别的怪编码仍然拦下", () => {
      // prores / mpeg2 这些不是「看浏览器」的问题，开了直连也不该放过去
      assert.equal(playModeOf("a.mov", probe("prores"), { allowHevc: true }), "unsupported");
      assert.equal(playModeOf("a.mpg", probe("mpeg2video"), { allowHevc: true }), "unsupported");
      // 正常编码不受开关影响，也不该被转码（能直出就直出，省 GPU）
      assert.equal(playModeOf("a.mp4", probe("h264"), { allowHevc: true, hw: true }), "direct");
      assert.equal(playModeOf("a.mkv", probe("h264"), { hw: true }), "remux");
    });

    check("播放地址：转码带 mode=transcode，拖进度条带 start", () => {
      assert.ok(streamUrl("a.mkv", "transcode").includes("mode=transcode"));
      assert.ok(streamUrl("a.mp4", "direct").includes("path="));
      assert.ok(!streamUrl("a.mp4", "direct").includes("mode="));
      // 实时流拖动：从 125 秒重新起一路
      assert.ok(streamUrl("a.mkv", "transcode", 125.7).includes("start=125"));
      assert.ok(!streamUrl("a.mp4", "direct", 0).includes("start="));
    });

    check("播放：isTrialCodec 只认 hevc / h265，大小写不敏感", () => {
      assert.equal(isTrialCodec("hevc"), true);
      assert.equal(isTrialCodec("H265"), true);
      assert.equal(isTrialCodec("h264"), false);
      assert.equal(isTrialCodec(null), false);
      assert.equal(isTrialCodec(""), false);
    });

    check("播放：探测不到编码时按容器兜底", () => {
      assert.equal(playModeOf("a.mp4", null), "direct");
      assert.equal(playModeOf("a.mkv", null), "remux");
      // 编码名大小写不敏感
      assert.equal(playModeOf("a.MKV", probe("H264")), "remux");
    });

    check("单集缩略图：优先用下载时生成好的 -thumb 图", () => {
      const dir = path.join(root, "t1");
      const video = path.join(dir, "第1集.mp4");
      touch(video);
      touch(path.join(dir, "第1集-thumb.jpg"));
      assert.equal(path.basename(existingEpisodeThumb(video) ?? ""), "第1集-thumb.jpg");
    });

    check("单集缩略图：没有 -thumb 时才退到同名图片，再没有就返回 null", () => {
      const dir = path.join(root, "t2");
      const video = path.join(dir, "第2集.mkv");
      touch(video);
      // 同名 jpg 也要认（有些下载会直接存 <base>.jpg）
      touch(path.join(dir, "第2集.jpg"));
      assert.equal(path.basename(existingEpisodeThumb(video) ?? ""), "第2集.jpg");

      const bare = path.join(root, "t3", "第3集.mp4");
      touch(bare);
      assert.equal(existingEpisodeThumb(bare), null);
    });

    check("单集缩略图：抽帧位置跳过片头，短视频退回第一帧", () => {
      // 长片取 12% 处，且不早于 3 秒
      assert.equal(thumbTimeFor(600), 72);
      assert.equal(thumbTimeFor(20), 3);
      // 太短（<5 秒）直接第 0 秒，免得 ffmpeg 抽到空帧
      assert.equal(thumbTimeFor(3), 0);
      // 时长未知时取一个保守的中间位置
      assert.equal(thumbTimeFor(null), 6);
      // 结尾前留 1 秒，避免越界
      assert.ok(thumbTimeFor(10) <= 9);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* 硬件解码 / 显卡转码                                                 */
/* ------------------------------------------------------------------ */

async function hwDecodeChecks(): Promise<void> {
  const { buildTranscodeArgs, parseEncoders, parseHwaccels, pickAccel, transcodeBitrateKbps, transcodeHeight } =
    await import("../server/src/tg/hwdecode");

  check("硬解：解析 ffmpeg -hwaccels 的输出", () => {
    const out = ["Hardware acceleration methods:", "vaapi", "qsv", "cuda", "vaapi", ""].join("\n");
    const list = parseHwaccels(out);
    assert.deepEqual(list, ["vaapi", "qsv", "cuda"]);
    // 空输入 / 只有标题也不能崩
    assert.deepEqual(parseHwaccels(""), []);
    assert.deepEqual(parseHwaccels("Hardware acceleration methods:\n"), []);
  });

  check("硬解：只从 -encoders 里挑视频编码器，别把音频当视频", () => {
    const out = [
      "Encoders:",
      " V..... = Video",
      " A..... = Audio",
      " ------",
      " V....D h264_vaapi           H.264/AVC (VAAPI)",
      " V....D h264_qsv             H.264/AVC (Intel Quick Sync Video)",
      " V..... libx264              libx264 H.264",
      " A....D aac                  AAC",
      " A....D h264_nvenc_audio_fake_not_real",
    ].join("\n");
    const list = parseEncoders(out);
    assert.ok(list.includes("h264_vaapi"));
    assert.ok(list.includes("h264_qsv"));
    assert.ok(list.includes("libx264"));
    assert.ok(!list.includes("aac"));
    assert.ok(!list.includes("h264_nvenc_audio_fake_not_real"));
  });

  check("硬解：Linux 优先 VAAPI，其次 QSV；Windows 不选 VAAPI", () => {
    assert.deepEqual(pickAccel(["vaapi", "qsv"], ["h264_vaapi", "h264_qsv"], "linux"), {
      accel: "vaapi",
      encoder: "h264_vaapi",
    });
    // 只编了 qsv 的精简镜像
    assert.deepEqual(pickAccel(["qsv"], ["h264_qsv"], "linux"), { accel: "qsv", encoder: "h264_qsv" });
    // Windows 上 ffmpeg 不会列 vaapi，即使列了也不能用
    assert.deepEqual(pickAccel(["vaapi", "qsv"], ["h264_vaapi", "h264_qsv"], "win32"), {
      accel: "qsv",
      encoder: "h264_qsv",
    });
    // 有加速方式但没有对应的 H.264 编码器 → 用不了
    assert.equal(pickAccel(["vaapi"], ["libx264"], "linux"), null);
    assert.equal(pickAccel([], ["libx264"], "linux"), null);
  });

  check("硬解：转码目标高度不超过 1080，不放大，取偶数", () => {
    assert.equal(transcodeHeight(2160), 1080);
    assert.equal(transcodeHeight(1080), 1080);
    assert.equal(transcodeHeight(720), 720);
    assert.equal(transcodeHeight(481), 480);
    assert.equal(transcodeHeight(null), 1080);
    assert.equal(transcodeHeight(0), 1080);
  });

  check("硬解：码率按高度分档", () => {
    assert.equal(transcodeBitrateKbps(1080), 6000);
    assert.equal(transcodeBitrateKbps(720), 3500);
    assert.equal(transcodeBitrateKbps(480), 1800);
    assert.equal(transcodeBitrateKbps(240), 1000);
  });

  check("硬解：VAAPI 参数包含硬解设备、hwupload 与硬编 h264_vaapi", () => {
    const args = buildTranscodeArgs({
      input: "/downloads/a.mkv",
      accel: "vaapi",
      device: "/dev/dri/renderD128",
      sourceHeight: 2160,
    });
    const text = args.join(" ");
    assert.ok(text.includes("-hwaccel vaapi"), "要有硬解");
    assert.ok(text.includes("-hwaccel_device /dev/dri/renderD128"), "解码设备");
    assert.ok(text.includes("-vaapi_device /dev/dri/renderD128"), "滤镜设备");
    assert.ok(text.includes("scale=-2:1080"), "4K 降到 1080");
    assert.ok(text.includes("hwupload"), "系统内存帧要上传才能硬编");
    assert.ok(text.includes("-c:v h264_vaapi"), "硬编 H.264");
    assert.ok(text.includes("-c:a aac"), "音频转 AAC");
    assert.ok(text.includes("frag_keyframe+empty_moov"), "要能边转边播");
    assert.equal(args[args.length - 1], "pipe:1");
    // 只带首条视频 + 首条音频，字幕 / 数据轨不进流
    assert.ok(text.includes("-map 0:v:0?"));
    assert.ok(text.includes("-sn -dn"));
  });

  check("硬解：QSV 走 h264_qsv，不塞 hwupload", () => {
    const args = buildTranscodeArgs({
      input: "/downloads/a.mkv",
      accel: "qsv",
      device: "/dev/dri/renderD128",
      sourceHeight: 1080,
    });
    const text = args.join(" ");
    assert.ok(text.includes("-hwaccel qsv"));
    assert.ok(text.includes("-c:v h264_qsv"));
    assert.ok(!text.includes("hwupload"));
    assert.ok(!text.includes("vaapi"));
  });

  check("硬解：软件兜底用 libx264（只在显式配置时才会走到）", () => {
    const args = buildTranscodeArgs({ input: "/downloads/a.mov", accel: "software", sourceHeight: 720 });
    const text = args.join(" ");
    assert.ok(text.includes("-c:v libx264"));
    assert.ok(text.includes("-crf 22"));
    assert.ok(!text.includes("hwaccel"));
  });

  check("硬解：拖动进度条时 -ss 必须放在 -i 之前（输入侧 seek）", () => {
    const args = buildTranscodeArgs({
      input: "/downloads/a.mkv",
      accel: "vaapi",
      device: "/dev/dri/renderD128",
      sourceHeight: 1080,
      startSec: 125.7,
    });
    const ss = args.indexOf("-ss");
    const input = args.indexOf("-i");
    assert.ok(ss >= 0 && input > ss, "-ss 要在 -i 前面");
    assert.equal(args[ss + 1], "125.700");
    // 不带 start 时不能出现 -ss
    const plain = buildTranscodeArgs({ input: "a.mkv", accel: "vaapi", device: "/dev/dri/renderD128" });
    assert.equal(plain.includes("-ss"), false);
  });
}

async function main(): Promise<void> {
  const suites: Array<[string, () => unknown]> = [
    ["剧集目录用例", () => seriesDirChecks()],
    ["元数据页文件管理器用例", () => fileManagerChecks()],
    ["日志存储用例", () => logStoreChecks()],
    ["权限检查用例", () => permissionChecks()],
    ["Emby 用例", () => embyChecks()],
    ["Emby 入库用例", () => embyNotifyChecks()],
    ["Emby 媒体库用例", () => embyViewChecks()],
    ["本地媒体库用例", () => mediaLibChecks()],
    ["硬件解码用例", () => hwDecodeChecks()],
    ["缓存清理用例", () => cacheChecks()],
    ["网络代理用例", () => proxyChecks()],
    ["网络线路用例", () => netRouteChecks()],
    ["第三方平台用例", () => platformChecks()],
    ["yt-dlp 更新排期用例", () => updatePlanChecks()],
    ["剧集改名合并用例", () => renamePlanChecks()],
    ["手动下载记录用例", () => manualNoteChecks()],
    ["Telegram 评论链接用例", () => telegramLinkChecks()],
    ["分来源下载目录用例", () => mediaDirChecks()],
    ["下载队列调度用例", () => queuePlanChecks()],
    ["管理界面登录用例", () => loginChecks()],
    ["m3u8 解析用例", () => m3u8ParseChecks()],
    ["ffmpeg 解析用例", () => ffmpegProbeChecks()],
    ["媒体删除路径用例", () => mediaPathChecks()],
    ["媒体来源分区用例", () => originChecks()],
    ["媒体移动复制用例", () => transferPlanChecks()],
    ["媒体排列方式用例", () => sortChecks()],
    ["概览状态汇总用例", () => overviewChecks()],
    ["NFO 表单编辑用例", () => nfoChecks()],
    ["NFO 生成追溯用例", () => nfoTraceChecks()],
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
