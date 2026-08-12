import { describe, expect, it } from "vitest";
import { RECENT_EMOJIS_STORAGE_KEY, getRecentEmojiIds, recordRecentEmojiUse } from "./recent-emojis";

function createStorage(initialValue = "") {
  const values = new Map<string, string>();
  if (initialValue) values.set(RECENT_EMOJIS_STORAGE_KEY, initialValue);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}

describe("recent emoji preference", () => {
  it("ranks frequent emoji first and uses recency to break ties", () => {
    const storage = createStorage();
    recordRecentEmojiUse("smile", ["smile", "wave"], storage, 10);
    recordRecentEmojiUse("wave", ["smile", "wave"], storage, 20);
    expect(getRecentEmojiIds(["smile", "wave"], 8, storage)).toEqual(["wave", "smile"]);
    recordRecentEmojiUse("smile", ["smile", "wave"], storage, 30);
    expect(getRecentEmojiIds(["smile", "wave"], 8, storage)).toEqual(["smile", "wave"]);
  });

  it("filters removed emoji and caps the visible result", () => {
    const storage = createStorage(JSON.stringify([
      { id: "one", count: 3, lastUsedAt: 3 },
      { id: "removed", count: 9, lastUsedAt: 9 },
      { id: "two", count: 2, lastUsedAt: 2 }
    ]));
    expect(getRecentEmojiIds(["one", "two"], 1, storage)).toEqual(["one"]);
  });

  it("ignores malformed or unavailable storage", () => {
    expect(getRecentEmojiIds(["smile"], 8, createStorage("not-json"))).toEqual([]);
    expect(recordRecentEmojiUse("missing", ["smile"], null)).toEqual([]);
  });
});
