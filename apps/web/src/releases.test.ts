import { describe, expect, it } from "vitest";
import rootPackage from "../../../package.json";
import webPackage from "../package.json";
import { DUAL_LANE_RELEASES } from "./releases";

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
  "Docker"
];

describe("release history", () => {
  it("is unique, complete, and sorted newest first", () => {
    expect(new Set(DUAL_LANE_RELEASES.map((release) => release.version)).size).toBe(DUAL_LANE_RELEASES.length);
    expect(DUAL_LANE_RELEASES.map((release) => release.version)).toEqual(["0.9.0", "0.8.0", "0.7.0", "0.6.0", "0.5.0", "0.4.0", "0.3.0", "0.2.0", "0.1.0"]);
    for (const release of DUAL_LANE_RELEASES) {
      expect(release.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(release.title.trim()).not.toBe("");
      expect(release.summary.trim()).not.toBe("");
      expect(release.categories.length).toBeGreaterThan(0);
      expect(release.categories.every((category) => category.title && category.items.length > 0)).toBe(true);
    }
  });

  it("matches both published package versions", () => {
    expect(DUAL_LANE_RELEASES[0].version).toBe(rootPackage.version);
    expect(DUAL_LANE_RELEASES[0].version).toBe(webPackage.version);
  });

  it("contains only changes ordinary users can understand and observe", () => {
    const publicCopy = JSON.stringify(DUAL_LANE_RELEASES);
    for (const internalTerm of INTERNAL_CHANGELOG_TERMS) {
      expect(publicCopy).not.toContain(internalTerm);
    }
  });
});
