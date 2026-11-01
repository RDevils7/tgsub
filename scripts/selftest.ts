/**
 * 核心逻辑自检：不依赖 Telegram 网络，验证关键词匹配、媒体解析与路径生成。
 * 运行：npm run selftest
 */
import assert from "node:assert/strict";
import path from "node:path";
import { matchText } from "../server/src/match";
import { extractMedia, groupIdOf, messageText, targetRelativePath } from "../server/src/tg/media";
import { sanitizeSegment, splitKeywords, toNumber } from "../server/src/utils";
import { fallbackFolderName, parseCaptionMeta, parseSeriesCaption, planFileNames } from "../server/src/tg/naming";
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

async function embyChecks(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const { default: sharp } = await import("sharp");
  const { encodeMeta, finalizeMedia } = await import("../server/src/tg/emby");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tgsub-emby-"));
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
  await acheck("生成三张封面并按比例裁剪", async () => {
    const poster = await sharp(path.join(dir, "poster.jpg")).metadata();
    assert.deepEqual([poster.width, poster.height], [1000, 1500]);
    const landscape = await sharp(path.join(dir, "landscape.jpg")).metadata();
    assert.deepEqual([landscape.width, landscape.height], [1920, 1080]);
    const fanart = await sharp(path.join(dir, "fanart.jpg")).metadata();
    assert.deepEqual([fanart.width, fanart.height], [1920, 1080]);
  });
  await acheck("临时封面文件已清理", async () => {
    const left = (await fs.readdir(dir)).filter((n) => n.startsWith(".art-"));
    assert.equal(left.length, 0);
  });

  await fs.rm(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  try {
    await embyChecks();
  } catch (err) {
    console.error(`  \u2717 Emby 用例异常: ${(err as Error).message}`);
    process.exitCode = 1;
  }
  console.log(`\n通过 ${passed} 项自检${process.exitCode ? "（存在失败）" : "，全部正常"}\n`);
}

void main();
