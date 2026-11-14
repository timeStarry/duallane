import fs from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

// Minimal valid 1x1 PNG binary header + deterministic 18 KB payload (> 6144 chunk size => 3 encrypted chunks)
function buildTestPngBuffer(): Buffer {
  const basePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  const trailer = Buffer.alloc(18 * 1024, 0x5a);
  return Buffer.concat([basePng, trailer]);
}

async function assertNoOverflowOrControlOverlap(page: Page, viewportWidth: number, label: string) {
  const audit = await page.evaluate((vw) => {
    const scrollWidth = document.documentElement.scrollWidth;
    const interactive = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button, input:not([type="hidden"]), textarea, [role="switch"], [role="combobox"], [data-testid="p2p-peer-status"]'
      )
    ).filter((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    const outOfBounds: string[] = [];
    const rects = interactive.map((el) => {
      const r = el.getBoundingClientRect();
      const desc = `${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") || el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 20) || ""}]`;
      if (r.left < -1 || r.right > vw + 1) {
        outOfBounds.push(`${desc}: left=${r.left.toFixed(1)}, right=${r.right.toFixed(1)}`);
      }
      return { el, desc, r };
    });

    const overlaps: string[] = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        // Skip checking elements behind an open modal dialog backdrop
        const aDialog = a.el.closest('[role="dialog"]');
        const bDialog = b.el.closest('[role="dialog"]');
        if (aDialog !== bDialog) continue;

        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ix > 2 && iy > 2) {
          overlaps.push(`${a.desc} <-> ${b.desc} (${ix.toFixed(1)}x${iy.toFixed(1)})`);
        }
      }
    }

    return { scrollWidth, outOfBounds, overlaps, count: rects.length };
  }, viewportWidth);

  expect(audit.scrollWidth, `${label}: horizontal scrollWidth must <= ${viewportWidth}`).toBeLessThanOrEqual(
    viewportWidth
  );
  expect(audit.outOfBounds, `${label}: controls clipped outside viewport`).toEqual([]);
  expect(audit.overlaps, `${label}: overlapping interactive controls`).toEqual([]);
  expect(audit.count).toBeGreaterThan(0);
}

async function assertAccessibleNamesAndContrast(page: Page, modeLabel: string) {
  const result = await page.evaluate(() => {
    const unlabeled: string[] = [];
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button, input:not([type="hidden"]), textarea, [role="switch"], [role="combobox"]'
      )
    );
    for (const el of controls) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const ariaLabel = (el.getAttribute("aria-label") || "").trim();
      const labelledBy = el.getAttribute("aria-labelledby");
      const labelledText = labelledBy
        ? (document.getElementById(labelledBy)?.textContent || "").trim()
        : "";
      const text = (el.textContent || "").trim();
      const placeholder = (el.getAttribute("placeholder") || "").trim();
      const id = el.getAttribute("id");
      const labelTag = id
        ? (document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || "").trim()
        : (el.closest("label")?.textContent || "").trim();

      if (!ariaLabel && !labelledText && !text && !labelTag && !placeholder) {
        unlabeled.push(el.outerHTML.slice(0, 120));
      }
    }

    // Parse computed RGB/RGBA and walk ancestors to resolve effective opaque background for WCAG AA contrast check
    function parseRgba(str: string): [number, number, number, number] | null {
      const m = str.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
      if (parts.length < 3) return null;
      return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
    }

    function blend(fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] {
      const a = fg[3];
      return [
        fg[0] * a + bg[0] * (1 - a),
        fg[1] * a + bg[1] * (1 - a),
        fg[2] * a + bg[2] * (1 - a),
      ];
    }

    function relLum([r, g, b]: [number, number, number]): number {
      const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    }

    function resolveBg(el: HTMLElement | null): [number, number, number] {
      const layers: Array<[number, number, number, number]> = [];
      let cur = el;
      while (cur) {
        const parsed = parseRgba(window.getComputedStyle(cur).backgroundColor);
        if (parsed && parsed[3] > 0) {
          layers.unshift(parsed);
          if (parsed[3] >= 0.99) break;
        }
        cur = cur.parentElement;
      }
      const rootDark = document.documentElement.dataset.themeMode === "dark";
      let base: [number, number, number] = rootDark ? [14, 17, 23] : [248, 250, 252];
      for (const layer of layers) {
        base = blend(layer, base);
      }
      return base;
    }

    const lowContrast: string[] = [];
    const textTargets = Array.from(document.querySelectorAll<HTMLElement>("h1, h2, p, [data-testid='p2p-peer-status']"));
    for (const el of textTargets) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.9) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const txt = (el.textContent || "").trim();
      if (!txt) continue;
      const fgRaw = parseRgba(style.color);
      if (!fgRaw) continue;
      const bg = resolveBg(el);
      const fg = blend(fgRaw, bg);
      const l1 = relLum(fg);
      const l2 = relLum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (ratio < 4.5) {
        lowContrast.push(`${txt.slice(0, 24)} ratio=${ratio.toFixed(2)}`);
      }
    }

    const landmarks = {
      hasRegionOrNav:
        document.querySelectorAll("nav, aside, main, section[aria-label], [role='dialog']").length > 0,
    };

    return { unlabeled, lowContrast, landmarks };
  });

  expect(result.unlabeled, `${modeLabel}: unlabeled interactive controls`).toEqual([]);
  expect(result.lowContrast, `${modeLabel}: WCAG AA contrast violations (< 4.5:1)`).toEqual([]);
  expect(result.landmarks.hasRegionOrNav).toBe(true);
}

