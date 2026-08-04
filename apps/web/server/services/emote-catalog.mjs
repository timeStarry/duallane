import { readFileSync } from "node:fs";

const catalog = JSON.parse(
  readFileSync(new URL("../../shared/emote-packs.json", import.meta.url), "utf8")
);
const hiddenPackIds = new Set(["douyin", "qq"]);
const emoteByKey = new Map();

for (const pack of catalog) {
  for (const item of pack.items ?? []) {
    emoteByKey.set(`${pack.id}:${item.id}`, {
      ...item,
      packId: pack.id,
      packLabel: pack.label,
      visible: !hiddenPackIds.has(pack.id)
    });
  }
}

export function getReactionEmote(emoteKey) {
  return emoteByKey.get(String(emoteKey ?? "").trim()) ?? null;
}

export function isVisibleReactionEmoteKey(emoteKey) {
  return getReactionEmote(emoteKey)?.visible === true;
}

export function publicReactionEmote(emoteKey) {
  const emote = getReactionEmote(emoteKey);
  if (!emote) {
    return null;
  }
  return {
    emoteKey: `${emote.packId}:${emote.id}`,
    kind: emote.kind,
    label: emote.label,
    value: emote.kind === "unicode" ? emote.value : undefined,
    src: emote.kind === "image" ? emote.src : undefined
  };
}

export function listVisibleReactionKeys() {
  return [...emoteByKey.entries()]
    .filter(([, emote]) => emote.visible)
    .map(([key]) => key);
}