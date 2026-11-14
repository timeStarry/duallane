import fs from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

function buildWorkspacePngBuffer(): Buffer {
  const basePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  const payload = Buffer.from("DUALLANE-WORKSPACE-PNG-PAYLOAD-2026", "utf8");
  return Buffer.concat([basePng, payload]);
}

async function assertWorkspaceNoOverlapAtWidth(
  page: Page,
  viewportWidth: number,
  label: string
) {
  const audit = await page.evaluate((vw) => {
    const scrollWidth = document.documentElement.scrollWidth;
    function getClippedRect(el: HTMLElement) {
      const raw = el.getBoundingClientRect();
      let left = raw.left;
      let top = raw.top;
      let right = raw.right;
      let bottom = raw.bottom;
      let parent = el.parentElement;
      while (parent && parent !== document.documentElement) {
        const ps = window.getComputedStyle(parent);
        if (ps.overflowX !== "visible" || ps.overflowY !== "visible") {
          const pr = parent.getBoundingClientRect();
          if (ps.overflowX !== "visible") {
            left = Math.max(left, pr.left);
            right = Math.min(right, pr.right);
          }
          if (ps.overflowY !== "visible") {
            top = Math.max(top, pr.top);
            bottom = Math.min(bottom, pr.bottom);
          }
        }
        parent = parent.parentElement;
      }
      return {
        raw,
        left,
        top,
        right,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
    }

    const interactive = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button, input:not([type="hidden"]), textarea, [role="switch"], [role="combobox"]'
      )
    ).filter((el) => {
      let cur: HTMLElement | null = el;
      while (cur) {
        const s = window.getComputedStyle(cur);
        if (
          s.display === "none" ||
          s.visibility === "hidden" ||
          Number(s.opacity) === 0 ||
          s.pointerEvents === "none"
        ) {
          return false;
        }
        cur = cur.parentElement;
      }
      const r = getClippedRect(el);
      return r.width > 0 && r.height > 0;
    });

    const outOfBounds: string[] = [];
    const rects = interactive.map((el) => {
      const r = getClippedRect(el);
      const desc = `${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 18) || ""}]`;
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
        const aLayer = a.el.closest('[role="dialog"], [data-inspector-drawer="true"]');
        const bLayer = b.el.closest('[role="dialog"], [data-inspector-drawer="true"]');
        if (aLayer !== bLayer) continue;
        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ix > 2 && iy > 2) {
          overlaps.push(`${a.desc} <-> ${b.desc} (${ix.toFixed(1)}x${iy.toFixed(1)})`);
        }
      }
    }

    return { scrollWidth, outOfBounds, overlaps };
  }, viewportWidth);

  expect(audit.scrollWidth, `${label}: scrollWidth <= ${viewportWidth}`).toBeLessThanOrEqual(
    viewportWidth
  );
  expect(audit.outOfBounds, `${label}: out-of-bounds controls`).toEqual([]);
  expect(audit.overlaps, `${label}: overlapping controls`).toEqual([]);
}

async function assertNarrowWorkspaceNoOverlap(page: Page, label: string) {
  return assertWorkspaceNoOverlapAtWidth(page, 320, label);
}

