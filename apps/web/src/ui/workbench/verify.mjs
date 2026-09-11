import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium, firefox, webkit, expect } from "@playwright/test";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
await server.listen();
const address = server.httpServer.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch();
const errors = [];
const engineResults = { chromium: "full component and touch checks", firefox: "not installed", webkit: "not installed" };
const output = process.env.DESIGN_SCREENSHOT_DIR;
if (output) await mkdir(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/src/ui/workbench/harness.html`);
  await expect(page.getByRole("heading", { name: "同一份组件，从规则到实际操作" })).toBeVisible();
  const toggle = page.getByRole("switch", { name: "接收会话通知", exact: true });
  await toggle.focus(); await page.keyboard.press("Space"); await expect(toggle).toHaveAttribute("aria-checked", "false");
  assert.equal(await page.locator("#wb-preferences").evaluate((form) => new FormData(form).has("notifications")), false);
  for (const checked of [false, true]) {
    if (checked) await toggle.click();
    const geometry = await toggle.evaluate((button) => {
      const track = button.querySelector(".dl-switch-track").getBoundingClientRect();
      const thumb = button.querySelector(".dl-switch-thumb").getBoundingClientRect();
      const hit = button.getBoundingClientRect();
      return { width: hit.width, height: hit.height, track: [track.width, track.height], thumb: [thumb.width, thumb.height], top: thumb.top - track.top, start: thumb.left - track.left, end: track.right - thumb.right };
    });
    assert.deepEqual(geometry.track, [44, 26]); assert.deepEqual(geometry.thumb, [20, 20]);
    assert.equal(geometry.width, 44); assert.equal(geometry.height, 44); assert.equal(geometry.top, 3); assert.equal(checked ? geometry.end : geometry.start, 3);
  }
  assert.equal(await page.locator("#wb-preferences").evaluate((form) => new FormData(form).get("notifications")), "on");
  const select = page.getByRole("combobox", { name: /^通知范围/ });
  if (await select.isVisible()) {
  await select.click(); await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Escape");
  await expect(select).toContainText("仅回复和提及"); await expect(select).toBeFocused();
  await select.press("ArrowDown"); await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await expect(select).toContainText("关闭通知");
  await select.click(); await expect(page.getByRole("option", { name: /每日摘要/ })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("option", { name: /所有消息/ }).click(); await expect(select).toContainText("所有消息");
  assert.equal(await page.locator("#wb-preferences").evaluate((form) => new FormData(form).get("delivery")), "all");
  await select.click(); await page.keyboard.press("Tab"); await expect(page.getByRole("listbox")).toHaveCount(0);
  } else {
    const choices = page.getByRole("radiogroup", { name: "通知范围", exact: true });
    await expect(choices.getByRole("radio", { name: "每日摘要", exact: true })).toBeDisabled();
    const mentions = choices.getByRole("radio", { name: "仅回复和提及", exact: true });
    await mentions.focus(); await mentions.press("ArrowRight");
    const off = choices.getByRole("radio", { name: "关闭通知", exact: true });
    await expect(off).toBeFocused(); await expect(off).toHaveAttribute("aria-checked", "true");
    await off.press("Home");
    await expect(choices.getByRole("radio", { name: "所有消息", exact: true })).toHaveAttribute("aria-checked", "true");
    assert.equal(await page.locator("#wb-preferences").evaluate((form) => new FormData(form).get("delivery")), "all");
  }
  const range = page.getByRole("slider", { name: "消息字号样例" });
  await range.focus(); await range.press("ArrowRight"); await expect(range).toHaveValue("16");
  const number = page.getByRole("spinbutton", { name: "消息字号样例精确数值" });
  await number.fill("99"); await number.press("Enter"); await expect(number).toHaveAttribute("aria-invalid", "true"); await expect(range).toHaveValue("16");
  await number.press("Escape"); await expect(number).toHaveValue("16");
  const draft = page.getByRole("textbox", { name: "回复草稿" });
  await draft.fill("主题和标签切换后保留");
  await page.getByRole("tab", { name: "消息", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "文件", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End"); await expect(page.getByRole("tab", { name: "成员", exact: true })).toBeFocused();
  await expect(draft).toHaveValue("主题和标签切换后保留");
  const message = page.getByRole("article", { name: "林澈的消息" });
  await message.focus(); await message.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "回复", exact: true })).toBeFocused();
  await page.keyboard.press("End"); await expect(page.getByRole("menuitem", { name: "从我的视图隐藏" })).toBeFocused();
  await page.keyboard.press("Home"); await page.keyboard.press("Escape"); await expect(message).toBeFocused();
  await page.getByRole("button", { name: "更多消息操作" }).click(); await page.getByRole("menuitem", { name: "从我的视图隐藏" }).click();
  await expect(page.getByRole("dialog", { name: "隐藏这条样例消息？" })).toBeVisible(); await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: "取消", exact: true }).click(); await expect(message).toBeFocused();
  const native = await message.locator("[data-native-context]").evaluate((element) => { const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); element.dispatchEvent(event); return !event.defaultPrevented; });
  assert.equal(native, true);
  await message.locator("footer").click({ button: "right" }); await expect(page.getByRole("menu")).toBeVisible();
  if (output) await page.screenshot({ path: join(output, "production-components-desktop-menu.png") });
  await page.keyboard.press("Escape");
  await message.evaluate((element) => {
    const parent = element.parentElement;
    parent.style.maxHeight = "240px";
    parent.style.overflow = "auto";
  });
  await message.locator("footer").click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await message.evaluate((element) => {
    element.style.transform = "translateY(1px)";
    element.parentElement.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  await expect(page.getByRole("menu")).toBeVisible();
  await message.evaluate((element) => {
    const spacer = document.createElement("div");
    spacer.dataset.historyCompensation = "";
    spacer.style.height = "150px";
    element.parentElement.prepend(spacer);
    element.parentElement.scrollTop += 150;
  });
  await expect(page.getByRole("menu")).toBeVisible();
  // This assertion means deliberate user scrolling. A programmatic scrollTop
  // change can instead be a history/layout compensation and must keep the menu.
  await message.locator("..").hover({ position: { x: 15, y: 200 } });
  await page.mouse.wheel(0, 80);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await message.evaluate((element) => { element.parentElement.querySelector("[data-history-compensation]").remove(); element.style.transform = ""; element.parentElement.style.maxHeight = ""; element.parentElement.style.overflow = ""; });
  console.log("Switch geometry; select cancel, keyboard, disabled and commit; slider errors; tabs; object menu and confirmation focus passed.");

  let combinations = 0;
  for (const width of [320, 390, 834, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["原色", "苔原", "暮色", "米色", "极简"]) for (const mode of ["浅色", "深色"]) {
      await page.getByRole("combobox", { name: /^工作台主题/ }).click(); await page.getByRole("option", { name: theme, exact: true }).click();
      await chooseAdaptive(page, "工作台明暗模式", mode);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}/${theme}/${mode} overflow`);
      await expect(draft).toHaveValue("主题和标签切换后保留");
      combinations++;
    }
  }
  if (output) await page.screenshot({ path: join(output, "production-components-desktop-dark.png"), fullPage: true });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const phone = await mobile.newPage(); phone.setDefaultTimeout(10000); phone.on("pageerror", (error) => errors.push(error.message));
  await phone.goto(`${origin}/src/ui/workbench/harness.html`);
  await phone.getByRole("button", { name: "更多消息操作" }).click(); await expect(phone.getByRole("dialog", { name: "消息操作" })).toBeVisible();
  await expect(phone.getByRole("menuitem", { name: "回复", exact: true })).toBeFocused();
  if (output) await phone.screenshot({ path: join(output, "production-components-phone-sheet.png") });
  await phone.getByRole("button", { name: "关闭操作面板" }).click();
  const footer = phone.locator(".dl-workbench-object footer"); await footer.scrollIntoViewIfNeeded();
  const box = await footer.boundingBox(); const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  const cdp = await mobile.newCDPSession(phone);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await expect(phone.getByRole("dialog", { name: "消息操作" })).toBeVisible();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(phone.getByRole("article", { name: "林澈的消息" })).toBeVisible();
  await phone.getByRole("button", { name: "关闭操作面板" }).click();
  await footer.scrollIntoViewIfNeeded();
  const target = await footer.boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: target.x + 30, y: target.y + 15 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: target.x + 30, y: target.y - 30 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await phone.waitForTimeout(500);
  await expect(phone.getByRole("dialog", { name: "消息操作" })).toHaveCount(0);
  await verifyLongSelection(phone, output ? join(output, "production-components-phone-long-select.png") : undefined);

  for (const [name, engine] of [["firefox", firefox], ["webkit", webkit]]) {
    if (!existsSync(engine.executablePath())) continue;
    const engineBrowser = await engine.launch();
    try {
      const enginePage = await engineBrowser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
      enginePage.setDefaultTimeout(10000);
      enginePage.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
      await enginePage.goto(`${origin}/src/ui/workbench/harness.html`);
      await chooseAdaptive(enginePage, "通知范围", "关闭通知");
      await chooseAdaptive(enginePage, "通知范围", "仅回复和提及");
      await verifyLongSelection(enginePage);
      engineResults[name] = "adaptive short choices and searchable mobile selection page passed";
    } finally { await engineBrowser.close(); }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, appearanceViewportCombinations: combinations, phone: "more, long press, release suppression, movement cancellation, long selection page", engines: engineResults, browserErrors: errors }));
} finally {
  await browser.close();
  await server.close();
}

