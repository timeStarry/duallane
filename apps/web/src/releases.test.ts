import { describe, expect, it } from "vitest";
import rootPackage from "../../../package.json";
import webPackage from "../package.json";
import { DUAL_LANE_RELEASES } from "./releases";
import echoReleaseGuides from "../shared/echo-release-guides.json";

const INTERNAL_CHANGELOG_TERMS = [
  "PostgreSQL",
  "RBAC",
  "SMTP",
  "API",
  "WebSocket",
  "幂等",
  "数据库",
  "审计",
  "迁移",
  "服务端",
  "容器",
  "部署",
  "协议",
  "特权",
  "配置",
  "OAuth",
  "Fastify",
  "Nginx",
  "Docker",
  "Token 哈希",
  "token hash"
];

describe("release history", () => {
  it("is unique, complete, and sorted newest first", () => {
    expect(new Set(DUAL_LANE_RELEASES.map((release) => release.version)).size).toBe(DUAL_LANE_RELEASES.length);
    expect(DUAL_LANE_RELEASES.map((release) => release.version)).toEqual(["0.15.4", "0.15.3", "0.15.2", "0.15.1", "0.15.0", "0.14.3", "0.14.2", "0.14.1", "0.14.0", "0.13.2", "0.13.1", "0.13.0", "0.12.0", "0.11.0", "0.10.0", "0.9.0", "0.8.0", "0.7.0", "0.6.0", "0.5.0", "0.4.0", "0.3.0", "0.2.0", "0.1.0"]);
    for (const release of DUAL_LANE_RELEASES) {
      expect(release.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(release.title.trim()).not.toBe("");
      expect(release.summary.trim()).not.toBe("");
      expect(release.categories.length).toBeGreaterThan(0);
      expect(release.categories.every((category) => category.title && category.items.length > 0)).toBe(true);
    }
  });

  it("matches both published package versions", () => {
    expect(rootPackage.version).toBe("0.15.4");
    expect(webPackage.version).toBe("0.15.4");
    expect(DUAL_LANE_RELEASES[0].version).toBe(rootPackage.version);
    expect(DUAL_LANE_RELEASES[0].version).toBe(webPackage.version);
  });

  it("describes the 0.15.4 user-facing scope and release date", () => {
    const latest = DUAL_LANE_RELEASES[0];
    const publicCopy = JSON.stringify(latest);
    expect(latest.version).toBe("0.15.4");
    expect(latest.releasedAt).toBe("2026-08-29");
    expect(publicCopy).toContain("Agent");
    expect(publicCopy).toContain("权限");
    expect(publicCopy).toContain("连接");
    expect(publicCopy).not.toMatch(/迁移|审计|Token 哈希|token hash/);
  });

  it("contains only changes ordinary users can understand and observe", () => {
    const publicCopy = JSON.stringify(DUAL_LANE_RELEASES);
    for (const internalTerm of INTERNAL_CHANGELOG_TERMS) {
      expect(publicCopy).not.toContain(internalTerm);
    }
  });

  it("keeps every Echo usage guide aligned with the public release facts", () => {
    const releases = new Map(DUAL_LANE_RELEASES.map((release) => [release.version, release]));
    for (const guide of echoReleaseGuides) {
      const release = releases.get(guide.version);
      expect(release).toMatchObject({
        version: guide.version,
        releasedAt: guide.releasedAt,
        title: guide.title,
        summary: guide.summary
      });
      expect(guide.sections.every((section) => section.items.every((item) => item.location.trim()))).toBe(true);
    }
  });
});
