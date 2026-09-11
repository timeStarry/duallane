import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

type SyntheticKeyOptions = {
  isComposing: boolean;
  keyCode: number;
  key?: string;
  shiftKey?: boolean;
};

async function dispatchSyntheticKey(input: Locator, options: SyntheticKeyOptions) {
  return input.evaluate((element, keyOptions) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      code: "Enter",
      key: keyOptions.key ?? "Enter",
      shiftKey: Boolean(keyOptions.shiftKey)
    });
    Object.defineProperty(event, "isComposing", { configurable: true, value: keyOptions.isComposing });
    Object.defineProperty(event, "keyCode", { configurable: true, value: keyOptions.keyCode });
    Object.defineProperty(event, "which", { configurable: true, value: keyOptions.keyCode });
    return { dispatched: element.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
  }, options);
}

async function dispatchSafariImeEnter(input: Locator) {
  return input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      code: "Enter",
      key: "Enter"
    });
    Object.defineProperty(event, "isComposing", { configurable: true, value: false });
    Object.defineProperty(event, "keyCode", { configurable: true, value: 229 });
    Object.defineProperty(event, "which", { configurable: true, value: 229 });
    return { dispatched: element.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
  });
}

test("P2P textarea leaves an IME confirmation in the draft", async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  await page.goto("/");
  await page.getByRole("button", { name: /一对一直连/ }).click();
  await page.getByLabel("显示名称").fill(`IME P2P ${suffix}`);
  await page.getByRole("button", { name: "开始会话" }).click();
  await expect(page.getByRole("heading", { name: "邀请对方，开始交流" })).toBeVisible();

  const input = page.getByLabel("输入消息");
  const p2pHttpWrites: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/p2p/")) {
      p2pHttpWrites.push(request.url());
    }
  });
  const text = `p2p-ime-${suffix}`;
  await input.fill(text);
  const imeKey = await dispatchSafariImeEnter(input);
  expect(imeKey).toEqual({ dispatched: true, defaultPrevented: false });
  await expect(input).toHaveValue(text);
  await expect(page.locator("article.message").filter({ hasText: text })).toHaveCount(0);
  expect(p2pHttpWrites).toHaveLength(0);

  const ordinaryKey = await dispatchSyntheticKey(input, { isComposing: false, keyCode: 13 });
  expect(ordinaryKey).toEqual({ dispatched: false, defaultPrevented: true });
  await expect(page.locator("article.message").filter({ hasText: text })).toHaveCount(1);
});
