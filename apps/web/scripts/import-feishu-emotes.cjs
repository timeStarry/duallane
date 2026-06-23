const fs = require("node:fs/promises");
const path = require("node:path");

const webRoot = path.resolve(__dirname, "..");
const emotePacksPath = path.join(webRoot, "src", "emotePacks.ts");
const manifestPath = path.join(webRoot, "public", "emotes", "manifest.json");
const outputDir = path.join(webRoot, "public", "emotes", "feishu");
const sourceUrl = "https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce";

function parseMarkdownEmotes(markdown) {
  const matches = markdown.matchAll(/!\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([A-Za-z0-9_]+)/g);
  const seen = new Set();
  const items = [];

  for (const match of matches) {
    const alt = match[1].replace(/\.(png|gif|webp|jpg|jpeg)$/i, "");
    const url = normalizeUrl(match[2]);
    const emojiType = match[3];
    const id = toKebabId(emojiType);

    if (seen.has(id)) {
      throw new Error(`Duplicate Feishu emote id: ${id}`);
    }
    seen.add(id);

    const aliases = Array.from(new Set([emojiType, alt].filter((alias) => alias && alias !== id)));
    items.push({
      kind: "image",
      id,
      label: emojiType,
      token: `[feishu:${id}]`,
      src: `/emotes/feishu/${id}.png`,
      aliases,
    });
  }

  if (items.length === 0) {
    throw new Error("No Feishu emotes were found in the source markdown.");
  }

  return items.map((item) => ({
    ...item,
    sourceUrl: item.src,
    downloadUrl: sourceUrlBySrc(markdown, item.src),
  }));
}

function sourceUrlBySrc(markdown, src) {
  const id = src.split("/").pop().replace(/\.png$/, "");
  for (const match of markdown.matchAll(/!\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([A-Za-z0-9_]+)/g)) {
    if (toKebabId(match[3]) === id) {
      return normalizeUrl(match[2]);
    }
  }
  throw new Error(`Missing source URL for ${id}`);
}

function normalizeUrl(url) {
  return url.startsWith("//") ? `https:${url}` : url;
}

function toKebabId(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

async function downloadEmotes(items) {
  await fs.mkdir(outputDir, { recursive: true });

  for (const item of items) {
    const filePath = path.join(webRoot, "public", item.src);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 0) {
        continue;
      }
    } catch {
      // Download below.
    }

    const response = await fetch(item.downloadUrl, {
      headers: {
        "user-agent": "duallane-emote-import/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to download ${item.label}: ${response.status} ${response.statusText}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(filePath, bytes);
  }
}

async function readCurrentPacks() {
  const source = await fs.readFile(emotePacksPath, "utf8");
  const match = source.match(/export const emotePacks = ([\s\S]+?) satisfies EmotePack\[];/);
  if (!match) {
    throw new Error("Could not parse emotePacks.ts.");
  }
  return JSON.parse(match[1]);
}

async function writePacks(packs, feishuItems) {
  const publicItems = feishuItems.map(({ downloadUrl, sourceUrl: _sourceUrl, ...item }) => item);
  const nextPacks = packs.filter((pack) => pack.id !== "feishu");
  nextPacks.push({
    id: "feishu",
    label: "飞书",
    items: publicItems,
  });

  const source = `import type { EmotePack } from "./emotes";\n\nexport const emotePacks = ${JSON.stringify(
    nextPacks,
    null,
    2,
  )} satisfies EmotePack[];\n`;
  await fs.writeFile(emotePacksPath, source);

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const sourceByPack = new Map((manifest.packs ?? []).map((pack) => [pack.id, pack.source]));
  const nextManifest = {
    packs: nextPacks.map((pack) => ({
      ...pack,
      source: pack.id === "feishu" ? sourceUrl : sourceByPack.get(pack.id) ?? "local",
    })),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
}

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    throw new Error("Usage: node import-feishu-emotes.cjs <feishu-emojis-markdown>");
  }

  const markdown = await fs.readFile(sourcePath, "utf8");
  const items = parseMarkdownEmotes(markdown);
  await downloadEmotes(items);
  const packs = await readCurrentPacks();
  await writePacks(packs, items);
  console.log(`Imported ${items.length} Feishu emotes.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
