import { randomUUID } from "node:crypto";
import { expect, test, type Locator } from "@playwright/test";

async function pressImeEnter(input: Locator, isComposing: boolean) {
  await input.evaluate((element, composing) => {
    // Preserve the browser's real implicit form submission. dispatchEvent alone
    // cannot reproduce this regression after the composer became an input.
    element.addEventListener("keydown", (event) => {
      Object.defineProperty(event, "isComposing", { configurable: true, value: composing });
      Object.defineProperty(event, "keyCode", { configurable: true, value: 229 });
      Object.defineProperty(event, "which", { configurable: true, value: 229 });
    }, { capture: true, once: true });
  }, isComposing);
  await input.press("Enter");
}

test("P2P composer leaves IME confirmation in the draft and sends ordinary Enter once", async ({ page }) => {
  const text = `p2p-ime-${randomUUID().slice(0, 8)}`;
  await page.goto("/");
  await page.getByTestId("home-card-direct").click();
  await expect(page.getByTestId("p2p-peer-status")).toContainText("等待对端加入");
  const input = page.getByLabel("发送端到端加密消息", { exact: true });
  const messages = page.locator("[data-p2p-message-id]").filter({ hasText: text });
  await input.fill(text);

  await pressImeEnter(input, true);
  await expect(input).toHaveValue(text);
  await expect(messages).toHaveCount(0);

  // Safari may report isComposing=false for the confirming Enter, but retains
  // keyCode 229. That key must not trigger the input's form submission either.
  await pressImeEnter(input, false);
  await expect(input).toHaveValue(text);
  await expect(messages).toHaveCount(0);

  await input.press("Enter");
  await expect(messages).toHaveCount(1);
  await expect(input).toHaveValue("");
});