test.describe("DualLane v1.0 Shared Workspace Login, Search, File Transfer & 320px Responsive Acceptance", () => {
  test("logs into Shared Workspace, onboards peer, exchanges real-time messages & binary/image attachments, downloads byte-for-byte files, searches filenames, and fits 320px cleanly", async ({
    browser,
    baseURL,
  }) => {
    const contextOwner = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
    });
    const contextMember = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
    });
    const pageOwner = await contextOwner.newPage();
    const pageMember = await contextMember.newPage();

    const ownerErrors: string[] = [];
    const memberErrors: string[] = [];
    pageOwner.on("pageerror", (err) => ownerErrors.push(err.message));
    pageMember.on("pageerror", (err) => memberErrors.push(err.message));

    try {
      // 1. Home Portal shows Two Grand Directional Hero Cards; Owner signs in via GitHub OAuth flow
      await pageOwner.goto(`${baseURL}/`);
      await expect(pageOwner.getByTestId("home-card-workspace")).toBeVisible();
      await expect(pageOwner.getByTestId("home-card-direct")).toBeVisible();
      await assertWorkspaceNoOverlapAtWidth(pageOwner, 1280, "1280px Grand Two-Direction Home Portal");
      await expect(pageOwner.getByRole("button", { name: "使用 GitHub 登录共享空间" })).toBeVisible();
      await pageOwner.getByRole("button", { name: "使用 GitHub 登录共享空间" }).click();

      await expect(pageOwner.getByRole("heading", { name: "共享空间" })).toBeVisible();
      await expect(pageOwner.getByRole("button", { name: /我的收藏/ }).first()).toBeVisible();

      // 2. Owner generates a Workspace Invite Code
      await pageOwner.getByRole("button", { name: "设置中心" }).click();
      const settingsDialog = pageOwner.getByRole("dialog", { name: "DualLane 设置中心" });
      await expect(settingsDialog).toBeVisible();

      await settingsDialog.getByRole("button", { name: "个人" }).click();
      await settingsDialog.getByRole("button", { name: "生成邀请码" }).click();

      const inviteCodeEl = settingsDialog.getByTestId("generated-invite-code");
      await expect(inviteCodeEl).toBeVisible();
      const inviteCode = (await inviteCodeEl.textContent())?.trim() || "";
      expect(inviteCode.length).toBeGreaterThan(4);

      await pageOwner.keyboard.press("Escape");
      await expect(settingsDialog).toBeHidden();

      // 3. Member B joins Shared Workspace via invite code
      await pageMember.goto(`${baseURL}/?invite=${encodeURIComponent(inviteCode)}`);
      await pageMember
        .getByPlaceholder("可选：测试成员昵称（双窗口联调推荐使用）")
        .fill("协作成员晓明");
      await pageMember
        .getByRole("button", { name: "通过邀请码直接加入（开发环境快捷入口）" })
        .click();

      await expect(pageMember.getByRole("heading", { name: "共享空间" })).toBeVisible();

      // 4. Owner creates a group conversation including Member B
      await pageOwner.getByRole("button", { name: "新建群组" }).click();
      const createGroupDialog = pageOwner.getByRole("dialog", { name: "新建群组对话" });
      await expect(createGroupDialog).toBeVisible();
      await createGroupDialog
        .getByPlaceholder("群组名称，例如：产品设计与架构")
        .fill("v1.0 双端实时验收群");
      await createGroupDialog.getByRole("button", { name: /协作成员晓明/ }).click();
      await createGroupDialog.getByRole("button", { name: "创建群组" }).click();
      await expect(createGroupDialog).toBeHidden();

      await pageOwner.getByRole("button", { name: /v1\.0 双端实时验收群/ }).click();

      // Member B sees the newly created group immediately; creation system notice MUST NOT inflate unread badge!
      const memberGroupBtn = pageMember.getByRole("button", { name: /v1\.0 双端实时验收群/ });
      await expect(memberGroupBtn).toBeVisible();
      await expect(memberGroupBtn.getByTestId("unread-badge")).toHaveCount(0);

      // 5. Bidirectional real-time text delivery + accurate unread badge count (1 chat msg + 1 system msg => badge 1, NOT 3!)
      const ownerComposer = pageOwner.getByPlaceholder("发送消息到 v1.0 双端实时验收群…");
      await ownerComposer.fill("共享空间双端实时送达验收通过 2026");
      await ownerComposer.press("Enter");

      await expect(memberGroupBtn.getByTestId("unread-badge")).toHaveText("1");
      await memberGroupBtn.click();
      await expect(memberGroupBtn.getByTestId("unread-badge")).toHaveCount(0);

      await expect(
        pageMember.locator("section").getByText("共享空间双端实时送达验收通过 2026")
      ).toBeVisible();

      const memberComposer = pageMember.getByPlaceholder("发送消息到 v1.0 双端实时验收群…");
      await memberComposer.fill("晓明已实时收到，正在验证全文检索与文件传输！");
      await memberComposer.press("Enter");

      await expect(
        pageOwner.locator("section").getByText("晓明已实时收到，正在验证全文检索与文件传输！")
      ).toBeVisible();

      // 6. End-to-End Shared Workspace File Upload (PNG image + PDF document, attachment-only send!)
      const pngBytes = buildWorkspacePngBuffer();
      const pdfBytes = Buffer.from("%PDF-1.7\nDualLane v1.0 Architecture Signoff Spec\n%%EOF", "utf8");

      await pageOwner.locator('input[type="file"]').setInputFiles([
        {
          name: "architecture-diagram.png",
          mimeType: "image/png",
          buffer: pngBytes,
        },
        {
          name: "release-checklist.pdf",
          mimeType: "application/pdf",
          buffer: pdfBytes,
        },
      ]);

      await expect(pageOwner.getByTestId("pending-attachment-chip")).toHaveCount(2);
      await pageOwner.getByRole("button", { name: "发送" }).click();
      await expect(pageOwner.getByTestId("pending-attachment-chip")).toHaveCount(0);

      // Member B receives both attachments in real time over /ws/workspace!
      await expect(
        pageMember.getByRole("button", { name: "预览图片 architecture-diagram.png" })
      ).toBeVisible();
      await expect(
        pageMember.getByRole("button", { name: "查看附件 release-checklist.pdf" })
      ).toBeVisible();

      // Member B previews PNG in MediaLightbox and downloads exact bytes
      await pageMember.getByRole("button", { name: "预览图片 architecture-diagram.png" }).click();
      const lightbox = pageMember.getByRole("dialog", { name: "architecture-diagram.png" });
      await expect(lightbox).toBeVisible();

      const dlPngPromise = pageMember.waitForEvent("download");
      await lightbox.getByRole("button", { name: "下载文件" }).click();
      const dlPng = await dlPngPromise;
      expect(dlPng.suggestedFilename()).toBe("architecture-diagram.png");
      const dlPngBytes = await fs.readFile((await dlPng.path())!);
      expect(Buffer.compare(dlPngBytes, pngBytes)).toBe(0);

      await pageMember.keyboard.press("Escape");
      await expect(lightbox).toBeHidden();

      // Member B opens PDF in File InspectorPane and downloads exact bytes
      await pageMember.getByRole("button", { name: "查看附件 release-checklist.pdf" }).click();
      const dlPdfPromise = pageMember.waitForEvent("download");
      await pageMember.getByRole("button", { name: "下载文件" }).click();
      const dlPdf = await dlPdfPromise;
      expect(dlPdf.suggestedFilename()).toBe("release-checklist.pdf");
      const dlPdfBytes = await fs.readFile((await dlPdf.path())!);
      expect(Buffer.compare(dlPdfBytes, pdfBytes)).toBe(0);

      // 7. Global Search (⌘K) searches both message text AND uploaded filenames!
      await pageOwner.getByRole("button", { name: /我的收藏/ }).first().click();
      await pageOwner.getByRole("button", { name: "全局搜索" }).click();
      const searchDialog = pageOwner.getByRole("dialog", { name: /全局搜索/ });
      await expect(searchDialog).toBeVisible();

      await searchDialog.getByPlaceholder("输入关键词、文件名或指令…").fill("release-checklist");
      await expect(searchDialog).toContainText("文件与媒体");
      const fileHitBtn = searchDialog.getByRole("button", { name: /release-checklist\.pdf/ });
      await expect(fileHitBtn).toBeEnabled();
      await expect(fileHitBtn).toContainText("定位原消息");
      await expect(fileHitBtn).not.toContainText("无来源");
      await fileHitBtn.click();
      await expect(searchDialog).toBeHidden();
      await expect(pageOwner.getByRole("heading", { name: "v1.0 双端实时验收群" })).toBeVisible();
      await expect(
        pageOwner.getByRole("button", { name: "查看附件 release-checklist.pdf" })
      ).toBeVisible();

      // 8. Resize Member B to 320x568 ultra-narrow viewport and verify Shared Workspace responsive layout!
      await pageMember.setViewportSize({ width: 320, height: 568 });
      // Audit open File Inspector drawer at 320px first, then close via Escape!
      await assertNarrowWorkspaceNoOverlap(pageMember, "320px Shared Workspace Inspector Drawer");
      await pageMember.keyboard.press("Escape");
      await expect(pageMember.getByRole("button", { name: "关闭检查器" })).toHaveCount(0);

      await assertNarrowWorkspaceNoOverlap(pageMember, "320px Shared Workspace Chat View");

      await pageMember.getByRole("button", { name: "返回对话列表" }).click();
      await assertNarrowWorkspaceNoOverlap(pageMember, "320px Shared Workspace Conversation List");

      // 9. Verify Top-Left Dual-Lane Card-Deck Switcher (`卡片叠换动效`) on both Desktop (1280px) & 320px Mobile!
      const ownerDeckSwitch = pageOwner.getByTestId("dual-lane-deck-switch");
      await expect(ownerDeckSwitch).toHaveAttribute("data-active-lane", "workspace");
      await expect(ownerDeckSwitch).toHaveAttribute("data-front-card", "workspace");

      await ownerDeckSwitch.click();
      await expect(ownerDeckSwitch).toHaveAttribute("data-active-lane", "p2p");
      await expect(ownerDeckSwitch).toHaveAttribute("data-front-card", "p2p");
      await expect(pageOwner.getByRole("heading", { name: "私密直连", exact: true })).toBeVisible();
      // P2 Regression Gate: Switching from /workspace to Direct List MUST update URL to /direct AND survive reload!
      expect(new URL(pageOwner.url()).pathname).toBe("/direct");
      await pageOwner.reload();
      expect(new URL(pageOwner.url()).pathname).toBe("/direct");
      await expect(ownerDeckSwitch).toHaveAttribute("data-active-lane", "p2p");
      await expect(pageOwner.getByRole("heading", { name: "私密直连", exact: true })).toBeVisible();

      await ownerDeckSwitch.click();
      await expect(ownerDeckSwitch).toHaveAttribute("data-active-lane", "workspace");
      await expect(ownerDeckSwitch).toHaveAttribute("data-front-card", "workspace");
      expect(new URL(pageOwner.url()).pathname).toBe("/workspace");
      await pageOwner.getByRole("button", { name: /v1\.0 双端实时验收群/ }).click();
      await expect(pageOwner.getByRole("heading", { name: "v1.0 双端实时验收群" })).toBeVisible();

      const memberDeckSwitch = pageMember.getByTestId("dual-lane-deck-switch");
      await memberDeckSwitch.click();
      await expect(memberDeckSwitch).toHaveAttribute("data-active-lane", "p2p");
      await expect(memberDeckSwitch).toHaveAttribute("data-front-card", "p2p");
      await assertNarrowWorkspaceNoOverlap(pageMember, "320px Deck Switch -> P2P List");

      await memberDeckSwitch.click();
      await expect(memberDeckSwitch).toHaveAttribute("data-active-lane", "workspace");
      await expect(memberDeckSwitch).toHaveAttribute("data-front-card", "workspace");
      await assertNarrowWorkspaceNoOverlap(pageMember, "320px Deck Switch -> Workspace List");

      // 10. Stealth Governance & Cohesive Same-Origin SpaceAdminConsole Verification!
      // 10a. Ordinary member sees ZERO admin entry points (rail OR personal menu), ZERO privileged peer labels, and receives HTTP 403 on /api/v1/admin/*
      await expect(pageMember.getByRole("button", { name: "空间治理台" })).toHaveCount(0);
      await pageMember.getByRole("button", { name: "个人菜单" }).click();
      await expect(pageMember.getByRole("button", { name: "空间治理台" })).toHaveCount(0);
      await pageMember.keyboard.press("Escape");

      const memberAdminStatus = await pageMember.evaluate(async () => {
        const res = await fetch("/api/v1/admin/overview", { credentials: "same-origin" });
        return res.status;
      });
      expect(memberAdminStatus).toBe(403);

      // Reload pageMember on /workspace so bootstrap runs with directory-visibility isolation, then verify group details shows creator nickname ("timeStarry"), NEVER internal ID ("usr_owner")!
      await pageMember.setViewportSize({ width: 1280, height: 800 });
      await pageMember.reload();
      await pageMember.getByRole("button", { name: /v1\.0 双端实时验收群/ }).click();
      await pageMember.getByRole("button", { name: "详情与置顶" }).click();
      const memberInspector = pageMember.getByRole("complementary", { name: "对话右侧检查器" });
      await expect(memberInspector).toBeVisible();
      await expect(memberInspector).toContainText("timeStarry");
      await expect(memberInspector).not.toContainText("usr_owner");
      await expect(memberInspector).toContainText("空间成员");
      await expect(memberInspector).not.toContainText("空间所有者");
      await expect(memberInspector).not.toContainText("空间管理员");

      // 10b. Owner opens lazy-loaded SpaceAdminConsole and exercises all 4 governance modules!
      await expect(pageOwner.getByRole("button", { name: "空间治理台" })).toBeVisible();
      await pageOwner.getByRole("button", { name: "空间治理台" }).click();
      const adminDialog = pageOwner.getByRole("dialog", { name: "空间治理台" });
      await expect(adminDialog).toBeVisible();

      // Tab 1: Overview & Security Audit Logs + Desktop Close vs Refresh Zero-Overlap Gate!
      await expect(adminDialog).toContainText("安全与治理审计日志");
      await expect(adminDialog).toContainText("invite.accept");
      await assertWorkspaceNoOverlapAtWidth(
        pageOwner,
        1280,
        "1280px SpaceAdminConsole Overview (Close vs Refresh)"
      );

      // Tab 2: Members & Directory Visibility Isolation Matrix
      await adminDialog.getByRole("button", { name: "成员与可见性" }).click();
      await expect(adminDialog).toContainText("协作成员晓明");
      await expect(adminDialog).toContainText("Owner（空间主理人）");
      await adminDialog.getByRole("button", { name: "可见性" }).last().click();
      await expect(adminDialog).toContainText("通讯录可见性隔离矩阵");
      await adminDialog.getByRole("button", { name: "保存可见性白名单" }).click();
      await expect(adminDialog).toContainText("已保存成员通讯录可见性白名单");

      // Tab 3: Invite Code Lifecycle Management
      await adminDialog.getByRole("button", { name: "邀请码治理" }).click();
      await adminDialog.getByRole("button", { name: "签发邀请码" }).click();
      await expect(adminDialog.getByTestId("admin-created-invite-code")).toBeVisible();
      await adminDialog.getByRole("button", { name: "吊销" }).first().click();
      await expect(adminDialog).toContainText("已吊销");

      // Tab 4: Storage, Quota Policy & Stale Upload Cleanup
      await adminDialog.getByRole("button", { name: "存储与配额" }).click();
      await adminDialog.getByRole("button", { name: "2 GB" }).click();
      await adminDialog.getByRole("button", { name: "保存空间策略" }).click();
      await expect(adminDialog).toContainText("已更新空间全局配额与保留策略");
      await adminDialog.getByRole("button", { name: "清理超时挂起上传" }).click();

      // Verify SpaceAdminConsole at 320x568 ultra-narrow viewport has zero overlap AND clicking "邀请码治理" switches tabs without hitting the Close button!
      await pageOwner.setViewportSize({ width: 320, height: 568 });
      await assertNarrowWorkspaceNoOverlap(pageOwner, "320px SpaceAdminConsole Storage Tab");
      await adminDialog.getByRole("button", { name: "邀请码治理" }).click();
      await expect(adminDialog).toBeVisible();
      await expect(adminDialog).toContainText("签发新邀请码");
      await assertNarrowWorkspaceNoOverlap(pageOwner, "320px SpaceAdminConsole Invites Tab");
      await pageOwner.keyboard.press("Escape");
      await expect(adminDialog).toBeHidden();

      expect(ownerErrors).toEqual([]);
      expect(memberErrors).toEqual([]);
    } finally {
      await contextOwner.close();
      await contextMember.close();
    }
  });
});
