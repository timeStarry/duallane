import { describe, expect, it } from "vitest";
import { getCachedEmoteImageSrc } from "./emote-image-cache";

describe("emote image cache URLs", () => {
  it("versions built-in emote assets so browser caches expire after an app update", () => {
    expect(getCachedEmoteImageSrc("/emotes/bili/doge.png", "0.14.2")).toBe("/emotes/bili/doge.png?v=0.14.2");
    expect(getCachedEmoteImageSrc("/emotes/bili/doge.png?size=small", "0.14.2"))
      .toBe("/emotes/bili/doge.png?size=small&v=0.14.2");
  });

  it("keeps private custom emote URLs unchanged", () => {
    expect(getCachedEmoteImageSrc("/api/workspace/emotes/emote-1/content", "0.14.2"))
      .toBe("/api/workspace/emotes/emote-1/content");
  });
});