async function chooseAdaptive(page, label, option) {
  const radio = page.getByRole("radiogroup", { name: label, exact: true }).getByRole("radio", { name: option, exact: true });
  if (await radio.isVisible()) {
    await radio.click();
    await expect(radio).toHaveAttribute("aria-checked", "true");
  } else {
    const select = page.getByRole("combobox", { name: new RegExp(`^${label}`) });
    await select.click();
    await page.getByRole("option", { name: new RegExp(`^${option}(?:\\s|$)`) }).click();
    await expect(select).toContainText(option);
  }
}

async function verifyLongSelection(page, screenshotPath) {
  const select = page.getByRole("combobox", { name: /^目标讨论组/ });
  const layer = page.getByRole("dialog", { name: "选择目标讨论组" });
  const search = layer.getByRole("combobox", { name: "搜索目标讨论组" });
  const back = layer.getByRole("button", { name: "返回，取消选择目标讨论组" });
  const record = page.getByRole("status", { name: "选择记录" });
  await select.click();
  await expect(layer).toBeVisible();
  await expect(layer.getByRole("heading", { name: "选择目标讨论组" })).toBeFocused();
  await expect(layer.getByRole("option", { name: /设计讨论组 05/ })).toHaveAttribute("aria-disabled", "true");
  assert.ok(await layer.evaluate((element) => element.scrollWidth <= innerWidth));
  await search.fill("不存在的讨论组");
  await expect(layer.getByText("没有匹配的选项，请换个关键词")).toBeVisible();
  await page.keyboard.press("Enter"); await expect(layer).toBeVisible();
  await search.fill("讨论组 18");
  await expect(layer.getByRole("option")).toHaveCount(1);
  await expect(layer.getByRole("option")).toContainText("Workspace-configuration-with-a-very-long-name");
  if (screenshotPath) await page.screenshot({ path: screenshotPath });
  await back.click(); await expect(layer).toHaveCount(0); await expect(select).toBeFocused();
  await expect(record).toContainText("group-1 · 已提交 0 次");

  await select.click(); await search.fill("讨论组 07");
  await search.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true });
  await expect(layer).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(layer).toHaveCount(0); await expect(select).toBeFocused();
  await expect(record).toContainText("group-7 · 已提交 1 次");
  await select.click(); await search.fill("讨论组 05");
  await page.keyboard.press("Enter"); await expect(layer).toBeVisible();
  await page.keyboard.press("Escape"); await expect(layer).toHaveCount(0); await expect(select).toBeFocused();
  await expect(record).toContainText("group-7 · 已提交 1 次");

  await page.getByRole("button", { name: "模拟选项更新", exact: true }).click();
  await select.click(); await search.fill("讨论组 18");
  await expect(layer.getByRole("option")).toHaveCount(1);
  await expect(layer.getByText("没有匹配的选项，请换个关键词")).toBeVisible({ timeout: 7000 });
  await expect(search).toHaveValue("讨论组 18"); await expect(search).toBeFocused();
  await page.keyboard.press("Enter"); await expect(layer).toBeVisible();
  await layer.getByRole("button", { name: "清除搜索" }).click();
  await expect(layer.getByRole("option")).toHaveCount(6);
  await expect(layer).toBeVisible();
  await page.keyboard.press("Escape"); await expect(select).toBeFocused();
  await expect(record).toContainText("group-7 · 已提交 1 次");
  await page.getByRole("button", { name: "恢复完整列表" }).click();
  await expect(select).toContainText("设计讨论组 07");
}
