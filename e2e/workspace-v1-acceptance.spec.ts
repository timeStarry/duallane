import { expect, test } from "@playwright/test";

test.describe("DualLane v1.0 Shared Workspace Login, Search & Dual-End Delivery", () => {
  test("logs into Shared Workspace without HTTP 500, onboards peer via invite, delivers group messages in real time over /ws/workspace, and searches via /api/v1/search", async ({
    browser,
    baseURL,
  }) => {
    const contextOwner = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const contextMember = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pageOwner = await contextOwner.newPage();
    const pageMember = await contextMember.newPage();

    const ownerErrors: string[] = [];
    const memberErrors: string[] = [];
    pageOwner.on("pageerror", (err) => ownerErrors.push(err.message));
    pageMember.on("pageerror", (err) => memberErrors.push(err.message));

    try {
      // 1. Owner opens landing page & signs in via GitHub OAuth flow (dev auto-callback -> 200 OK, zero HTTP 500!)
      await pageOwner.goto(`${baseURL}/`);
      await expect(pageOwner.getByRole("button", { name: "使用 GitHub 登录共享空间" })).toBeVisible();
      await pageOwner.getByRole("button", { name: "使用 GitHub 登录共享空间" }).click();

      // Authenticated into Shared Workspace shell with Saved Messages ("我的收藏")
      await expect(pageOwner.getByRole("heading", { name: "共享空间" })).toBeVisible();
      await expect(pageOwner.getByRole("button", { name: /我的收藏/ }).first()).toBeVisible();

      // 2. Owner opens Settings -> Profile -> Generates a Workspace Invite Code
      await pageOwner.getByRole("button", { name: "设置中心" }).click();
      const settingsDialog = pageOwner.getByRole("dialog", { name: "DualLane 设置中心" });
      await expect(settingsDialog).toBeVisible();

      // Assert Settings modal is strictly centered inside viewport
      const settingsBox = await settingsDialog.boundingBox();
      expect(settingsBox).not.toBeNull();
      expect(Math.abs(settingsBox!.x + settingsBox!.width / 2 - 640)).toBeLessThan(24);
      expect(settingsBox!.y).toBeGreaterThan(40);
      expect(settingsBox!.y + settingsBox!.height).toBeLessThan(800 - 40);

      await settingsDialog.getByRole("button", { name: "个人" }).click();
      await settingsDialog.getByRole("button", { name: "生成邀请码" }).click();

      const inviteCodeEl = settingsDialog.getByTestId("generated-invite-code");
      await expect(inviteCodeEl).toBeVisible();
      const inviteCode = (await inviteCodeEl.textContent())?.trim() || "";
      expect(inviteCode.length).toBeGreaterThan(4);

      await pageOwner.keyboard.press("Escape");
      await expect(settingsDialog).toBeHidden();

      // 3. Second user (Member B) opens invite link and joins Shared Workspace
      await pageMember.goto(`${baseURL}/?invite=${encodeURIComponent(inviteCode)}`);
      await pageMember
        .getByPlaceholder("可选：测试成员昵称（双窗口联调推荐使用）")
        .fill("协作成员晓明");
      await pageMember
        .getByRole("button", { name: "通过邀请码直接加入（开发环境快捷入口）" })
        .click();

      await expect(pageMember.getByRole("heading", { name: "共享空间" })).toBeVisible();

      // 4. Owner creates a new group conversation including Member B ("协作成员晓明")
      await pageOwner.getByRole("button", { name: "新建群组" }).click();
      const createGroupDialog = pageOwner.getByRole("dialog", { name: "新建群组对话" });
      await expect(createGroupDialog).toBeVisible();
      await createGroupDialog
        .getByPlaceholder("群组名称，例如：产品设计与架构")
        .fill("v1.0 双端实时验收群");
      await createGroupDialog.getByRole("button", { name: /协作成员晓明/ }).click();
      await createGroupDialog.getByRole("button", { name: "创建群组" }).click();
      await expect(createGroupDialog).toBeHidden();

      // Select the newly created group on Owner
      await pageOwner.getByRole("button", { name: /v1\.0 双端实时验收群/ }).click();

      // Member B receives conversation.created in real time over /ws/workspace without reload!
      const memberGroupBtn = pageMember.getByRole("button", { name: /v1\.0 双端实时验收群/ });
      await expect(memberGroupBtn).toBeVisible();
      await memberGroupBtn.click();

      // 5. Owner sends a message -> Member B receives it in real time over /ws/workspace!
      const ownerComposer = pageOwner.getByPlaceholder("发送消息到 v1.0 双端实时验收群…");
      await ownerComposer.fill("共享空间双端实时送达验收通过 2026");
      await ownerComposer.press("Enter");

      await expect(
        pageMember.locator("section").getByText("共享空间双端实时送达验收通过 2026")
      ).toBeVisible();

      // 6. Member B replies -> Owner receives reply in real time over /ws/workspace!
      const memberComposer = pageMember.getByPlaceholder("发送消息到 v1.0 双端实时验收群…");
      await memberComposer.fill("晓明已实时收到，正在验证全文检索跳转！");
      await memberComposer.press("Enter");

      await expect(
        pageOwner.locator("section").getByText("晓明已实时收到，正在验证全文检索跳转！")
      ).toBeVisible();

      // 7. Owner switches to Saved Messages, opens Global Search (⌘K), searches via /api/v1/search, and jumps back to the group message!
      await pageOwner.getByRole("button", { name: /我的收藏/ }).first().click();
      await pageOwner.getByRole("button", { name: "全局搜索" }).click();

      const searchDialog = pageOwner.getByRole("dialog", { name: /全局搜索/ });
      await expect(searchDialog).toBeVisible();

      const searchBox = await searchDialog.boundingBox();
      expect(searchBox).not.toBeNull();
      expect(Math.abs(searchBox!.x + searchBox!.width / 2 - 640)).toBeLessThan(24);

      await searchDialog.getByPlaceholder("输入关键词、文件名或指令…").fill("全文检索跳转");
      await expect(searchDialog).toContainText("服务端全文检索");
      const hitButton = searchDialog.getByRole("button", {
        name: /晓明已实时收到，正在验证全文检索跳转！/,
      });
      await expect(hitButton).toBeVisible();
      await hitButton.click();

      await expect(searchDialog).toBeHidden();
      await expect(
        pageOwner.getByRole("heading", { name: "v1.0 双端实时验收群" })
      ).toBeVisible();

      expect(ownerErrors).toEqual([]);
      expect(memberErrors).toEqual([]);
    } finally {
      await contextOwner.close();
      await contextMember.close();
    }
  });
});
