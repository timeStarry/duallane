import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const html = await readFile(new URL('./index.html', import.meta.url));
const tokens = JSON.parse(await readFile(new URL('./theme-tokens.json', import.meta.url), 'utf8'));
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
  await page.goto(origin + '/#selection-patterns');
  for (const orientation of ['side', 'bottom']) {
    const sample = page.locator(`[data-selection-example=${orientation}]`);
    const tabs = sample.getByRole('tab');
    await tabs.first().focus();
    await page.keyboard.press(orientation === 'side' ? 'ArrowDown' : 'ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(sample.getByRole('tabpanel')).toHaveCount(1);
    await page.keyboard.press('End'); await expect(tabs.last()).toBeFocused();
    await page.keyboard.press('Home'); await expect(tabs.first()).toBeFocused();
    await page.keyboard.press('Tab'); await expect(sample.getByRole('tabpanel')).toBeFocused();
    await tabs.last().click(); await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
    await tabs.first().click();
  }
  // Measure rendered pseudo-elements: the strip must stay outside the rounded surface.
  async function checkGeometry(locator, orientation) {
    const geometry = await locator.evaluate((element, axis) => {
      const surface = getComputedStyle(element, '::before'), strip = getComputedStyle(element, '::after');
      const base = getComputedStyle(element), bounds = element.getBoundingClientRect();
      return {
        thickness: parseFloat(axis === 'side' ? strip.width : strip.height),
        gap: axis === 'side' ? parseFloat(surface.left) - parseFloat(strip.left) - parseFloat(strip.width) : parseFloat(surface.bottom) - parseFloat(strip.bottom) - parseFloat(strip.height),
        start: parseFloat(axis === 'side' ? strip.top : strip.left),
        end: parseFloat(axis === 'side' ? strip.bottom : strip.right),
        radius: parseFloat(surface.borderRadius), opacity: strip.opacity, shadow: base.boxShadow,
        width: bounds.width, height: bounds.height, transition: strip.transitionDuration
      };
    }, orientation);
    assert.equal(geometry.thickness, tokens.selection.indicatorThickness);
    assert.equal(geometry.gap, tokens.selection.indicatorGap);
    assert.equal(geometry.start, tokens.selection.endInset);
    assert.equal(geometry.end, tokens.selection.endInset);
    assert.equal(geometry.radius, tokens.selection.radius);
    assert.equal(geometry.opacity, '1'); assert.equal(geometry.shadow, 'none');
    assert.ok(geometry.width >= 44 && geometry.height >= 44);
    assert.equal(geometry.transition, '0s');
  }
  let combinations = 0;
  for (const width of [320, 390, 834, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const family of ['original', 'grove', 'dusk']) {
      for (const mode of ['light', 'dark']) {
        await page.evaluate(({ family, mode }) => { setFamily(family); setTheme(mode); }, { family, mode });
        await checkGeometry(page.locator('.selection-side [aria-selected=true]'), 'side');
        await checkGeometry(page.locator('.selection-bottom [aria-selected=true]'), 'bottom');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow: ${width}/${family}/${mode}`);
        for (const side of ['side', 'bottom']) {
          assert.ok(await page.locator(`.selection-${side}`).evaluate(element => element.scrollWidth <= element.clientWidth), `${side}/${width}/${family}/${mode}`);
        }
        combinations++;
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { setFamily('original'); setTheme('light'); });
  await page.locator('#selection-patterns').scrollIntoViewIfNeeded();
  if (output) await page.locator('#selection-patterns').screenshot({ path: join(output, 'selection-desktop.png') });
  await checkGeometry(page.locator('.sidebar nav a[aria-current]'), 'side');
  await page.locator('#prefs-nav [data-route=appearance]').click();
  await checkGeometry(page.locator('#prefs-nav [aria-current]'), 'side');
  await checkGeometry(page.locator('[data-pref-mode=light]'), 'bottom');
  if (output) await page.locator('#prefs-shell').screenshot({ path: join(output, 'selection-settings.png') });
  await checkGeometry(page.locator('.rail-nav [aria-pressed=true]'), 'bottom');
  await checkGeometry(page.locator('.conversation[aria-pressed=true]'), 'side');
  if (output) await page.locator('#app-viewport').screenshot({ path: join(output, 'selection-app.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#selection-patterns').scrollIntoViewIfNeeded();
  if (output) await page.locator('#selection-patterns').screenshot({ path: join(output, 'selection-phone.png') });
  await page.evaluate(() => { setFamily('dusk'); setTheme('dark'); });
  if (output) await page.locator('#selection-patterns').screenshot({ path: join(output, 'selection-phone-dark.png') });
  await page.emulateMedia({ forcedColors: 'active' });
  await checkGeometry(page.locator('.selection-side [aria-selected=true]'), 'side');
  assert.deepEqual(errors, []);
  console.log(`PASS: ${combinations} theme/width layouts, both tab orientations, keyboard/panels/focus, separate strip geometry, 44px targets, shared navigation/settings/conversation styles, reduced motion and forced colors.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
