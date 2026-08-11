import { describe, expect, it } from "vitest";
import { normalizeWorkspaceGroupAvatarEmoji } from "./workspace-group-avatar";

describe("workspace group avatar emoji", () => {
  it("accepts one complete emoji grapheme", () => {
    expect(normalizeWorkspaceGroupAvatarEmoji(" 👩🏽‍💻 ")).toBe("👩🏽‍💻");
    expect(normalizeWorkspaceGroupAvatarEmoji("🇨🇳")).toBe("🇨🇳");
    expect(normalizeWorkspaceGroupAvatarEmoji("1️⃣")).toBe("1️⃣");
  });

  it("allows an empty default and rejects text or multiple emoji", () => {
    expect(normalizeWorkspaceGroupAvatarEmoji("")).toBe("");
    expect(normalizeWorkspaceGroupAvatarEmoji("A")).toBeNull();
    expect(normalizeWorkspaceGroupAvatarEmoji("😀🚀")).toBeNull();
  });
});
