import { describe, expect, it } from "vitest";
import { userFacingErrorMessage } from "./user-facing-error";

describe("user-facing errors", () => {
  it("replaces browser network errors with actionable Chinese copy", () => {
    expect(userFacingErrorMessage(new TypeError("Failed to fetch"), "加载失败")).toBe("网络连接失败，请检查连接后重试。");
    expect(userFacingErrorMessage(new Error("NetworkError when attempting to fetch resource."), "加载失败")).toBe(
      "网络连接失败，请检查连接后重试。"
    );
  });

  it("uses timeout copy for aborted requests", () => {
    expect(userFacingErrorMessage({ name: "AbortError" }, "加载失败")).toBe("请求超时，请稍后重试。");
  });

  it("preserves service messages and falls back for unknown values", () => {
    expect(userFacingErrorMessage(new Error("邀请已失效"), "加载失败")).toBe("邀请已失效");
    expect(userFacingErrorMessage(null, "加载失败")).toBe("加载失败");
  });
});
