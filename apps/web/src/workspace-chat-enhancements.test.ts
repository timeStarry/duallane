import { describe, expect, it } from "vitest";
import {
  clampWorkspaceImageZoom,
  shouldDirectSendWorkspaceEmote,
  workspaceReplyPreview
} from "./App";

describe("workspace chat enhancements", () => {
  it("keeps a jump target when the replied message is outside the current page", () => {
    expect(workspaceReplyPreview(undefined, "message-history")).toEqual({
      messageId: "message-history",
      author: "",
      body: "查看引用消息"
    });
  });

  it("direct-sends only custom image emotes when the preference is enabled", () => {
    const image = { kind: "image" as const, id: "wave", label: "挥手", token: "[bili:wave]", src: "/wave.webp" };
    const unicode = { kind: "unicode" as const, id: "smile", label: "微笑", value: "🙂" };
    expect(shouldDirectSendWorkspaceEmote({ ...image, customId: "custom-wave" }, "custom", true)).toBe(true);
    expect(shouldDirectSendWorkspaceEmote(image, "bili", true)).toBe(false);
    expect(shouldDirectSendWorkspaceEmote(image, "custom", false)).toBe(false);
    expect(shouldDirectSendWorkspaceEmote(unicode, "custom", true)).toBe(false);
  });

  it("clamps image viewer zoom to quarter steps between 100% and 400%", () => {
    expect(clampWorkspaceImageZoom(0.1)).toBe(1);
    expect(clampWorkspaceImageZoom(1.14)).toBe(1.25);
    expect(clampWorkspaceImageZoom(8)).toBe(4);
  });
});
