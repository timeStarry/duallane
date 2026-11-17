import { expect, test, type Page } from "@playwright/test";

async function createRoom(page: Page) {
  await page.goto("/");
  await page.getByTestId("home-card-direct").click();
  await expect.poll(() => /^\/direct\/[A-Za-z0-9_-]+$/.test(new URL(page.url()).pathname) && new URL(page.url()).hash.startsWith("#k=")).toBe(true);
  await expect(page.getByTestId("p2p-peer-status")).toContainText("等待对端加入");
  return page.url();
}

async function send(page: Page, text: string) {
  const input = page.getByLabel("发送端到端加密消息", { exact: true });
  await input.fill(text);
  await input.press("Enter");
}

test("private active sends return to latest while incoming messages preserve history", async ({ page, browser }) => {
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  try {
    await guest.goto(await createRoom(page));
    await expect(page.getByTestId("p2p-peer-status")).toContainText("对端已连接");
    await expect(guest.getByTestId("p2p-peer-status")).toContainText("对端已连接");
    for (let index = 0; index < 35; index += 1) {
      const text = `供阅读的直连历史 ${index}`;
      await send(guest, text);
      await expect(page.getByText(text, { exact: true })).toHaveCount(1);
    }
    const list = page.getByRole("region", { name: "私密直连对话" }).locator("div.overflow-y-auto").first();
    const gap = () => list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
    await expect.poll(gap).toBeLessThanOrEqual(1);
    await list.hover();
    await page.mouse.wheel(0, -650);
    await expect.poll(gap).toBeGreaterThan(300);
    const top = await list.evaluate(element => element.scrollTop);
    await send(guest, "阅读期间对方的新消息");
    await expect(page.getByText("阅读期间对方的新消息", { exact: true })).toHaveCount(1);
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(top);
    await send(page, "主动发送后看最新消息");
    await expect.poll(gap).toBeLessThanOrEqual(1);
    await expect(guest.getByText("主动发送后看最新消息", { exact: true })).toHaveCount(1);
  } finally {
    await guestContext.close();
  }
});

test("returning to the private list keeps the draft and explicit exit clears the room", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createRoom(page);
  const input = page.getByLabel("发送端到端加密消息", { exact: true });
  await input.fill("仍在当前会话中的草稿");
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await expect(page).toHaveURL(/\/direct$/);
  await page.getByRole("button", { name: /房间 #/ }).click();
  await expect(input).toHaveValue("仍在当前会话中的草稿");
  await input.press("Enter");
  await expect(page.locator("[data-p2p-message-id]").filter({ hasText: "仍在当前会话中的草稿" })).toHaveCount(1);
  await page.getByRole("button", { name: "退出直连房间" }).click();
  await expect(page).toHaveURL(/\/direct$/);
  await expect(page.getByRole("button", { name: /房间 #/ })).toHaveCount(0);
  await expect(page.locator("[data-p2p-message-id]")).toHaveCount(0);
});
