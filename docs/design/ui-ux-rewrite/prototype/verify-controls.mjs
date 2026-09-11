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
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#control-details');
  const customizableSelect = await page.evaluate(() => CSS.supports('appearance', 'base-select'));
  assert.ok(customizableSelect, 'This browser gate checks the enhanced Chromium picker; other browsers still need acceptance.');
  const select = page.locator('#controls-select');
  await select.click(); await expect(page.locator('#controls-select:open')).toHaveCount(1);
  if (output) await page.screenshot({ path: join(output, 'controls-picker-desktop.png') });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(select).toHaveValue('unread');
  await expect(page.locator('#controls-select-feedback')).toContainText('未读内容');
  await select.click(); await page.keyboard.press('Escape');
  await expect(select).toHaveValue('unread'); await expect(select).toBeFocused();
  await expect(select.locator('[value=unavailable]')).toBeDisabled();
  const range = page.locator('#controls-range'), number = page.locator('#controls-size');
  await range.focus(); await page.keyboard.press('ArrowRight');
  await expect(number).toHaveValue('16'); await expect(page.locator('#controls-type-preview')).toHaveCSS('font-size', '16px');
  await page.keyboard.press('End'); await expect(range).toHaveValue('20');
  await page.keyboard.press('Home'); await expect(range).toHaveValue('12');
  await number.fill('18'); await expect(range).toHaveValue('18');
  await number.fill('99'); await expect(number).toHaveAttribute('aria-invalid', 'true'); await expect(range).toHaveValue('18');
  await number.fill('15'); await expect(number).toHaveAttribute('aria-invalid', 'false');
  const scroll = page.locator('.controls-scroll');
  await scroll.focus(); await page.keyboard.press('ArrowDown');
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await scroll.evaluate(element => { element.scrollTop = 90; });
  let combinations = 0;
  for (const width of [320, 390, 834, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const family of ['original', 'grove', 'dusk']) {
      for (const mode of ['light', 'dark']) {
        await page.evaluate(({ family, mode }) => { setFamily(family); setTheme(mode); }, { family, mode });
        await expect(scroll).toHaveJSProperty('scrollTop', 90);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}/${family}/${mode}`);
        const heights = await page.locator('#controls-range,#controls-size,#controls-select').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
        assert.ok(heights.every(height => height >= 44));
        combinations++;
      }
    }
  }
  await page.evaluate(() => { setFamily('original'); setTheme('light'); });
  if (output) await page.locator('#control-details').screenshot({ path: join(output, 'controls-desktop.png') });
  await page.locator('#family-select').click();
  await page.getByRole('option', { name: '苔原', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-family', 'grove');
  await page.locator('#prefs-nav [data-route=notifications]').click();
  await page.locator('#prefs-pane [data-route="notifications/email"]').click();
  await page.locator('#prefs-frequency').click();
  await page.getByRole('option', { name: '即时', exact: true }).click();
  await expect(page.locator('[data-save-status=frequency]')).toContainText('已在本页保存');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { setFamily('dusk'); setTheme('dark'); });
  await select.click();
  if (output) await page.screenshot({ path: join(output, 'controls-picker-phone-dark.png') });
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log(`PASS: ${combinations} layouts, styled Chromium picker, keyboard selection/cancel/focus/disabled, range keyboard and precise input, scroll retention, existing theme and preference selects. Other engines and real devices remain pending.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
