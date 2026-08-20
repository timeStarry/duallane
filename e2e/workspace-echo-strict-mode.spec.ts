import { expect, test, type Page, type Response } from "@playwright/test";

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
}

test("Echo command settles once when the app runs under React StrictMode", async ({ page }) => {
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
  const conversation = await conversationResponse.json() as { conversation: { id: string } };
  await page.goto(`/workspace/chat/${conversation.conversation.id}`);
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");

  const successfulCommandResponses: Response[] = [];
  page.on("response", (response) => {
    if (
      response.url().endsWith("/api/workspace/interactions/commands") &&
      response.request().method() === "POST" &&
      response.status() === 200
    ) {
      successfulCommandResponses.push(response);
    }
  });

  const chat = page.getByRole("region", { name: "回声" });
  await chat.getByLabel("输入消息").fill("/help");
  await chat.locator("form.workspace-composer button.workspace-send-button").click();

  const interaction = chat.getByRole("region", { name: "回声交互" });
  await expect(interaction.getByText("可用命令", { exact: true }).first()).toBeVisible();
  await expect(interaction.getByText("正在执行命令", { exact: true })).toHaveCount(0);
  await expect.poll(() => successfulCommandResponses.length).toBe(1);
  await expect(interaction).toHaveCount(1);
});
