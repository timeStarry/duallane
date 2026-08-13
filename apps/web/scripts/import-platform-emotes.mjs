import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(webRoot, "shared", "emote-packs.json");
const manifestPath = path.join(webRoot, "public", "emotes", "manifest.json");
const emoteRoot = path.join(webRoot, "public", "emotes");
const userAgent = "duallane-emote-import/1.0";

const sources = {
  bili: "https://api.bilibili.com/x/emote/package?business=reply&ids=1",
  feishu: "https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce.md",
  heybox: "https://static.max-c.com/heybox_web/emoji/cube/cube_emoji_v9.png",
  tieba: "https://github.com/microlong666/Tieba_mobile_emotions",
  xiaohongshu: "https://github.com/HuangxupingSDSC/xhs-emoji",
};

const xiaohongshuLabels = [
  "微笑", "害羞", "失望", "汗颜", "哇", "喝奶茶", "自拍", "偷笑", "飞吻", "石化",
  "笑哭", "赞", "暗中观察", "买爆", "大笑", "色色", "生气", "哭惹", "萌萌哒", "斜眼",
  "可怜", "鄙视", "皱眉", "抓狂", "捂脸", "派对", "吧唧", "惊恐", "抠鼻", "再见",
  "叹气", "睡觉", "得意", "吃瓜", "扶墙", "黑薯问号", "黄金薯", "吐舌头", "扯脸", "dog",
];

const bilibiliCommonItems = [
  ["doge", "doge"], ["smile", "微笑"], ["joy", "笑哭"], ["melon", "吃瓜"], ["call", "打call"],
  ["ok", "OK"], ["sob", "大哭"], ["spicy-eyes", "辣眼睛"], ["funny", "滑稽"], ["joyful-tears", "喜极而泣"],
  ["grin", "呲牙"], ["wow", "妙啊"], ["heart", "给心心"], ["blush", "脸红"], ["oh", "哦呼"],
  ["love", "喜欢"], ["sour", "酸了"], ["shy", "害羞"], ["dislike", "嫌弃"], ["confused", "疑惑"],
  ["snicker", "偷笑"], ["surprised", "惊讶"], ["cover", "捂脸"], ["sinister", "阴险"], ["blank", "呆"],
  ["nose-pick", "抠鼻"], ["laugh", "大笑"], ["amazed", "惊喜"], ["like", "点赞"], ["speechless", "无语"],
  ["clap", "鼓掌"], ["awkward", "尴尬"], ["wronged", "委屈"], ["angry", "生气"], ["thinking", "思考"],
  ["bye", "再见"],
];

const bilibiliLegacyAliases = {
  like: ["thumbs-up", "赞"],
  love: ["love"],
};

const heyboxItems = [
  ["11", "哭泣"], ["12", "酷"], ["13", "doge"], ["14", "喜欢"], ["15", "黑人问号"], ["16", "惊讶"],
  ["21", "开心"], ["22", "捂脸哭"], ["23", "晕"], ["24", "感动"], ["25", "委屈"], ["26", "并不简单"],
  ["31", "乖"], ["32", "笑cry"], ["33", "怒"], ["34", "滑稽"], ["35", "沧桑"], ["36", "凄凉"],
  ["41", "赞"], ["42", "学习"], ["43", "叹气"], ["44", "加油"], ["45", "摊手"], ["46", "喷水"],
  ["51", "打脸"], ["52", "H币"], ["53", "生气"], ["54", "困"], ["55", "闭嘴"], ["56", "吐"],
  ["61", "咕咕"], ["62", "微笑"], ["63", "哇"], ["64", "汗"], ["65", "吓"], ["66", "睡觉"],
  ["71", "2023"], ["72", "圣诞树"], ["73", "庆祝"], ["74", "庆祝-圣诞"], ["75", "你懂我"], ["76", "我懂你"],
  ["81", "阳"], ["82", "比心"], ["83", "wota"], ["84", "鹅"], ["85", "握草"], ["86", "这是什么鸟"],
  ["91", "上学-乐"], ["92", "上学-丧"], ["93", "打咩"], ["94", "超人"], ["95", "僵尸"], ["96", "窝囊"],
  ["101", "小鸡"], ["102", "摸摸头"], ["103", "电牛"], ["104", "摘墨镜"], ["105", "悟空"], ["106", "2024"],
  ["111", "良民"], ["112", "嬉水女王"], ["113", "2025"],
];

const tiebaLabels = [
  "呵呵", "哈哈", "吐舌", "啊", "酷", "怒", "开心", "汗", "泪", "黑线",
  "鄙视", "不高兴", "真棒", "钱", "疑问", "阴险", "吐", "咦", "委屈", "花心",
  "呼", "笑眼", "冷", "太开心", "滑稽", "勉强", "狂汗", "乖", "睡觉", "惊哭",
  "生气", "惊讶", "喷", "爱心", "心碎", "玫瑰", "礼物", "彩虹", "星星月亮", "太阳",
  "钱币", "灯泡", "茶杯", "蛋糕", "音乐", "haha", "胜利", "大拇指", "弱", "OK",
];

