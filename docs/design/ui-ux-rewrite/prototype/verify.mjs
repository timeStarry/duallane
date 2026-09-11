import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Serve only the local specimen. No product API, account, or database is involved.
const html = await readFile(new URL('./index.html', import.meta.url));
const server = createServer((request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  } else {
    response.writeHead(404);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  const unexpectedRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) {
      unexpectedRequests.push(request.url());
    }
  });
  await page.goto(origin);
  const tokens = JSON.parse(await readFile(new URL('./theme-tokens.json', import.meta.url), 'utf8'));
  const runtimeRegistry = await page.evaluate(() => THEME_REGISTRY);
  assert.equal(runtimeRegistry.schemaVersion, tokens.schemaVersion);
  assert.equal(runtimeRegistry.defaultTheme, tokens.defaultTheme);
  assert.deepEqual(runtimeRegistry.themes, tokens.themes, 'Runtime palette must match the checked-in tokens');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-tokens').click();
  const download = await downloadPromise;
  assert.deepEqual(JSON.parse(await readFile(await download.path(), 'utf8')), tokens, 'Downloaded contract must match the checked-in tokens');
  let contrastPairs = 0;
  for (const family of ['original', 'grove', 'dusk']) {
    await page.locator('#family-select').selectOption(family);
    for (const mode of ['light', 'dark']) {
      await page.evaluate(mode => setTheme(mode), mode);
      const pairs = await page.evaluate(() => {
        const t = getTokens();
        return [['text', 'surface'], ['muted', 'surface'], ['muted', 'soft'], ['shared', 'shared-soft'], ['direct', 'direct-soft'], ['on-shared', 'shared'], ['on-direct', 'direct'], ['success', 'success-soft'], ['warning', 'warning-soft'], ['danger', 'danger-soft']]
          .map(([fg, bg]) => ({ fg, bg, ratio: contrast(t[fg], t[bg]) }));
      });
      for (const pair of pairs) assert.ok(pair.ratio >= 4.5, JSON.stringify({ family, mode, ...pair }));
      contrastPairs += pairs.length;
    }
  }
  const toggle = page.getByRole('switch', { name: '会话内消息提示' });
  let combinations = 0;
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const family of ['original', 'grove', 'dusk']) {
      await page.locator('#family-select').selectOption(family);
      for (const mode of ['light', 'dark']) {
        await page.evaluate(mode => setTheme(mode), mode);
        for (const checked of [false, true]) {
          if ((await toggle.getAttribute('aria-checked')) !== String(checked)) await toggle.click();
          const geometry = await toggle.evaluate(button => {
            // Materialize computed pseudo-elements so the assertion checks rendered
            // geometry, including inherited browser padding, rather than CSS strings.
            const layers = ['::before', '::after'].map(pseudo => {
              const computed = getComputedStyle(button, pseudo);
              const layer = document.createElement('span');
              for (const property of computed) layer.style.setProperty(property, computed.getPropertyValue(property));
              return layer;
            });
            const hidePseudo = document.createElement('style');
            hidePseudo.textContent = '#notification-switch::before,#notification-switch::after{content:none}';
            document.head.append(hidePseudo);
            button.append(...layers);
            const rect = element => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            };
            const result = { control: rect(button), track: rect(layers[0]), thumb: rect(layers[1]) };
            layers.forEach(layer => layer.remove());
            hidePseudo.remove();
            return result;
          });
          const { control, track, thumb } = geometry;
          const context = JSON.stringify({ width, family, mode, checked, geometry });
          assert.ok(control.width >= 44 && control.height >= 44, `Touch target: ${context}`);
          assert.ok(Math.abs(track.x + track.width / 2 - control.x - control.width / 2) < 0.6, `Track centered: ${context}`);
          assert.ok(Math.abs(thumb.y + thumb.height / 2 - track.y - track.height / 2) < 0.6, `Thumb centered vertically: ${context}`);
          const endInset = checked ? track.x + track.width - thumb.x - thumb.width : thumb.x - track.x;
          assert.ok(Math.abs(endInset - (track.height - thumb.height) / 2) < 0.6, `Thumb end inset: ${context}`);
          assert.ok(thumb.x >= track.x && thumb.x + thumb.width <= track.x + track.width + 0.6, `Thumb contained: ${context}`);
          combinations++;
        }
      }
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Page overflow at ${width}`);
  }
  await toggle.focus();
  const initial = await toggle.getAttribute('aria-checked');
  await page.keyboard.press('Space');
  assert.notEqual(await toggle.getAttribute('aria-checked'), initial);
  await page.keyboard.press('Enter');
  assert.equal(await toggle.getAttribute('aria-checked'), initial);
  assert.equal(await toggle.evaluate(button => document.activeElement === button), true);
  assert.equal(await toggle.evaluate(button => getComputedStyle(button).outlineStyle), 'solid');
  await toggle.evaluate(button => { button.disabled = true; });
  await page.keyboard.press('Space');
  assert.equal(await toggle.getAttribute('aria-checked'), initial, 'Disabled switch must not toggle');
  await toggle.evaluate(button => { button.disabled = false; });
  await page.evaluate(() => setFamily('unknown-theme'));
  assert.equal(await page.locator('html').getAttribute('data-family'), 'original');
  await page.evaluate(() => setTheme('system'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  const links = await page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href')));
  for (const href of new Set(links)) {
    if (/^(https?:|mailto:|data:)/.test(href)) continue;
    if (href.startsWith('#')) {
      assert.ok(await page.evaluate(id => Boolean(document.getElementById(id)), href.slice(1)), `Missing anchor: ${href}`);
    } else {
      await readFile(new URL(href.split('#')[0], new URL('./index.html', import.meta.url)));
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  if (process.env.DESIGN_SCREENSHOT_DIR) {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(process.env.DESIGN_SCREENSHOT_DIR, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#family-select').selectOption('original');
      await page.evaluate(() => setTheme('light'));
      await toggle.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(process.env.DESIGN_SCREENSHOT_DIR, `switch-${width}.png`) });
    }
    for (const checked of [false, true]) {
      if ((await toggle.getAttribute('aria-checked')) !== String(checked)) await toggle.click();
      await toggle.evaluate(button => button.blur());
      await page.locator('.switch-row').screenshot({ path: join(process.env.DESIGN_SCREENSHOT_DIR, `switch-${checked ? 'on' : 'off'}.png`) });
    }
  }
  console.log(`PASS: ${combinations} switch geometry cases; ${contrastPairs} contrast pairs; token/export parity; theme fallback/system mode; keyboard/focus/disabled; local links; no overflow, page errors, or external requests.`);
  console.log(`Specimen: ${fileURLToPath(new URL('./index.html', import.meta.url))}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