test.describe("DualLane v1.0 P2P Direct Lane, File Transfer, 320px Responsive, Accessibility & Security Acceptance", () => {
  test("delivers E2EE P2P text + multi-chunk encrypted RAM files across two browsers with zero network/storage secret leakage and SVG XSS isolation", async ({
    browser,
    baseURL,
  }) => {
    const contextA = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
    });
    const contextB = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
    });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const pageErrorsA: string[] = [];
    const pageErrorsB: string[] = [];
    const networkTranscript: string[] = [];
    const wsFramesTranscript: string[] = [];

    const attachAuditors = (page: Page) => {
      page.on("request", (req) => {
        networkTranscript.push(req.url());
        networkTranscript.push(JSON.stringify(req.headers()));
        const post = req.postData();
        if (post) networkTranscript.push(post);
      });
      page.on("websocket", (ws) => {
        networkTranscript.push(ws.url());
        ws.on("framesent", (ev) => wsFramesTranscript.push(String(ev.payload)));
        ws.on("framereceived", (ev) => wsFramesTranscript.push(String(ev.payload)));
      });
    };

    attachAuditors(pageA);
    attachAuditors(pageB);
    pageA.on("pageerror", (err) => pageErrorsA.push(err.message));
    pageB.on("pageerror", (err) => pageErrorsB.push(err.message));

    try {
      // 1. Open landing screen on Browser A (only Go P2P backend is running; Workspace backend is absent)
      await pageA.goto(`${baseURL}/`);
      await expect(pageA.getByRole("button", { name: "使用 GitHub 登录共享空间" })).toBeVisible();

      // Clicking GitHub sign-in when Workspace backend is unavailable MUST NOT navigate to a raw HTTP 500 screen
      await pageA.getByRole("button", { name: "使用 GitHub 登录共享空间" }).click();
      await expect(pageA.getByRole("button", { name: "免登录进入私密直连通道" })).toBeVisible();

      // 2. Enter P2P Direct Lane & create remote E2EE room on Go P2P backend
      await pageA.getByRole("button", { name: "免登录进入私密直连通道" }).click();
      await expect(pageA).toHaveURL(/\/direct\/[A-Za-z0-9_-]+#k=[A-Za-z0-9_-]+/);

      const shareUrl = pageA.url();
      const keySecret = new URL(shareUrl).hash.replace(/^#k=/, "");
      expect(keySecret.length).toBeGreaterThanOrEqual(40);

      const peerStatusA = pageA.getByTestId("p2p-peer-status");
      await expect(peerStatusA).toContainText("等待对端加入 · 仅本机在线 1/2");

      // 3. Send a queued text message while alone
      const secretText = "机密验收密文：第一条待发加密消息-994827";
      await pageA.getByLabel("发送端到端加密消息").fill(secretText);
      await pageA.getByRole("button", { name: "暂存待发" }).click();

      const firstBubbleA = pageA.locator("[data-p2p-message-id]").first();
      await expect(firstBubbleA).toHaveAttribute("data-delivery-status", "queued");
      await expect(firstBubbleA).toContainText("等待对端加入");
      await expect(firstBubbleA).not.toContainText("对端已收");

      // 4. Verify CommandSearchModal & SettingsModal centering
      await pageA.getByRole("button", { name: "全局搜索" }).click();
      const searchDialog = pageA.getByRole("dialog", { name: /全局搜索/ });
      await expect(searchDialog).toBeVisible();
      await searchDialog.getByPlaceholder("输入关键词、文件名或指令…").fill("第一条待发加密消息");
      await expect(searchDialog).toContainText(secretText);
      await pageA.keyboard.press("Escape");
      await expect(searchDialog).toBeHidden();

      // Verify Guest Personal Settings & User Menu do NOT expose empty ID/Role or Logout buttons
      await pageA.getByRole("button", { name: "设置中心" }).click();
      const guestSettingsDialog = pageA.getByRole("dialog", { name: "DualLane 设置中心" });
      await expect(guestSettingsDialog).toBeVisible();
      await expect(guestSettingsDialog.getByRole("button", { name: "设备" })).toHaveCount(0);
      await expect(guestSettingsDialog.getByRole("button", { name: "扫码" })).toHaveCount(0);
      await expect(guestSettingsDialog.getByRole("button", { name: "机器人" })).toHaveCount(0);

      await guestSettingsDialog.getByRole("button", { name: "个人" }).click();
      await expect(guestSettingsDialog).toContainText("免登录访客");
      await expect(guestSettingsDialog.getByRole("button", { name: "前往登录共享空间" })).toBeVisible();
      await expect(guestSettingsDialog).not.toContainText("ID:");
      await expect(guestSettingsDialog).not.toContainText("角色:");
      await expect(guestSettingsDialog.getByRole("button", { name: "退出登录" })).toHaveCount(0);
      await pageA.keyboard.press("Escape");
      await expect(guestSettingsDialog).toBeHidden();

      await pageA.getByRole("button", { name: "个人菜单" }).click();
      await expect(pageA.getByText("私密直连模式")).toBeVisible();
      await expect(pageA.getByRole("button", { name: "退出当前账号" })).toHaveCount(0);
      await pageA.keyboard.press("Escape");

      // 5. Browser B joins via encrypted #k= share link
      await pageB.goto(shareUrl);
      const peerStatusB = pageB.getByTestId("p2p-peer-status");
      await expect(peerStatusA).toContainText("对端已连接 · 2/2 在线");
      await expect(peerStatusB).toContainText("对端已连接 · 2/2 在线");

      // Queued message flushes automatically and gets encrypted ACK ("对端已收")
      await expect(pageB.locator("[data-p2p-message-id]").first()).toContainText(secretText);
      await expect(firstBubbleA).toHaveAttribute("data-delivery-status", "delivered");
      await expect(firstBubbleA).toContainText("对端已收");

      // 6. Multi-chunk E2EE RAM File Transfer (18 KB PNG > 6144 chunk limit => 3 encrypted chunks)
      const pngBuffer = buildTestPngBuffer();
      const secretFileName = "secret-blueprint-v1.png";
      await pageA.locator('input[type="file"]').setInputFiles({
        name: secretFileName,
        mimeType: "image/png",
        buffer: pngBuffer,
      });

      // Browser A gets ACK "对端已收" for the encrypted file transfer!
      const fileBubbleA = pageA.locator("[data-p2p-message-id]").nth(1);
      await expect(fileBubbleA).toContainText(secretFileName);
      await expect(fileBubbleA).toHaveAttribute("data-delivery-status", "delivered", {
        timeout: 10000,
      });

      // Browser B renders inline PNG preview AND downloads byte-for-byte identical file!
      const fileBubbleB = pageB.locator("[data-p2p-message-id]").nth(1);
      await expect(fileBubbleB).toContainText(secretFileName);
      await expect(fileBubbleB.getByRole("button", { name: `预览图片 ${secretFileName}` })).toBeVisible();

      // Open MediaLightbox on Browser B & close via Escape
      await fileBubbleB.getByRole("button", { name: `预览图片 ${secretFileName}` }).click();
      const lightbox = pageB.getByRole("dialog", { name: secretFileName });
      await expect(lightbox).toBeVisible();
      await pageB.keyboard.press("Escape");
      await expect(lightbox).toBeHidden();

      const downloadPromise = pageB.waitForEvent("download");
      await fileBubbleB.getByRole("button", { name: `下载 ${secretFileName}` }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(secretFileName);
      const dlPath = await download.path();
      expect(dlPath).toBeTruthy();
      const downloadedBytes = await fs.readFile(dlPath!);
      expect(Buffer.compare(downloadedBytes, pngBuffer)).toBe(0);

      // 7. SVG XSS Defense: Browser B sends an SVG file ("image/svg+xml") -> Browser A MUST NOT render inline <img>, forces safe download card
      const svgPayload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=1"></svg>', "utf8");
      await pageB.locator('input[type="file"]').setInputFiles({
        name: "untrusted-vector.svg",
        mimeType: "image/svg+xml",
        buffer: svgPayload,
      });

      const svgBubbleA = pageA.locator("[data-p2p-message-id]").nth(2);
      await expect(svgBubbleA).toContainText("untrusted-vector.svg");
      await expect(svgBubbleA.locator("img")).toHaveCount(0);

      // 8. Security & Zero-Persistence Audit:
      // #k= secret, plaintext message, and secret filename MUST NEVER appear in any HTTP URL/header/body or plaintext WS frame!
      const combinedNetwork = networkTranscript.join("\n");
      const combinedWs = wsFramesTranscript.join("\n");
      expect(combinedNetwork).not.toContain(keySecret);
      expect(combinedNetwork).not.toContain(secretText);
      expect(combinedNetwork).not.toContain(secretFileName);
      expect(combinedWs).not.toContain(keySecret);
      expect(combinedWs).not.toContain(secretText);
      expect(combinedWs).not.toContain(secretFileName);

      // Verify localStorage / sessionStorage / IndexedDB contain zero P2P secrets or plaintext
      for (const page of [pageA, pageB]) {
        const storageDump = await page.evaluate(async () => {
          const ls = JSON.stringify(localStorage);
          const ss = JSON.stringify(sessionStorage);
          const dbs = "databases" in indexedDB ? await indexedDB.databases() : [];
          return { ls, ss, dbCount: dbs.length };
        });
        expect(storageDump.ls).not.toContain(keySecret);
        expect(storageDump.ls).not.toContain(secretText);
        expect(storageDump.ss).not.toContain(keySecret);
        expect(storageDump.ss).not.toContain(secretText);
        expect(storageDump.dbCount).toBe(0);
      }

      // 9. Browser B disconnects -> Browser A immediately reflects peer departure
      await pageB.close();
      await expect(peerStatusA).toContainText("等待对端加入 · 仅本机在线 1/2");

      expect(pageErrorsA).toEqual([]);
      expect(pageErrorsB).toEqual([]);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("passes 320px ultra-narrow layout overlap/clipping audit, scrubs URL/key on returning to list or leaving room, rejects invalid #k= before WS connect, and satisfies Light/Dark WCAG AA accessibility", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    const openedWsUrls: string[] = [];

    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("websocket", (ws) => {
      if (ws.url().includes("/ws/p2p")) {
        openedWsUrls.push(ws.url());
      }
    });

    try {
      // 1. OAuth error callback (?error=access_denied) shows friendly banner, scrubs query param, fits 320px cleanly
      await page.goto(`${baseURL}/?error=access_denied`);
      await expect(page.getByText(/GitHub 授权已取消/)).toBeVisible();
      expect(new URL(page.url()).search).toBe("");
      await assertNoOverflowOrControlOverlap(page, 320, "320px Landing Screen");
      await assertAccessibleNamesAndContrast(page, "Landing Light Mode");

      // 2. Invalid #k= fragment (/direct/BadRoom99#k=invalid!bad!) MUST NOT open any WS connection AND MUST scrub URL!
      openedWsUrls.length = 0;
      await page.goto(`${baseURL}/direct/BadRoom99#k=invalid!bad!`);
      await expect(page.getByText(/无效的 Base64URL 端到端加密密钥编码/).first()).toBeVisible();
      expect(openedWsUrls).toEqual([]);
      expect(page.url()).not.toContain("/direct/");
      expect(new URL(page.url()).pathname).toBe("/direct");
      expect(new URL(page.url()).hash).toBe("");
      await assertNoOverflowOrControlOverlap(page, 320, "320px Invalid Key Error State");

      // 3. Create a valid P2P room at 320x568 viewport
      await page.getByRole("button", { name: "重新创建加密房间" }).click();
      await expect(page).toHaveURL(/\/direct\/[A-Za-z0-9_-]+#k=[A-Za-z0-9_-]+/);
      await expect(page.getByTestId("p2p-peer-status")).toContainText("等待对端加入 · 仅本机在线 1/2");

      // Audit 320px P2P Chat empty room state
      await assertNoOverflowOrControlOverlap(page, 320, "320px P2P Chat Empty Room");

      // Send a message + file at 320px and re-audit P2P Chat populated state!
      await page.getByLabel("发送端到端加密消息").fill("320px 极窄视口控件不重叠不裁切验证");
      await page.getByRole("button", { name: "暂存待发" }).click();
      await expect(page.locator("[data-p2p-message-id]").first()).toBeVisible();

      await page.locator('input[type="file"]').setInputFiles({
        name: "narrow-test-report-2026.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("320px file card test", "utf8"),
      });
      await expect(page.locator("[data-p2p-message-id]").nth(1)).toContainText(
        "narrow-test-report-2026.txt"
      );

      await assertNoOverflowOrControlOverlap(page, 320, "320px P2P Chat With Bubbles & File Card");
      await assertAccessibleNamesAndContrast(page, "320px P2P Chat Light Mode");

      // 4. Defect #2 Regression Gate: Click "返回列表" -> URL MUST scrub both /direct/<roomId> AND #k=<key> while keeping /direct!
      await page.getByRole("button", { name: "返回列表" }).click();
      await expect(page.getByRole("heading", { name: "私密直连", exact: true })).toBeVisible();
      expect(page.url()).not.toContain("/direct/");
      expect(page.url()).not.toContain("#k=");
      expect(new URL(page.url()).pathname).toBe("/direct");
      expect(new URL(page.url()).hash).toBe("");

      // Audit 320px P2P List view (with bottom PrimaryRail + active room session card)
      await assertNoOverflowOrControlOverlap(page, 320, "320px P2P Sidebar List + Bottom Rail");
      await assertAccessibleNamesAndContrast(page, "320px P2P List Light Mode");

      // 5. Open Search Modal & Settings Modal at 320px -> verify inside 320px bounds + Dark Mode WCAG AA contrast
      await page.getByRole("button", { name: "全局搜索" }).click();
      const searchDialog = page.getByRole("dialog", { name: /全局搜索/ });
      await expect(searchDialog).toBeVisible();
      await assertNoOverflowOrControlOverlap(page, 320, "320px Search Modal");
      await page.keyboard.press("Escape");
      await expect(searchDialog).toBeHidden();

      await page.getByRole("button", { name: "设置中心" }).click();
      const settingsDialog = page.getByRole("dialog", { name: "DualLane 设置中心" });
      await expect(settingsDialog).toBeVisible();
      await assertNoOverflowOrControlOverlap(page, 320, "320px Settings Modal (Light)");

      // Switch to Dark Mode inside 320px Settings Modal and verify WCAG AA contrast & zero overlap!
      await settingsDialog.getByRole("radio", { name: "深色" }).click();
      await assertNoOverflowOrControlOverlap(page, 320, "320px Settings Modal (Dark)");
      await assertAccessibleNamesAndContrast(page, "320px Settings Dark Mode");
      await page.keyboard.press("Escape");
      await expect(settingsDialog).toBeHidden();

      // Verify Dark Mode contrast on P2P List as well
      await assertAccessibleNamesAndContrast(page, "320px P2P List Dark Mode");

      // 6. Re-enter active P2P room from session card, then click "退出直连房间" -> URL remains scrubbed & room destroyed
      await page.getByRole("button", { name: /房间 #/ }).click();
      await expect(page.getByTestId("p2p-peer-status")).toBeVisible();
      await assertAccessibleNamesAndContrast(page, "320px P2P Chat Dark Mode");

      await page.getByRole("button", { name: "退出直连房间" }).click();
      expect(page.url()).not.toContain("/direct/");
      expect(page.url()).not.toContain("#k=");
      await expect(page.getByRole("button", { name: /房间 #/ })).toHaveCount(0);

      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
