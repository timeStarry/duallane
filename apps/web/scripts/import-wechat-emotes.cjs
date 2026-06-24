const fs = require("node:fs/promises");
const path = require("node:path");

const repo = "xxk8/wechat-emojis";
const sourceUrl = `https://github.com/${repo}`;
const rawBase = `https://raw.githubusercontent.com/${repo}/main`;
const webRoot = path.resolve(__dirname, "..");
const emotePacksPath = path.join(webRoot, "src", "emotePacks.ts");
const manifestPath = path.join(webRoot, "public", "emotes", "manifest.json");
const outputDir = path.join(webRoot, "public", "emotes", "wechat");

function parseWechatEmojiSource(source) {
  const pattern =
    /'([^']+)':\s*\{\s*name:\s*'([^']+)',\s*category:\s*EmojiCategory\.([A-Z]+),\s*path:\s*'([^']+)'/g;
  const items = [];
  const seen = new Set();

  for (const match of source.matchAll(pattern)) {
    const [, key, name, category, assetPath] = match;
    if (key !== name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const filename = `${toCodePointSlug(name)}.png`;
    items.push({
      kind: "image",
      id: name,
      label: name,
      token: `[wechat:${name}]`,
      src: `/emotes/wechat/${filename}`,
      aliases: [name],
      downloadUrl: `${rawBase}/${encodeURI(assetPath)}`,
    });
  }

  if (items.length === 0) {
    throw new Error("No WeChat emotes were parsed.");
  }

  return items;
}

function toCodePointSlug(value) {
  return Array.from(value)
    .map((char) => `u${char.codePointAt(0).toString(16)}`)
    .join("-");
}

async function downloadItems(items) {
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

    await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
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

function insertPack(packs, pack) {
  const next = packs.filter((entry) => entry.id !== pack.id);
  const qqIndex = next.findIndex((entry) => entry.id === "qq");
  if (qqIndex === -1) {
    next.push(pack);
  } else {
    next.splice(qqIndex, 0, pack);
  }
  return next;
}

async function writePacks(packs, items) {
  const publicItems = items.map(({ downloadUrl, ...item }) => item);
  const nextPacks = insertPack(packs, {
    id: "wechat",
    label: "微信",
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
      source: pack.id === "wechat" ? sourceUrl : sourceByPack.get(pack.id) ?? "local",
    })),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
}

async function main() {
  const sourceResponse = await fetch(`${rawBase}/wechatEmoji.ts`, {
    headers: {
      "user-agent": "duallane-emote-import/1.0",
    },
  });
  if (!sourceResponse.ok) {
    throw new Error(`Failed to download metadata: ${sourceResponse.status} ${sourceResponse.statusText}`);
  }

  const items = parseWechatEmojiSource(await sourceResponse.text());
  await downloadItems(items);
  await writePacks(await readCurrentPacks(), items);
  console.log(`Imported ${items.length} WeChat emotes.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
