import { describe, expect, it } from "vitest";
import { emotePacks, getEmoteInsertText, renderMessageParts, type EmoteItem } from "./emotes";

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
    expect(getEmoteInsertText(findItem("douyin", "cover"))).toBe("[douyin:cover]");
    expect(getEmoteInsertText(findItem("qq", "smile"))).toBe("[qq:smile]");
  });

  it("renders whitelisted platform tokens and leaves unknown tokens as text", () => {
    const rendered = renderMessageParts("收到 [bili:like] [qq:微笑]");

    expect(Array.isArray(rendered)).toBe(true);
    const parts = rendered as Array<{ props?: { token?: string } } | string>;
    expect(parts[0]).toBe("收到 ");
    expect(parts[1]).toHaveProperty("props.token", "[bili:like]");
    expect(parts[2]).toBe(" ");
    expect(parts[3]).toHaveProperty("props.token", "[qq:微笑]");
    expect(renderMessageParts("未知 [bili:nope]")).toBe("未知 [bili:nope]");
  });
});
