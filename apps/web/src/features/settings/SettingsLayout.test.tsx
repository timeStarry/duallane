import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsLayout, settingsCategory, settingsParent } from "./SettingsLayout";

describe("personal settings hierarchy", () => {
  it("keeps notification deep links under their actual parent", () => {
    expect(settingsParent("email")).toBe("notifications");
    expect(settingsParent("push")).toBe("notifications");
    expect(settingsCategory("email")).toBe("notifications");
    expect(settingsCategory("push")).toBe("notifications");
    expect(settingsParent("profile")).toBe("");
    expect(settingsParent("appearance")).toBe("");
  });

  it("exposes the complete personal directory while identifying the selected parent", () => {
    const html = renderToStaticMarkup(<SettingsLayout section="email" currentUser={{ displayName: "测试成员", githubLogin: "member-test" }} onNavigate={vi.fn()} onBack={vi.fn()} onLogout={vi.fn()}><p>邮件偏好内容</p></SettingsLayout>);
    for (const category of ["profile", "appearance", "chat", "notifications", "privacy", "emotes", "bot"]) expect(html).toContain(`data-settings-category="${category}"`);
    expect(html).toContain('aria-current="page" data-settings-category="notifications"');
    expect(html).toContain('aria-label="返回通知"');
    expect(html).toContain("邮件偏好内容");
    expect(html).toContain("退出当前设备上的共享空间");
  });
});
