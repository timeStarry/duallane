import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emotePacks, getEmoteInsertText, renderMessageParts, visibleEmotePacks, type EmoteItem } from "./emotes";

function findItem(packId: string, itemId: string): EmoteItem {
  const item = emotePacks.find((pack) => pack.id === packId)?.items.find((entry) => entry.id === itemId);
  if (!item) {
    throw new Error(`Missing emote ${packId}:${itemId}`);
  }
  return item;
}

describe("emote rendering", () => {
  it("inserts unicode emoji as plain characters", () => {
    expect(getEmoteInsertText(findItem("emoji", "smile"))).toBe("😄");
  });

  it("inserts platform emotes as stable text tokens", () => {
    expect(getEmoteInsertText(findItem("bili", "like"))).toBe("[bili:like]");
    expect(getEmoteInsertText(findItem("douyin", "laughwithtears"))).toBe("[douyin:laughwithtears]");
    expect(getEmoteInsertText(findItem("wechat", "微笑"))).toBe("[wechat:微笑]");
    expect(getEmoteInsertText(findItem("qq", "smile"))).toBe("[qq:smile]");
    expect(getEmoteInsertText(findItem("feishu", "ok"))).toBe("[feishu:ok]");
    expect(getEmoteInsertText(findItem("xiaohongshu", "01"))).toBe("[xiaohongshu:01]");
    expect(getEmoteInsertText(findItem("heybox", "11"))).toBe("[heybox:11]");
    expect(getEmoteInsertText(findItem("tieba", "1"))).toBe("[tieba:1]");
  });

  it("renders whitelisted platform tokens and leaves unknown tokens as text", () => {
    const rendered = renderMessageParts("收到 [bili:like] [wechat:微笑] [qq:微笑] [douyin:laughwithtears] [feishu:OK] [xiaohongshu:01] [heybox:11] [tieba:1]");

    expect(Array.isArray(rendered)).toBe(true);
    const parts = rendered as Array<{ props?: { token?: string } } | string>;
    expect(parts[0]).toBe("收到 ");
    expect(parts[1]).toHaveProperty("props.token", "[bili:like]");
    expect(parts[2]).toBe(" ");
    expect(parts[3]).toHaveProperty("props.token", "[wechat:微笑]");
    expect(parts[4]).toBe(" ");
    expect(parts[5]).toHaveProperty("props.token", "[qq:微笑]");
    expect(parts[6]).toBe(" ");
    expect(parts[7]).toHaveProperty("props.token", "[douyin:laughwithtears]");
    expect(parts[8]).toBe(" ");
    expect(parts[9]).toHaveProperty("props.token", "[feishu:OK]");
    expect(parts[11]).toHaveProperty("props.token", "[xiaohongshu:01]");
    expect(parts[13]).toHaveProperty("props.token", "[heybox:11]");
    expect(parts[15]).toHaveProperty("props.token", "[tieba:1]");
    expect(renderMessageParts("未知 [bili:nope]")).toBe("未知 [bili:nope]");
  });

  it("keeps expanded pack sizes usable for chat", () => {
    expect(emotePacks.find((pack) => pack.id === "emoji")?.items.length).toBeGreaterThanOrEqual(40);
    expect(emotePacks.find((pack) => pack.id === "bili")?.items.length).toBeGreaterThanOrEqual(220);
    expect(emotePacks.find((pack) => pack.id === "wechat")?.items.length).toBeGreaterThanOrEqual(100);
    expect(emotePacks.find((pack) => pack.id === "qq")?.items.length).toBeGreaterThanOrEqual(40);
    expect(emotePacks.find((pack) => pack.id === "feishu")?.items.length).toBe(182);
    expect(emotePacks.find((pack) => pack.id === "xiaohongshu")?.items.length).toBe(40);
    expect(emotePacks.find((pack) => pack.id === "heybox")?.items.length).toBe(63);
    expect(emotePacks.find((pack) => pack.id === "tieba")?.items.length).toBe(113);
  });

  it("keeps every catalog image local and every platform token unique", () => {
    const tokens = new Set<string>();
    for (const pack of emotePacks) {
      for (const item of pack.items) {
        if (item.kind !== "image") continue;
        expect(tokens.has(item.token), `duplicate token ${item.token}`).toBe(false);
        tokens.add(item.token);
        expect(existsSync(fileURLToPath(new URL(`../public${item.src}`, import.meta.url))), item.src).toBe(true);
      }
    }
  });

  it("hides replaced or placeholder-only packs from the picker while preserving message compatibility", () => {
    expect(visibleEmotePacks.map((pack) => pack.id)).not.toContain("douyin");
    expect(visibleEmotePacks.map((pack) => pack.id)).not.toContain("qq");
    expect(visibleEmotePacks.map((pack) => pack.id)).toContain("wechat");
    expect(visibleEmotePacks.map((pack) => pack.id)).toEqual(expect.arrayContaining(["xiaohongshu", "heybox", "tieba"]));
    expect(renderMessageParts("历史消息 [douyin:laughwithtears]")).not.toBe("历史消息 [douyin:laughwithtears]");
    expect(renderMessageParts("历史消息 [qq:微笑]")).not.toBe("历史消息 [qq:微笑]");
  });
});
