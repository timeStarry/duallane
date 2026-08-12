import { describe, expect, it } from "vitest";
import { compareSemanticVersions, isServerVersionNewer } from "./app-version";

describe("app version freshness", () => {
  it("prompts only when the server version is newer", () => {
    expect(isServerVersionNewer("0.11.0", "0.12.0")).toBe(true);
    expect(isServerVersionNewer("0.11.0", "0.11.0")).toBe(false);
    expect(isServerVersionNewer("0.12.0", "0.11.9")).toBe(false);
    expect(isServerVersionNewer("invalid", "0.12.0")).toBe(false);
  });

  it("compares major, minor and patch numerically", () => {
    expect(compareSemanticVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareSemanticVersions("v2.0.0", "2.0.1")).toBe(-1);
  });
});
