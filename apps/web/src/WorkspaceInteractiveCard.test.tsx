import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WorkspaceEchoCard,
  WorkspaceEchoReleaseCard,
  supportsWorkspaceInteractiveCard,
  type WorkspaceCardProjection
} from "./WorkspaceInteractiveCard";

describe("Workspace release card", () => {
  it("supports and renders detailed changes together with their usage locations", () => {
    expect(supportsWorkspaceInteractiveCard({
      type: "card",
      cardId: "card_release",
      cardType: "echo.release",
      schemaVersion: 1,
      fallbackText: "版本更新"
    })).toBe(true);
    const card: WorkspaceCardProjection = {
      block: { type: "card", cardId: "card_release", cardType: "echo.release", schemaVersion: 1, fallbackText: "版本更新" },
      payload: {
        version: "0.15.1",
        releasedAt: "2026-08-20",
        publishedAt: "2026-08-20T08:00:00.000Z",
        title: "更灵活的表情合集",
        summary: "表情合集现在可以订阅更新。",
        sections: [{
          title: "表情合集订阅",
          items: [{
            title: "管理订阅",
            description: "可以关闭订阅并保留当前快照。",
            location: "个人设置 -> 我的表情 -> 合集详情"
          }]
        }]
      },
      status: "active",
      revision: 1,
      actions: []
    };
    const html = renderToStaticMarkup(<WorkspaceEchoReleaseCard card={card} />);
    expect(html).toContain("v0.15.1");
    expect(html).toContain("更灵活的表情合集");
    expect(html).toContain("管理订阅");
    expect(html).toContain("个人设置 -&gt; 我的表情 -&gt; 合集详情");
    expect(html).toContain("workspace-release-location");
  });
});

describe("Workspace Echo requirement cards", () => {
  function renderRequirement(status: string, archiveOutcome?: string, cardType = "echo.request-status") {
    const card: WorkspaceCardProjection = {
      block: { type: "card", cardId: "card_requirement", cardType, schemaVersion: 1, fallbackText: "需求反馈" },
      payload: { publicId: "REQ-TEST-0001", title: "测试需求", phase: status === "archived" ? "archived" : "formal", status, archiveOutcome },
      status: "active",
      revision: 2,
      actions: []
    };
    return renderToStaticMarkup(<WorkspaceEchoCard card={card} onRefresh={() => {}} />);
  }

  it.each([
    ["implemented", "已实现"],
    ["rejected", "已驳回"],
    ["duplicate", "重复提案"],
    ["withdrawn", "已撤回"],
    ["cancelled", "已取消"]
  ])("shows the current archived outcome %s as %s", (outcome, label) => {
    expect(renderRequirement("archived", outcome)).toContain(`<em>${label}</em>`);
  });

  it("keeps the archived fallback when the outcome is absent or unrecognized", () => {
    expect(renderRequirement("archived")).toContain("<em>已归档</em>");
    expect(renderRequirement("archived", "future_outcome")).toContain("<em>已归档</em>");
  });

  it("does not apply an archived outcome to an active requirement or solicitation", () => {
    expect(renderRequirement("delivered", "implemented")).toContain("<em>已交付</em>");
    expect(renderRequirement("archived", "implemented", "echo.solicitation")).toContain("<em>已归档</em>");
  });
});