async function main() {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const currentById = new Map(catalog.map((pack) => [pack.id, pack]));
  const generated = {
    bili: await importBilibili(currentById.get("bili")),
    xiaohongshu: await importXiaohongshu(),
    heybox: await importHeybox(),
    tieba: await importTieba(),
    feishu: await importFeishu(currentById.get("feishu")),
  };
  const orderedIds = ["emoji", "bili", "wechat", "feishu", "xiaohongshu", "heybox", "tieba", "douyin", "qq"];
  const defaultEnabled = new Set(["emoji", "bili", "wechat", "feishu"]);
  const nextCatalog = orderedIds.map((id) => ({
    ...(generated[id] ?? currentById.get(id)),
    defaultEnabled: defaultEnabled.has(id),
  }));
  await writeFile(catalogPath, `${JSON.stringify(nextCatalog, null, 2)}\n`);
  await writeFile(manifestPath, `${JSON.stringify({
    packs: nextCatalog.map((pack) => ({ ...pack, source: sources[pack.id] ?? sourceForExistingPack(pack.id) })),
  }, null, 2)}\n`);
  console.log(nextCatalog.map((pack) => `${pack.label}: ${pack.items.length}`).join("\n"));
}

async function importBilibili(currentPack) {
  const payload = await fetchJson(sources.bili, { Referer: "https://www.bilibili.com/" });
  const entries = payload?.data?.packages?.[0]?.emote ?? [];
  if (entries.length < 100) throw new Error(`Bilibili catalog unexpectedly contains ${entries.length} items.`);
  const currentItems = currentPack?.items ?? [];
  const byLabel = new Map(currentItems.flatMap((item) => [item.label, ...(item.aliases ?? [])].map((label) => [normalizeLabel(label), item])));
  const commonByLabel = new Map(bilibiliCommonItems.map(([id, label]) => [normalizeLabel(label), { id, label }]));
  const items = [];
  const itemById = new Map();
  for (const entry of entries) {
    const label = stripBrackets(entry.text) || String(entry.id);
    const common = commonByLabel.get(normalizeLabel(label));
    const existing = common ?? byLabel.get(normalizeLabel(label));
    const id = common?.id ?? existing?.id ?? `id-${entry.id}`;
    const src = `/emotes/bili/${id}.png`;
    await writeRemoteImage(entry.url, src);
    const aliases = unique([
      ...(existing?.aliases ?? []),
      ...(bilibiliLegacyAliases[id] ?? []),
      entry.text,
      entry.meta?.alias,
      label,
    ]);
    const duplicate = itemById.get(id);
    if (duplicate) {
      duplicate.aliases = unique([...duplicate.aliases, ...aliases]);
      continue;
    }
    const item = {
      kind: "image",
      id,
      label,
      token: existing?.token ?? `[bili:${id}]`,
      src,
      aliases,
    };
    items.push(item);
    itemById.set(id, item);
  }
  const commonOrder = new Map(bilibiliCommonItems.map(([, label], index) => [normalizeLabel(label), index]));
  items.sort((left, right) => {
    const leftOrder = commonOrder.get(normalizeLabel(left.label)) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = commonOrder.get(normalizeLabel(right.label)) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
  return { id: "bili", label: "B站", items };
}

async function importXiaohongshu() {
  const items = [];
  for (const [index, label] of xiaohongshuLabels.entries()) {
    const id = String(index + 1).padStart(2, "0");
    const src = `/emotes/xiaohongshu/${id}.png`;
    const remote = `https://raw.githubusercontent.com/HuangxupingSDSC/xhs-emoji/main/${encodeURIComponent(label)}.png`;
    await writeRemoteImage(remote, src);
    items.push({ kind: "image", id, label, token: `[xiaohongshu:${id}]`, src, aliases: [`[${label}R]`, label] });
  }
  return { id: "xiaohongshu", label: "小红书", items };
}

async function importHeybox() {
  const sprite = await fetchBytes(sources.heybox);
  const metadata = await sharp(sprite).metadata();
  if (metadata.width !== 360 || metadata.height !== 660) throw new Error("Unexpected Heybox sprite dimensions.");
  const items = [];
  for (const [id, label] of heyboxItems) {
    const row = Number(id.slice(0, -1)) - 1;
    const column = Number(id.slice(-1)) - 1;
    const src = `/emotes/heybox/${id}.png`;
    const output = await sharp(sprite).extract({ left: column * 60, top: row * 60, width: 60, height: 60 }).png().toBuffer();
    await writeAsset(src, output);
    items.push({ kind: "image", id, label, token: `[heybox:${id}]`, src, aliases: [`[cube_${label}]`, label] });
  }
  return { id: "heybox", label: "小黑盒", items };
}

async function importTieba() {
  const ids = [...range(1, 50), ...range(62, 124)];
  const items = [];
  for (const id of ids) {
    const fileName = id === 1 ? "image_emoticon.png" : `image_emoticon${id}.png`;
    const remote = `https://raw.githubusercontent.com/microlong666/Tieba_mobile_emotions/master/${fileName}`;
    const src = `/emotes/tieba/${id}.png`;
    await writeRemoteImage(remote, src);
    const label = tiebaLabels[id - 1] ?? `贴吧表情 ${id}`;
    items.push({ kind: "image", id: String(id), label, token: `[tieba:${id}]`, src, aliases: [label] });
  }
  return { id: "tieba", label: "贴吧", items };
}

async function importFeishu(currentPack) {
  const markdown = await fetchText(sources.feishu);
  const matches = [...markdown.matchAll(/!\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([A-Za-z0-9_]+)/g)];
  if (matches.length < 180) throw new Error(`Feishu catalog unexpectedly contains ${matches.length} items.`);
  const currentById = new Map((currentPack?.items ?? []).map((item) => [item.id, item]));
  const items = [];
  for (const match of matches) {
    const emojiType = match[3];
    const id = toKebabId(emojiType);
    const existing = currentById.get(id);
    const src = `/emotes/feishu/${id}.png`;
    const stored = await readAsset(src);
    if (stored) {
      if (await hasOpaqueWhiteCorners(stored)) {
        const normalized = await removeConnectedWhiteBackground(stored);
        if (normalized.changed) await writeAsset(src, normalized.buffer);
      }
    } else {
      const downloaded = await fetchBytes(normalizeUrl(match[2]));
      const normalized = await removeConnectedWhiteBackground(downloaded);
      await writeAsset(src, normalized.buffer);
    }
    items.push({
      kind: "image",
      id,
      label: emojiType,
      token: `[feishu:${id}]`,
      src,
      aliases: unique([...(existing?.aliases ?? []), emojiType, match[1]]),
    });
  }
  return { id: "feishu", label: "飞书", items };
}

async function removeConnectedWhiteBackground(input) {
  const image = sharp(input).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  const enqueue = (index) => {
    if (visited[index] || !isEdgeWhite(data, index)) return;
    visited[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < info.width; x += 1) {
    enqueue(x);
    enqueue((info.height - 1) * info.width + x);
  }
  for (let y = 0; y < info.height; y += 1) {
    enqueue(y * info.width);
    enqueue(y * info.width + info.width - 1);
  }
  while (head < tail) {
    const index = queue[head++];
    const x = index % info.width;
    const y = Math.floor(index / info.width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < info.width) enqueue(index + 1);
    if (y > 0) enqueue(index - info.width);
    if (y + 1 < info.height) enqueue(index + info.width);
  }
  if (tail === 0) return { buffer: input, changed: false };
  for (let index = 0; index < pixelCount; index += 1) {
    if (visited[index]) data[index * 4 + 3] = 0;
  }
  return { buffer: await sharp(data, { raw: info }).png().toBuffer(), changed: true };
}

function isEdgeWhite(data, pixelIndex) {
  const offset = pixelIndex * 4;
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  return data[offset + 3] > 0 && r >= 238 && g >= 238 && b >= 238 && Math.max(r, g, b) - Math.min(r, g, b) <= 12;
}

async function writeRemoteImage(url, publicPath) {
  await writeAsset(publicPath, await fetchBytes(url));
}

async function writeAsset(publicPath, bytes) {
  const destination = path.join(webRoot, "public", publicPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

async function readAsset(publicPath) {
  try {
    return await readFile(path.join(webRoot, "public", publicPath));
  } catch {
    return null;
  }
}

async function hasOpaqueWhiteCorners(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]].every(([x, y]) => {
    const offset = (y * info.width + x) * 4;
    return data[offset] > 245 && data[offset + 1] > 245 && data[offset + 2] > 245 && data[offset + 3] === 255;
  });
}

async function fetchJson(url, extraHeaders = {}) {
  return JSON.parse(await fetchText(url, extraHeaders));
}

async function fetchText(url, extraHeaders = {}) {
  return (await fetchResponse(url, extraHeaders)).text();
}

async function fetchBytes(url, extraHeaders = {}) {
  return Buffer.from(await (await fetchResponse(url, extraHeaders)).arrayBuffer());
}

async function fetchResponse(url, extraHeaders = {}) {
  const response = await fetch(url, { headers: { "user-agent": userAgent, ...extraHeaders } });
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  return response;
}

function sourceForExistingPack(id) {
  return {
    emoji: "unicode",
    wechat: "https://github.com/xxk8/wechat-emojis",
    douyin: "local-replaceable-pack; public Douyin web entry did not expose a stable asset manifest",
    qq: "https://qzonestyle.gtimg.cn/qzone/em/e{code}.gif",
  }[id] ?? "local";
}

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function stripBrackets(value) {
  return String(value ?? "").replace(/^\[|\]$/g, "").trim();
}

function normalizeLabel(value) {
  return stripBrackets(value).toLocaleLowerCase();
}

function normalizeUrl(url) {
  return url.startsWith("//") ? `https:${url}` : url;
}

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function toKebabId(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
