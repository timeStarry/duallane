import { useState, type ReactNode } from "react";
import { emotePacks } from "./emotePacks";

export type UnicodeEmoteItem = {
  kind: "unicode";
  id: string;
  label: string;
  value: string;
};

export type ImageEmoteItem = {
  kind: "image";
  id: string;
  label: string;
  token: string;
  src: string;
  aliases?: string[];
  customId?: string;
  animated?: boolean;
};

export type EmoteItem = UnicodeEmoteItem | ImageEmoteItem;

export type EmotePack = {
  id: "emoji" | "bili" | "douyin" | "wechat" | "qq" | "feishu" | "xiaohongshu" | "heybox" | "tieba" | "custom";
  label: string;
  items: EmoteItem[];
  defaultEnabled?: boolean;
};

export { emotePacks };

export const visibleEmotePacks = emotePacks.filter((pack) => pack.id !== "douyin" && pack.id !== "qq");


export type ReactionEmote = {
  emoteKey: string;
  pack: EmotePack;
  item: EmoteItem;
};

const reactionEmoteByKey = new Map<string, ReactionEmote>();
for (const pack of emotePacks) {
  for (const item of pack.items) {
    const emoteKey = `${pack.id}:${item.id}`;
    reactionEmoteByKey.set(emoteKey, { emoteKey, pack, item });
  }
}

export function getReactionEmote(emoteKey: string) {
  return reactionEmoteByKey.get(emoteKey);
}

export function getReactionEmoteKey(packId: EmotePack["id"], item: EmoteItem) {
  return `${packId}:${item.id}`;
}

export function findFirstImageEmoteKey(body: string) {
  for (const match of body.matchAll(imageEmoteTokenPattern)) {
    const item = imageEmoteByToken.get(match[0]);
    if (!item) continue;
    for (const pack of emotePacks) {
      if (pack.items.includes(item)) return `${pack.id}:${item.id}`;
    }
  }
  return null;
}

export function ReactionEmoteGlyph({ emoteKey }: { emoteKey: string }) {
  const emote = getReactionEmote(emoteKey);
  if (!emote) {
    return <span className="reaction-emote-fallback" aria-hidden="true">?</span>;
  }
  if (emote.item.kind === "unicode") {
    return <span className="unicode-emote" aria-hidden="true">{emote.item.value}</span>;
  }
  return <MessageEmoteImage emote={emote.item} token={emote.item.token} />;
}
const imageEmoteByToken = new Map<string, ImageEmoteItem>();

for (const pack of emotePacks) {
  if (pack.id === "emoji") {
    continue;
  }

  for (const item of pack.items) {
    if (item.kind !== "image") {
      continue;
    }

    imageEmoteByToken.set(item.token, item);
    imageEmoteByToken.set(`[${pack.id}:${item.id}]`, item);
    for (const alias of item.aliases ?? []) {
      imageEmoteByToken.set(`[${pack.id}:${alias}]`, item);
    }
  }
}

const imagePackIds = emotePacks.filter((pack) => pack.id !== "emoji" && pack.id !== "custom").map((pack) => pack.id);
const imageEmoteTokenPattern = new RegExp(`\\[(${imagePackIds.map(escapeRegExp).join("|")}):([^\\]\\s:]+)\\]`, "g");

export function getEmoteInsertText(item: EmoteItem) {
  return item.kind === "unicode" ? item.value : item.token;
}

export function MessageBody({ body }: { body: string }) {
  return <p className="message-body">{renderMessageParts(body)}</p>;
}

export function renderMessageParts(body: string): ReactNode {
  const parts: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of body.matchAll(imageEmoteTokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    const emote = imageEmoteByToken.get(token);
    if (!emote) {
      continue;
    }

    if (index > lastIndex) {
      parts.push(body.slice(lastIndex, index));
    }
    parts.push(<MessageEmoteImage emote={emote} key={`${token}-${index}`} token={token} />);
    lastIndex = index + token.length;
  }

  if (parts.length === 0) {
    return body;
  }

  if (lastIndex < body.length) {
    parts.push(body.slice(lastIndex));
  }

  return parts;
}

function MessageEmoteImage({ emote, token }: { emote: ImageEmoteItem; token: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <span className="message-emote-fallback">{token}</span>;
  }

  return (
    <img
      alt={emote.label}
      className="message-emote-image"
      decoding="async"
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      src={emote.src}
      title={emote.label}
    />
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
