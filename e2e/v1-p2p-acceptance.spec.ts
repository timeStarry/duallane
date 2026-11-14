import { expect, test } from "@playwright/test";

test.describe("DualLane v1.0 P2P Direct Lane & UI Acceptance", () => {
  test("guards Workspace login when Workspace backend is absent, centers modals, avoids search crash, and delivers E2EE P2P messages across two browsers", async ({
    browser,
    baseURL,
  }) => {
    const contextA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const pageErrorsA: string[] = [];
    const pageErrorsB: string[] = [];
    pageA.on("pageerror", (err) => pageErrorsA.push(err.message));
    pageB.on("pageerror", (err) => pageErrorsB.push(err.message));

    try {
      // 1. Open landing screen on Browser A (only Go P2P backend is running; Workspace backend is absent)
      await pageA.goto(`${baseURL}/`);
      await expect(pageA.getByRole("button", { name: "使用 GitHub 登录共享空间" })).toBeVisible();

      // Clicking GitHub sign-in when Workspace backend is unavailable MUST NOT navigate to a raw HTTP 500 error screen
      await pageA.getByRole("button", { name: "使用 GitHub 登录共享空间" }).click();
      await expect(pageA.getByRole("button", { name: "免登录进入私密直连通道" })).toBeVisible();
      expect(pageErrorsA).toEqual([]);

      // 2. Enter P2P Direct Lane & create remote E2EE room on Go P2P backend
      await pageA.getByRole("button", { name: "免登录进入私密直连通道" }).click();
      await expect(pageA).toHaveURL(/\/direct\/[A-Za-z0-9_-]+#k=[A-Za-z0-9_-]+/);

      const shareUrl = pageA.url();

      // Peer status MUST explicitly report waiting for peer (1/2), NEVER falsely claiming ready/delivered
      const peerStatusA = pageA.getByTestId("p2p-peer-status");
      await expect(peerStatusA).toContainText("等待对端加入 · 仅本机在线 1/2");

      // 3. Send a message while alone: must be marked queued ("等待对端加入"), NOT delivered ("对端已收")
      const inputA = pageA.getByLabel("发送端到端加密消息");
      await inputA.fill("第一条待发加密消息：等待对端上线");
      await pageA.getByRole("button", { name: "暂存待发" }).click();

      const firstBubbleA = pageA.locator("[data-p2p-message-id]").first();
      await expect(firstBubbleA).toContainText("第一条待发加密消息：等待对端上线");
      await expect(firstBubbleA).toHaveAttribute("data-delivery-status", "queued");
      await expect(firstBubbleA).toContainText("等待对端加入");
      await expect(firstBubbleA).not.toContainText("对端已收");

      // 4. Verify CommandSearchModal centering + non-white-screen when typing
      await pageA.getByRole("button", { name: "全局搜索" }).click();
      const searchDialog = pageA.getByRole("dialog", { name: /全局搜索/ });
      await expect(searchDialog).toBeVisible();

      const searchBox = await searchDialog.boundingBox();
      expect(searchBox).not.toBeNull();
      expect(searchBox!.x).toBeGreaterThan(100);
      expect(searchBox!.y).toBeGreaterThan(40);
      expect(searchBox!.x + searchBox!.width).toBeLessThan(1280 - 100);
      expect(searchBox!.y + searchBox!.height).toBeLessThan(800 - 40);
      expect(Math.abs(searchBox!.x + searchBox!.width / 2 - 640)).toBeLessThan(24);

      await searchDialog.getByPlaceholder("输入关键词、文件名或指令…").fill("第一条待发加密消息");
      await expect(searchDialog).toContainText("私密直连内存消息");
      await expect(searchDialog).toContainText("第一条待发加密消息：等待对端上线");
      expect(pageErrorsA).toEqual([]);
      await pageA.keyboard.press("Escape");
      await expect(searchDialog).toBeHidden();

      // 5. Verify SettingsModal centering inside viewport
      await pageA.getByRole("button", { name: "设置中心" }).click();
      const settingsDialog = pageA.getByRole("dialog", { name: "DualLane 设置中心" });
      await expect(settingsDialog).toBeVisible();

      const settingsBox = await settingsDialog.boundingBox();
      expect(settingsBox).not.toBeNull();
      expect(settingsBox!.x).toBeGreaterThan(100);
      expect(settingsBox!.y).toBeGreaterThan(40);
      expect(settingsBox!.x + settingsBox!.width).toBeLessThan(1280 - 100);
      expect(settingsBox!.y + settingsBox!.height).toBeLessThan(800 - 40);
      expect(Math.abs(settingsBox!.x + settingsBox!.width / 2 - 640)).toBeLessThan(24);
      await pageA.keyboard.press("Escape");
      await expect(settingsDialog).toBeHidden();

      // 6. Browser B joins via the exact encrypted #k= share link
      await pageB.goto(shareUrl);
      const peerStatusB = pageB.getByTestId("p2p-peer-status");

      // Both Browser A and Browser B transition to 2/2 peer connected
      await expect(peerStatusA).toContainText("对端已连接 · 2/2 在线");
      await expect(peerStatusB).toContainText("对端已连接 · 2/2 在线");

      // Browser A's queued message flushes automatically, decrypts in Browser B, and gets encrypted ACK ("对端已收") in Browser A!
      await expect(pageB.locator("[data-p2p-message-id]").first()).toContainText(
        "第一条待发加密消息：等待对端上线"
      );
      await expect(firstBubbleA).toHaveAttribute("data-delivery-status", "delivered");
      await expect(firstBubbleA).toContainText("对端已收");

      // 7. Browser B sends a real-time encrypted reply back to Browser A
      await pageB.getByLabel("发送端到端加密消息").fill("对端已连接，AES-256-GCM 双向回执确认！");
      await pageB.getByRole("button", { name: "加密发送" }).click();

      await expect(pageA.locator("[data-p2p-message-id]").nth(1)).toContainText(
        "对端已连接，AES-256-GCM 双向回执确认！"
      );
      await expect(pageB.locator("[data-p2p-message-id]").nth(1)).toHaveAttribute(
        "data-delivery-status",
        "delivered"
      );

      // 8. Browser B disconnects -> Browser A immediately reflects peer departure ("等待对端加入 · 仅本机在线 1/2")
      await pageB.close();
      await expect(peerStatusA).toContainText("等待对端加入 · 仅本机在线 1/2");

      expect(pageErrorsA).toEqual([]);
      expect(pageErrorsB).toEqual([]);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
