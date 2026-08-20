import { expect, test, type Page } from "@playwright/test";

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
}

test("space owner broadcasts one detailed mobile release guide through Echo", async ({ page }) => {
  await enterWorkspaceAsSeededOwner(page);
  const bootstrapResponse = await page.request.get("/api/workspace/bootstrap");
  expect(bootstrapResponse.status()).toBe(200);
  const bootstrap = await bootstrapResponse.json() as { members: Array<{ id: string }> };
  const echo = bootstrap.members.find((member) => member.id === "usr_system_echo");
  expect(echo).toBeTruthy();

  const conversationResponse = await page.request.post("/api/workspace/conversations", {
    data: { type: "direct", targetUserId: echo!.id }
  });
  expect(conversationResponse.status()).toBe(201);
  const conversation = await conversationResponse.json() as { conversation: { id: string } };
  await page.goto(`/workspace/chat/${conversation.conversation.id}`);
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");

  const chat = page.getByRole("region", { name: "回声" });
  const composer = chat.getByLabel("输入消息");
  await composer.fill("/release 0.15.1");
  await chat.locator("form.workspace-composer button.workspace-send-button").click();

  const interaction = chat.getByRole("region", { name: "回声交互" });
  await expect(interaction.getByText("v0.15.1 更新已发布", { exact: true })).toBeVisible();
  const card = chat.getByRole("group", { name: /DualLane v0\.15\.1 版本更新/ });
  await expect(card).toBeVisible();
  await expect(card.getByText("表情合集订阅", { exact: true })).toBeVisible();
  await expect(card.getByText(/个人设置 -> 我的表情 -> 打开合集详情/)).toBeVisible();
  const bounds = await card.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);

  await interaction.getByRole("button", { name: "完成" }).click();
  await composer.fill("/release v0.15.1");
  await chat.locator("form.workspace-composer button.workspace-send-button").click();
  await expect(interaction.getByText("v0.15.1 更新已发布", { exact: true })).toBeVisible();
  await expect(chat.getByRole("group", { name: /DualLane v0\.15\.1 版本更新/ })).toHaveCount(1);
});
