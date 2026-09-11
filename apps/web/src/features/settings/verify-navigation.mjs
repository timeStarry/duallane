import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../../../package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));

// Only real frontend controllers are mounted here; no account or transport API is mocked as proof of server behavior.
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { useNavigationGuard } from '/src/shell/useNavigationGuard.tsx';
import { createProfileDraft } from '/src/features/settings/profile-draft.ts';
import { useMessageActions } from '/src/features/conversation/useMessageActions.ts';
import { ObjectActionMenu } from '/src/ui/primitives/index.ts';
const h = React.createElement;
const checks = window.checks = { calls: [], requests: 0 };
function GuardFixture() {
  const navigation = useNavigationGuard();
  const [profile] = useState(() => createProfileDraft('旧名字', nickname => {
    checks.requests += 1;
    return new Promise((resolve, reject) => {
      checks.resolve = () => resolve({ id: 'test-user', nickname, displayName: nickname || 'GitHub', kind: 'human', role: 'member', joinedAt: '' });
      checks.reject = () => reject(new Error('offline'));
    });
  }, () => {}, () => '保存失败'));
  const snapshot = useSyncExternalStore(profile.subscribe, profile.getSnapshot);
  const dirty = snapshot.draft.trim() !== snapshot.saved;
  useEffect(() => { navigation.register(dirty ? { message: '资料有修改', save: profile.save, discard: profile.discard } : null); return () => navigation.register(null); }, [dirty]);
  checks.blocked = navigation.isBlocked;
  checks.requestAnother = () => navigation.request(() => checks.calls.push('other'));
  checks.trusted = () => navigation.runConfirmed(() => {
    navigation.runConfirmed(() => navigation.request(() => checks.calls.push('nested')));
    navigation.request(() => checks.calls.push('outer'));
  });
  checks.trustedThrow = () => { try { navigation.runConfirmed(() => { throw new Error('expected'); }); } catch {} };
  return h('section', null,
    h('input', { 'aria-label': '昵称', value: snapshot.draft, onChange: event => profile.edit(event.target.value) }),
    h('button', { onClick: () => void profile.save() }, '页内保存'),
    h('button', { onClick: () => navigation.request(() => checks.calls.push('destination')) }, '离开资料'),
    h('output', { 'data-status': snapshot.status }, snapshot.status), navigation.confirmation);
}
function MessageFixture() {
  const [ids, setIds] = useState(['a', 'b']);
  const [scope, setScope] = useState('first');
  const list = useRef(null);
  const actions = useMessageActions(scope, ids, list);
  checks.removeMessage = id => setIds(current => current.filter(value => value !== id));
  checks.switchScope = () => { setScope('second'); setIds(['c']); };
  checks.messageId = actions.messageId;
  const present = ids.includes(actions.messageId);
  return h('section', { ref: list, tabIndex: 0, 'aria-label': '消息列表', style: { marginTop: 50 } },
    ...ids.map(id => h('article', { key: id, ...actions.bindMessage(id), 'data-message': id },
      h('span', null, '消息 ' + id),
      h('p', { 'data-native-context': true }, '原生可选择文本 ' + id),
      h('button', { onClick: event => actions.openFromTrigger(id, event.currentTarget) }, '更多 ' + id))),
    present ? h(ObjectActionMenu, { ...actions.menuProps, fallbackFocus: list.current, label: '消息操作', actions: [{ id: 'copy', label: '复制消息', onSelect: () => {} }] }) : null);
}
createRoot(document.getElementById('root')).render(h(React.Fragment, null, h(GuardFixture), h(MessageFixture)));
</script></body></html>`;

const server = await createServer({
  root, configFile: false, logLevel: "error", appType: "custom", cacheDir: "node_modules/.vite-navigation-verification",
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
  plugins: [{ name: "navigation-verification", configureServer(instance) {
    instance.middlewares.use("/__navigation_verification", async (_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(await instance.transformIndexHtml("/__navigation_verification", html));
    });
  } }]
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}/__navigation_verification`;
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  const fresh = async () => { await page.goto(origin); await expect(page.getByRole("textbox", { name: "昵称" })).toHaveValue("旧名字"); await page.getByRole("textbox", { name: "昵称" }).fill("新名字"); };

  await fresh();
  await page.getByRole("button", { name: "离开资料" }).click();
  await page.getByRole("button", { name: "保存并继续" }).click();
  await expect(page.getByRole("button", { name: "继续留在这里" })).toBeDisabled();
  await page.evaluate(() => window.checks.reject());
  await expect(page.getByRole("alert")).toContainText("尚未保存成功");
  await expect(page.getByRole("textbox", { name: "昵称" })).toHaveValue("新名字");
  assert.deepEqual(await page.evaluate(() => window.checks.calls), []);
  await page.getByRole("button", { name: "保存并继续" }).click();
  await page.evaluate(() => window.checks.resolve());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.checks.calls), ["destination"]);
  assert.equal(await page.evaluate(() => window.checks.requests), 2);

  await fresh();
  await page.getByRole("button", { name: "页内保存" }).click();
  await page.getByRole("button", { name: "离开资料" }).click();
  await page.getByRole("button", { name: "放弃修改并离开" }).click();
  await expect(page.getByRole("alert")).toContainText("操作尚未结束");
  assert.deepEqual(await page.evaluate(() => window.checks.calls), []);
  await page.evaluate(() => window.checks.resolve());
  await expect(page.locator("output")).toHaveAttribute("data-status", "saved");
  assert.equal(await page.evaluate(() => window.checks.blocked()), true);
  await page.evaluate(() => window.checks.requestAnother());
  assert.deepEqual(await page.evaluate(() => window.checks.calls), []);
  await page.getByRole("button", { name: "继续留在这里" }).click();
  assert.equal(await page.evaluate(() => window.checks.blocked()), false);
  await page.evaluate(() => window.checks.requestAnother());
  assert.deepEqual(await page.evaluate(() => window.checks.calls), ["other"]);

  await fresh();
  await page.evaluate(() => { window.checks.trusted(); window.checks.trustedThrow(); window.checks.requestAnother(); });
  assert.deepEqual(await page.evaluate(() => window.checks.calls), ["nested", "outer"]);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "继续留在这里" }).click();

  await page.getByRole("button", { name: "更多 a" }).click();
  await expect(page.getByRole("menuitem", { name: "复制消息" })).toBeFocused();
  await page.evaluate(() => window.checks.removeMessage("a"));
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "消息列表" })).toBeFocused();

  await page.getByRole("button", { name: "更多 b" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "更多 b" })).toBeFocused();
  const nativePrevented = await page.locator("[data-native-context]").evaluate(element => !element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  assert.equal(nativePrevented, false);
  await expect(page.getByRole("menu")).toHaveCount(0);

  await page.getByRole("button", { name: "更多 b" }).click();
  await page.evaluate(() => { document.querySelector('input').focus(); window.checks.switchScope(); });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "昵称" })).toBeFocused();
  assert.deepEqual(errors, []);
  console.log("Navigation verification passed: retry, pending PATCH discard, retained intent, confirmed bypass, removed-object focus, native context and scope change.");
} finally {
  await browser?.close();
  await server.close();
}
