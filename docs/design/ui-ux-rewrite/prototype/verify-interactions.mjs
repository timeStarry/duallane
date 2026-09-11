import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const html = await readFile(new URL('./index.html', import.meta.url));
const server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = process.env.DESIGN_SCREENSHOT_DIR;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const errors = [], external = [], checks = [];
function watch(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) external.push(request.url()); });
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); watch(page);
  page.setDefaultTimeout(10000);
  await page.goto(origin + '/#context-actions');
  const more = page.locator('[data-more=self]');
  const menu = page.locator('#ux-context-menu');
  await more.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('End'); await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Home'); await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(more).toBeFocused();
  const self = page.locator('[data-object=self]');
  await self.focus(); await page.keyboard.press('Shift+F10'); await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '回复', exact: true }).click();
  await expect(page.locator('#ux-draft')).toBeFocused();
  await page.locator('#ux-draft').fill('切换设置后继续这条草稿');
  await more.click(); await menu.getByRole('menuitem', { name: '设为常驻消息' }).click();
  await expect(self).toContainText('常驻');
  await more.click(); await menu.getByRole('menuitem', { name: '撤回消息' }).click();
  await expect(page.locator('#ux-confirm')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(self).toContainText('周六');
  await page.locator('[data-more=lin]').click();
  await expect(menu.getByRole('menuitem', { name: '撤回消息' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: /对自己隐藏/ }).click();
  await expect(page.locator('[data-object=lin]')).toContainText('已对自己隐藏');
  await page.locator('[data-restore=lin]').click();
  await expect(page.locator('[data-object=lin]')).toContainText('周末去山里');
  checks.push('Shared actions, keyboard opening/navigation/escape, reply draft, pin, hide/restore, recall cancellation and ownership');
  console.log(checks.at(-1));

  const native = await self.locator('.ux-text').evaluate(element => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    element.dispatchEvent(event); return { prevented: event.defaultPrevented, selection: getComputedStyle(element).userSelect };
  });
  assert.equal(native.prevented, false); assert.equal(native.selection, 'text');
  await self.locator('.ux-object-hint').click({ button: 'right' }); await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox(); assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1440 && bounds.y + bounds.height <= 1000);
  if (output) await page.screenshot({ path: join(output, 'context-desktop.png') });
  await page.mouse.wheel(0, 120); await expect(menu).toBeHidden();
  // Edge collision: synthetic coordinates exercise the same viewport placement handler.
  await self.locator('.ux-object-hint').dispatchEvent('contextmenu', { clientX: 1438, clientY: 998 });
  const edge = await menu.boundingBox(); assert.ok(edge.x + edge.width <= 1428.6 && edge.y + edge.height <= 988.6);
  await page.keyboard.press('Escape');
  checks.push('Native text selection/context menu retained, right-click opens, viewport collision and scroll dismissal');
  console.log(checks.at(-1));

  const go = route => page.locator(`#prefs-nav [data-route="${route}"]`).click();
  await go('notifications');
  await page.locator('#prefs-pane [data-route="notifications/email"]').click();
  await expect(page.locator('#prefs-title')).toHaveText('邮件通知');
  await page.locator('#prefs-fail-next').click();
  await page.locator('[data-pref=email]').click();
  await expect(page.locator('[data-save-status=email]')).toContainText('保存失败');
  await page.locator('[data-retry=email]').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-save-status=email]')).toBeFocused();
  await expect(page.locator('[data-save-status=email]')).toContainText('已在本页保存');
  await expect(page.locator('[data-save-status=email]')).toBeFocused();
  await page.locator('#prefs-pane .prefs-back').click();
  await expect(page.locator('#prefs-title')).toHaveText('通知');
  await expect(page.locator('#prefs-pane [data-route="notifications/email"]')).toContainText('已关闭');
  await go('profile');
  await page.locator('#prefs-name').fill('小林的新名字');
  await go('appearance');
  await expect(page.locator('#ux-confirm')).toContainText('还有未保存');
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.locator('#prefs-name')).toHaveValue('小林的新名字');
  await page.locator('#prefs-fail-next').click();
  await page.locator('#prefs-save-profile').click();
  await expect(page.locator('[data-save-status=profile]')).toContainText('保存失败');
  await expect(page.locator('#prefs-name')).toHaveValue('小林的新名字');
  await page.locator('[data-retry=profile]').click();
  await expect(page.locator('[data-save-status=profile]')).toContainText('已在本页保存');
  await expect(page.locator('#prefs-identity-name')).toHaveText('小林的新名字');
  // A late success may save its own snapshot, but cannot erase newer input or label it saved.
  await page.locator('#prefs-name').fill('第一次修改'); await page.locator('#prefs-save-profile').click();
  await page.locator('#prefs-name').fill('继续输入的内容');
  await expect(page.locator('[data-save-status=profile]')).toContainText('有未保存的修改');
  await expect(page.locator('#prefs-name')).toHaveValue('继续输入的内容');
  await go('appearance'); await page.getByRole('button', { name: '放弃修改并离开' }).click();
  await expect(page.locator('#prefs-title')).toHaveText('外观');
  await expect(page.locator('#ux-draft')).toHaveValue('切换设置后继续这条草稿');
  checks.push('Settings hierarchy, failed save/retry, profile dirty guard/discard, snapshot races and unrelated draft retention');
  console.log(checks.at(-1));

  await go('notifications'); await page.locator('#prefs-pane [data-route="notifications/push"]').click();
  await page.goBack(); await expect(page.locator('#prefs-title')).toHaveText('通知');
  await page.goForward(); await expect(page.locator('#prefs-title')).toHaveText('手机推送');
  await go('profile'); await page.locator('#prefs-name').fill('浏览器返回时保留');
  await page.goBack(); await expect(page.locator('#ux-confirm')).toContainText('还有未保存');
  await page.getByRole('button', { name: '继续编辑' }).click();
  await expect(page.locator('#prefs-name')).toHaveValue('浏览器返回时保留');
  await page.waitForURL(/settings=profile/);
  await page.goBack(); await page.getByRole('button', { name: '放弃修改并离开' }).click();
  await expect(page.locator('#prefs-title')).toHaveText('手机推送');
  checks.push('Browser back/forward and guarded browser return preserve settings state');
  console.log(checks.at(-1));

  await go('profile'); await page.locator('#prefs-name').fill('保存后离开的名字');
  await page.locator('#prefs-fail-next').click(); await go('appearance');
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(page.locator('[data-leave-status]')).toContainText('保存失败');
  await expect(page.locator('#prefs-name')).toHaveValue('保存后离开的名字');
  await page.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(page.locator('#prefs-title')).toHaveText('外观');
  await expect(page.locator('#prefs-identity-name')).toHaveText('保存后离开的名字');
  checks.push('Save-and-leave waits for success, keeps the dialog and input on failure, and supports retry');

  await go('appearance');
  let combinations = 0;
  for (const width of [320, 390, 834, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const family of ['original','grove','dusk']) {
      await page.locator(`[data-pref-family=${family}]`).click();
      for (const mode of ['light','dark']) {
        await page.locator(`[data-pref-mode=${mode}]`).click();
        await expect(page.locator('html')).toHaveAttribute('data-family', family);
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}/${family}/${mode}`);
        assert.ok(await page.locator('#prefs-pane').evaluate(element => element.scrollWidth <= element.clientWidth), `Settings overflow ${width}/${family}/${mode}`);
        combinations++;
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-pref-family=original]').click(); await page.locator('[data-pref-mode=light]').click();
  await page.locator('[data-pref-density=compact]').click(); await page.locator('[data-pref=transparency]').click();
  await expect(page.locator('html')).toHaveAttribute('data-density','compact');
  await expect(page.locator('[data-pref=motion]')).toBeDisabled();
  await expect(page.locator('[data-save-status=transparency]')).toContainText('已在本页保存');
  await page.locator('#prefs-pane').evaluate(element => { element.scrollTop = 0; });
  if (output) await page.locator('#prefs-shell').screenshot({ path: join(output, 'settings-desktop.png') });
  checks.push(`${combinations} settings theme/mode/width layouts; independent preferences; system reduced motion priority`);

  const fallback = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); watch(fallback);
  await fallback.goto(origin + '/?settings=profile#personal-settings');
  await fallback.locator('#prefs-name').fill('历史条目没有设置索引');
  await fallback.evaluate(() => dispatchEvent(new PopStateEvent('popstate', { state: null })));
  await fallback.getByRole('button', { name: '放弃修改并离开' }).click();
  await expect(fallback.locator('#prefs-title')).toHaveText('个人设置');
  await fallback.locator('#prefs-nav [data-route=profile]').click();
  await fallback.locator('#prefs-name').fill('下一次仍须保护');
  await fallback.goBack();
  await expect(fallback.locator('#ux-confirm')).toContainText('还有未保存');
  await fallback.close();
  checks.push('Unindexed same-document history fallback cannot bypass a later dirty-form guard');

  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const mobile = await touchContext.newPage(); watch(mobile);
  await mobile.goto(origin + '/#personal-settings');
  await expect(mobile.locator('#prefs-shell')).toHaveAttribute('data-page','home');
  if (output) await mobile.locator('#prefs-shell').screenshot({ path: join(output, 'settings-phone-home.png') });
  await mobile.locator('#prefs-nav [data-route=notifications]').click();
  await mobile.locator('#prefs-pane [data-route="notifications/email"]').click();
  if (output) await mobile.locator('#prefs-shell').screenshot({ path: join(output, 'settings-phone-email.png') });
  await mobile.locator('#prefs-pane .prefs-back').click(); await expect(mobile.locator('#prefs-title')).toHaveText('通知');
  await mobile.locator('#prefs-pane .prefs-back').click(); await expect(mobile.locator('#prefs-shell')).toHaveAttribute('data-page','home');
  const cdp = await touchContext.newCDPSession(mobile);
  const hint = mobile.locator('[data-object=self] .ux-object-hint');
  await hint.scrollIntoViewIfNeeded();
  const point = await hint.boundingBox();
  const x = point.x + 20, y = point.y + point.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await expect(mobile.locator('#ux-action-sheet')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(mobile.locator('[data-object=self]')).toContainText('周六');
  if (output) await mobile.screenshot({ path: join(output, 'context-phone.png') });
  await mobile.locator('#ux-action-sheet [data-close-actions]').click();
  await expect(mobile.locator('[data-more=self]')).toBeFocused();
  await hint.scrollIntoViewIfNeeded();
  const movedPoint = await hint.boundingBox();
  const mx = movedPoint.x + 20, my = movedPoint.y + movedPoint.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mx, y: my, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mx, y: my - 45, id: 1 }] });
  // Wait beyond the recognition threshold to prove movement cancelled the pending gesture.
  await mobile.waitForTimeout(550);
  await expect(mobile.locator('#ux-action-sheet')).toBeHidden();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  for (const cancel of ['quick-release', 'second-pointer', 'pointercancel']) {
    await hint.scrollIntoViewIfNeeded();
    const rect = await hint.boundingBox(), touch = { x: rect.x + 20, y: rect.y + rect.height / 2, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
    if (cancel === 'quick-release') await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    if (cancel === 'second-pointer') await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch, { ...touch, x: touch.x + 50, id: 2 }] });
    if (cancel === 'pointercancel') await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await mobile.waitForTimeout(550);
    await expect(mobile.locator('#ux-action-sheet')).toBeHidden();
    if (cancel === 'second-pointer') await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  checks.push('Mobile category/leaf/back, real Chromium touch long-press opens sheet, release does not execute; movement, early release, second finger and cancellation dismiss candidates');
  await touchContext.close();
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ result: 'PASS', checks, pageErrors: errors, externalRequests: external }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
