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
    expect(DUAL_LANE_RELEASES.map((release) => release.version)).toEqual(["0.18.0", "0.17.0", "0.16.2", "0.16.1", "0.16.0", "0.15.5", "0.15.4", "0.15.3", "0.15.2", "0.15.1", "0.15.0", "0.14.3", "0.14.2", "0.14.1", "0.14.0", "0.13.2", "0.13.1", "0.13.0", "0.12.0", "0.11.0", "0.10.0", "0.9.0", "0.8.0", "0.7.0", "0.6.0", "0.5.0", "0.4.0", "0.3.0", "0.2.0", "0.1.0"]);
    for (const release of DUAL_LANE_RELEASES) {
      expect(release.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(release.title.trim()).not.toBe("");
      expect(release.summary.trim()).not.toBe("");
      expect(release.categories.length).toBeGreaterThan(0);
      expect(release.categories.every((category) => category.title && category.items.length > 0)).toBe(true);
    }
  });

  it("matches both published package versions", () => {
    expect(rootPackage.version).toBe("0.18.0");
    expect(webPackage.version).toBe("0.18.0");
    expect(DUAL_LANE_RELEASES[0].version).toBe(rootPackage.version);
    expect(DUAL_LANE_RELEASES[0].version).toBe(webPackage.version);
  });

  it("keeps 0.18.0 public release copy about existing member behavior, not operator internals", () => {
    const latest = DUAL_LANE_RELEASES.find((release) => release.version === "0.18.0")!;
    const publicCopy = JSON.stringify(latest);
    expect(latest.releasedAt).toBe("2026-09-10");
    expect(latest.title).toBe("日常功能保持兼容");
    expect(publicCopy).toContain("无需重新设置");
    expect(publicCopy).toContain("成员权限");
    const guide = echoReleaseGuides.find((entry) => entry.version === latest.version);
    expect(guide).toBeDefined();
    expect(publicCopy + JSON.stringify(guide)).not.toMatch(/\b(?:Go|Node|SQL)\b|离线工具|运维|Storage operator/);
  });

  it("describes the 0.15.5 user-facing scope and release date", () => {
    const latest = DUAL_LANE_RELEASES.find((release) => release.version === "0.15.5")!;
    const publicCopy = JSON.stringify(latest);
    expect(latest.version).toBe("0.15.5");
    expect(latest.releasedAt).toBe("2026-08-29");
    expect(publicCopy).toContain("自动保存");
    expect(publicCopy).toContain("连接");
    expect(publicCopy).toContain("停用");
    expect(publicCopy).not.toMatch(/迁移|审计|Token 哈希|token hash/);
  });

  it("describes 0.16.0 as an operator-enabled candidate without changing the trust lanes", () => {
    const latest = DUAL_LANE_RELEASES.find((release) => release.version === "0.16.0")!;
    const publicCopy = JSON.stringify(latest);
    expect(latest.version).toBe("0.16.0");
    expect(latest.releasedAt).toBe("2026-09-07");
    expect(publicCopy).toContain("原有入口");
    expect(publicCopy).toContain("成员权限");
    expect(publicCopy).toContain("不会自动切换");
    expect(publicCopy).toContain("恢复支持");
    expect(echoReleaseGuides.some((guide) => guide.version === latest.version)).toBe(true);
  });

  it("describes the compatible avatar repair without asking users to replace existing data", () => {
    const latest = DUAL_LANE_RELEASES.find((release) => release.version === "0.16.1")!;
    expect(latest.version).toBe("0.16.1");
    expect(latest.releasedAt).toBe("2026-09-10");
    expect(latest.summary).toContain("自定义头像");
    expect(latest.summary).toContain("无需重新上传");
    expect(JSON.stringify(latest)).toContain("访问权限");
  });

  it("keeps the bridge release separate from deferred chat settings", () => {
    const latest = DUAL_LANE_RELEASES.find((release) => release.version === "0.16.2")!;
    expect(latest.summary).toContain("兼容性维护");
    expect(JSON.stringify(latest)).toContain("不增加新的聊天选项");
    expect(JSON.stringify(latest)).not.toContain("自动隐藏");
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
