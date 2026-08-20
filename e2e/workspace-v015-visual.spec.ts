import { expect, test, type Page, type TestInfo } from "@playwright/test";

const RELEASE_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, theme: "light" },
  { name: "laptop-dark", width: 1024, height: 768, theme: "dark" },
  { name: "mobile", width: 390, height: 844, theme: "light" },
  { name: "mobile-compact-dark", width: 360, height: 800, theme: "dark" }
] as const;

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
}

test("Echo workflow remains usable across v0.15 release viewports", async ({ page }, testInfo: TestInfo) => {
  await enterWorkspaceAsSeededOwner(page);
  const bootstrapResponse = await page.request.get("/api/workspace/bootstrap");
  expect(bootstrapResponse.status()).toBe(200);
  const bootstrap = await bootstrapResponse.json() as {
    members: Array<{ id: string; displayName: string }>;
  };
  const echo = bootstrap.members.find((member) => member.id === "usr_system_echo");
  expect(echo?.displayName).toBe("回声");

  const conversationResponse = await page.request.post("/api/workspace/conversations", {
    data: { type: "direct", targetUserId: echo!.id }
  });
  expect(conversationResponse.status()).toBe(201);
  const conversation = (await conversationResponse.json() as {
    conversation: { id: string };
  }).conversation;
  await page.goto(`/workspace/chat/${encodeURIComponent(conversation.id)}`);
  const chat = page.getByRole("region", { name: "回声" });
  await chat.getByLabel("输入消息").fill("/need");
  const commandResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/workspace/interactions/commands") && response.request().method() === "POST"
  );
  await chat.locator("form.workspace-composer button.workspace-send-button").click();
  expect((await commandResponse).status()).toBe(200);

  const workflow = chat.getByRole("region", { name: "回声交互" });
  await expect(workflow.getByText("简短标题", { exact: true }).first()).toBeVisible();

  for (const viewport of RELEASE_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate((theme) => {
      localStorage.setItem("duallane-theme-mode", theme);
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.themeMode = theme;
      document.documentElement.style.colorScheme = theme;
    }, viewport.theme);

    await expect(workflow).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);

    const workflowBox = await workflow.boundingBox();
    expect(workflowBox).not.toBeNull();
    expect(workflowBox!.x).toBeGreaterThanOrEqual(0);
    expect(workflowBox!.x + workflowBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(workflowBox!.y + workflowBox!.height).toBeLessThanOrEqual(viewport.height);

    const continueBox = await workflow.getByRole("button", { name: "继续", exact: true }).boundingBox();
    expect(continueBox).not.toBeNull();
    expect(continueBox!.height).toBeGreaterThanOrEqual(44);

    await page.screenshot({
      path: testInfo.outputPath(`echo-workflow-${viewport.name}.png`),
      animations: "disabled"
    });
  }

  await workflow.getByTitle("取消引导", { exact: true }).click();
  await expect(workflow.getByText("引导已取消", { exact: true }).first()).toBeVisible();
  await workflow.getByTitle("关闭", { exact: true }).click();
  await expect(workflow).toHaveCount(0);
});
