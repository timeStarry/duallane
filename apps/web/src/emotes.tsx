import { useState, type ReactNode } from "react";

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
};

export type EmoteItem = UnicodeEmoteItem | ImageEmoteItem;

export type EmotePack = {
  id: "emoji" | "bili" | "douyin" | "qq";
  label: string;
  items: EmoteItem[];
};

export const emotePacks: EmotePack[] = [
  {
    id: "emoji",
    label: "Emoji",
    items: [
      { kind: "unicode", id: "smile", label: "微笑", value: "😄" },
      { kind: "unicode", id: "laugh", label: "大笑", value: "😂" },
      { kind: "unicode", id: "thumbs-up", label: "赞", value: "👍" },
      { kind: "unicode", id: "ok", label: "OK", value: "👌" },
      { kind: "unicode", id: "clap", label: "鼓掌", value: "👏" },
      { kind: "unicode", id: "thinking", label: "思考", value: "🤔" },
      { kind: "unicode", id: "eyes", label: "关注", value: "👀" },
      { kind: "unicode", id: "fire", label: "火热", value: "🔥" },
      { kind: "unicode", id: "party", label: "庆祝", value: "🎉" },
      { kind: "unicode", id: "lock", label: "安全", value: "🔒" },
      { kind: "unicode", id: "heart", label: "喜欢", value: "❤️" },
      { kind: "unicode", id: "folded-hands", label: "收到", value: "🙏" }
    ]
  },
  {
    id: "bili",
    label: "B站",
    items: [
      {
        kind: "image",
        id: "like",
        label: "点赞",
        token: "[bili:like]",
        src: "/emotes/bili/like.svg",
        aliases: ["赞"]
      },
      {
        kind: "image",
        id: "wow",
        label: "妙啊",
        token: "[bili:wow]",
        src: "/emotes/bili/wow.svg",
        aliases: ["妙啊"]
      }
    ]
  },
  {
    id: "douyin",
    label: "抖音",
    items: [
      {
        kind: "image",
        id: "laugh",
        label: "笑哭",
        token: "[douyin:laugh]",
        src: "/emotes/douyin/laugh.svg",
        aliases: ["笑哭"]
      },
      {
        kind: "image",
        id: "cover",
        label: "捂脸",
        token: "[douyin:cover]",
        src: "/emotes/douyin/cover.svg",
        aliases: ["捂脸"]
      }
    ]
  },
  {
    id: "qq",
    label: "QQ",
    items: [
      {
        kind: "image",
        id: "smile",
        label: "微笑",
        token: "[qq:smile]",
        src: "/emotes/qq/smile.svg",
        aliases: ["微笑"]
      },
      {
        kind: "image",
        id: "cry",
        label: "流泪",
        token: "[qq:cry]",
        src: "/emotes/qq/cry.svg",
        aliases: ["流泪"]
      }
    ]
  }
];

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

const imageEmoteTokenPattern = /\[(bili|douyin|qq):([^\]\s:]+)\]/g;

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
