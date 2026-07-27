import { expect, test, type BrowserContext, type Page } from "@playwright/test";

async function openPrivateLane(page: Page, displayName: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /一对一直连/ }).click();
  await page.getByLabel("显示名称").fill(displayName);
}

function recordWebSocketPayloads(page: Page, payloads: string[]) {
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      payloads.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8"));
    });
  });
}

test("two private-lane users exchange messages and a file without sending plaintext to signaling", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const contexts: BrowserContext[] = [ownerContext, guestContext];
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  const sentWebSocketPayloads: string[] = [];
  const guestBackendRequests: string[] = [];

  recordWebSocketPayloads(ownerPage, sentWebSocketPayloads);
  recordWebSocketPayloads(guestPage, sentWebSocketPayloads);
  guestPage.on("request", (request) => {
    if (request.url().includes("/api/p2p/") || request.url().includes("/ws/p2p/")) {
      guestBackendRequests.push(request.url());
    }
  });

  try {
    await openPrivateLane(ownerPage, "直连用户甲");
    await ownerPage.getByRole("button", { name: "开始会话" }).click();
    await expect(ownerPage.getByRole("heading", { name: "分享这个邀请链接。" })).toBeVisible();

    const inviteLink = (await ownerPage.locator(".copy-box > span").textContent())?.trim() ?? "";
    const inviteUrl = new URL(inviteLink);
    const roomSecret = inviteUrl.hash.slice("#k=".length);
    expect(inviteUrl.searchParams.get("lane")).toBe("p2p");
    expect(inviteUrl.searchParams.get("room")).toBeTruthy();
    expect(inviteUrl.hash).toMatch(/^#k=[A-Za-z0-9_-]+$/);
    expect(roomSecret).not.toBe("");

    await ownerPage.getByRole("button", { name: "进入聊天" }).click();
    await guestPage.goto(inviteLink);
    await guestPage.getByLabel("显示名称").fill("直连用户乙");
    await guestPage.getByRole("button", { name: "加入会话" }).click();

    await expect(ownerPage.locator("details.p2p-status-control > summary").getByText("浏览器直连", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(guestPage.locator("details.p2p-status-control > summary").getByText("浏览器直连", { exact: true })).toBeVisible({ timeout: 20_000 });

    const ownerSecretMessage = "p2p-e2e-owner-secret";
    await ownerPage.getByLabel("输入消息").fill(ownerSecretMessage);
    await ownerPage.locator("form.composer button.send-button").click();
    await expect(guestPage.getByText(ownerSecretMessage, { exact: true })).toBeVisible();

    const guestSecretMessage = "p2p-e2e-guest-secret";
    await guestPage.getByLabel("输入消息").fill(guestSecretMessage);
    await guestPage.locator("form.composer button.send-button").click();
    await expect(ownerPage.getByText(guestSecretMessage, { exact: true })).toBeVisible();

    await ownerPage.locator('input[type="file"]').setInputFiles({
      name: "private-lane-e2e.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("private file bytes stay on the browser data channel")
    });
    await expect(guestPage.getByText("private-lane-e2e.txt", { exact: true })).toBeVisible();
    await guestPage.getByRole("button", { name: "接受" }).click();
    await expect(guestPage.getByText("文件传输已完成。", { exact: true })).toBeVisible();
    await expect(ownerPage.getByText("文件传输已完成。", { exact: true })).toBeVisible();

    expect(guestBackendRequests.length).toBeGreaterThan(0);
    for (const requestUrl of guestBackendRequests) {
      expect(requestUrl).not.toContain("#k=");
      expect(requestUrl).not.toContain(roomSecret);
    }
    const serializedFrames = sentWebSocketPayloads.join("\n");
    expect(serializedFrames).not.toContain(ownerSecretMessage);
    expect(serializedFrames).not.toContain(guestSecretMessage);
    expect(serializedFrames).not.toContain("private file bytes stay on the browser data channel");
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
