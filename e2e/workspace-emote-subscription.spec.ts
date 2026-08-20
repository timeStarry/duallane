import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("aria-busy", "false");
}

async function waitForEmoteLibraryRefresh(page: Page) {
  return await page.waitForResponse((response) =>
    response.url().endsWith("/api/workspace/me/emote-library") &&
    response.request().method() === "GET" &&
    response.status() === 200
  );
}

test("a subscriber follows author changes, keeps snapshots, and sees detached state on mobile", async ({ browser }, testInfo) => {
  const suffix = randomUUID().slice(0, 8);
  const memberName = `表情订阅者 ${suffix}`;
  const sourceName = `订阅源 ${suffix}`;
  const updatedName = `已同步 ${suffix}`;
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();
  let memberId = "";
  let sourceEmoteId = "";

  try {
    await enterWorkspaceAsSeededOwner(ownerPage);

    const inviteResponse = await ownerPage.request.post("/api/workspace/invites", {
      data: { defaultRole: "member", maxUses: 1 }
    });
    expect(inviteResponse.status()).toBe(201);
    const invite = await inviteResponse.json() as { invite: { code: string } };
    const acceptResponse = await memberPage.request.post(
      `/api/workspace/invites/${encodeURIComponent(invite.invite.code)}/accept`,
      {
        data: {
          githubId: `emote-subscription-${suffix}`,
          githubLogin: `emote-subscription-${suffix}`,
          email: `emote-subscription-${suffix}@example.test`,
          displayName: memberName
        }
      }
    );
    expect(acceptResponse.status()).toBe(201);
    memberId = (await acceptResponse.json() as { user: { id: string } }).user.id;

    await memberPage.goto("/workspace");
    await expect(memberPage.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    await expect(memberPage.locator(".workspace-shell")).toHaveAttribute("aria-busy", "false");

    const emoteBytes = await readFile("apps/web/public/favicon-32x32.png");
    const emoteResponse = await ownerPage.request.post("/api/workspace/me/emotes", {
      headers: {
        "content-type": "image/png",
        "x-duallane-file-name": encodeURIComponent(`subscription-source-${suffix}.png`)
      },
      data: emoteBytes
    });
    expect(emoteResponse.status()).toBe(201);
    const sourceEmote = await emoteResponse.json() as { emote: { id: string; label: string } };
    sourceEmoteId = sourceEmote.emote.id;

    const collectionResponse = await ownerPage.request.post("/api/workspace/me/emote-collections", {
      data: { name: sourceName, emoteIds: [sourceEmote.emote.id] }
    });
    expect(collectionResponse.status()).toBe(201);
    const sourceCollection = await collectionResponse.json() as { collection: { id: string } };
    const shareResponse = await ownerPage.request.post(
      `/api/workspace/me/emote-collections/${encodeURIComponent(sourceCollection.collection.id)}/shares`
    );
    expect(shareResponse.status()).toBe(201);
    const share = await shareResponse.json() as { share: { id: string; sharePath: string } };

    await memberPage.goto(share.share.sharePath);
    await expect(memberPage.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    const subscribeOnImport = memberPage.getByRole("switch", { name: /订阅原作者更新/ });
    await expect(subscribeOnImport).toBeVisible();
    await expect(subscribeOnImport).toHaveAttribute("aria-checked", "false");
    const importToggleBox = await subscribeOnImport.boundingBox();
    expect(importToggleBox?.height).toBeGreaterThanOrEqual(44);
    await subscribeOnImport.click();
    await expect(subscribeOnImport).toHaveAttribute("aria-checked", "true");

    const importResponsePromise = memberPage.waitForResponse((response) =>
      response.url().endsWith(`/api/workspace/emote-collection-shares/${share.share.id}/import`) &&
      response.request().method() === "POST"
    );
    await memberPage.getByRole("button", { name: "添加整套", exact: true }).click();
    const importResponse = await importResponsePromise;
    expect(importResponse.status()).toBe(200);
    expect(importResponse.request().postDataJSON()).toMatchObject({
      asCollection: true,
      subscribeToSourceChanges: true
    });

    await memberPage.goto("/workspace/account/emotes");
    const manager = memberPage.getByRole("dialog", { name: "我的表情" });
    await expect(manager).toBeVisible();
    await manager.getByRole("button", { name: `打开合集 ${sourceName}`, exact: true }).click();
    const subscriptionPanel = manager.getByRole("region", { name: "合集来源订阅" });
    await expect(subscriptionPanel).toBeVisible();
    await expect(subscriptionPanel.getByText("已同步", { exact: true })).toBeVisible();
    await expect(subscriptionPanel.getByText("原作者 timeStarry", { exact: true })).toBeVisible();
    const managerSubscriptionSwitch = subscriptionPanel.getByRole("switch", { name: /订阅原作者更新/ });
    await expect(managerSubscriptionSwitch).toHaveAttribute("aria-checked", "true");
    await expect(manager.getByRole("button", { name: "添加已有", exact: true })).toBeDisabled();
    await expect(manager.getByRole("button", { name: `${sourceName} 正在订阅，不能重命名`, exact: true })).toBeDisabled();
    await expect(manager.locator(".workspace-emote-upload-button input")).toBeDisabled();
    await expect(manager.getByRole("button", { name: "分享合集", exact: true })).toBeEnabled();

    await manager.getByRole("button", { name: "整理", exact: true }).click();
    await expect(manager.locator(".workspace-emote-manager-collection .workspace-emote-tile-controls")).toHaveCount(0);
    await manager.getByRole("button", { name: `查看表情 ${sourceEmote.emote.label}`, exact: true }).click();
    const detail = manager.getByRole("dialog", { name: "表情详情" });
    await expect(detail.getByText("短名称由原作者同步。关闭合集订阅后可编辑。", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "移出当前合集", exact: true })).toBeDisabled();
    await expect(detail.getByRole("button", { name: "从我的表情删除", exact: true })).toBeDisabled();
    await detail.getByRole("button", { name: "关闭表情详情", exact: true }).click();

    const realtimeRefresh = waitForEmoteLibraryRefresh(memberPage);
    const renameResponse = await ownerPage.request.patch(
      `/api/workspace/me/emote-collections/${encodeURIComponent(sourceCollection.collection.id)}`,
      { data: { name: updatedName } }
    );
    expect(renameResponse.status()).toBe(200);
    await realtimeRefresh;
    await expect(manager.locator(".workspace-emote-manager-back").getByText(updatedName, { exact: true })).toBeVisible();
    await expect(subscriptionPanel.getByText(/版本 \d+/)).toBeVisible();
    await memberPage.screenshot({ path: testInfo.outputPath("emote-subscription-synced-desktop.png") });

    const disableResponsePromise = memberPage.waitForResponse((response) =>
      response.url().endsWith(`/source-subscription`) &&
      response.request().method() === "PUT"
    );
    await managerSubscriptionSwitch.click();
    const disableResponse = await disableResponsePromise;
    expect(disableResponse.status()).toBe(200);
    expect(disableResponse.request().postDataJSON()).toEqual({ enabled: false });
    await expect(subscriptionPanel.getByText("未订阅", { exact: true })).toBeVisible();
    await expect(managerSubscriptionSwitch).toHaveAttribute("aria-checked", "false");
    await expect(manager.getByRole("button", { name: `重命名 ${updatedName}`, exact: true })).toBeEnabled();
    await expect(manager.locator(".workspace-emote-upload-button input")).toBeEnabled();
    await expect(manager.getByRole("button", { name: `查看表情 ${sourceEmote.emote.label}`, exact: true })).toBeVisible();

    await managerSubscriptionSwitch.click();
    await expect(managerSubscriptionSwitch).toHaveAttribute("aria-checked", "true");
    await expect(subscriptionPanel.getByText("已同步", { exact: true })).toBeVisible();

    const detachedRefresh = waitForEmoteLibraryRefresh(memberPage);
    const deleteSourceResponse = await ownerPage.request.delete(
      `/api/workspace/me/emote-collections/${encodeURIComponent(sourceCollection.collection.id)}?itemDisposition=keep`
    );
    expect(deleteSourceResponse.status()).toBe(200);
    await detachedRefresh;
    await expect(subscriptionPanel.getByText("已断开", { exact: true })).toBeVisible();
    await expect(subscriptionPanel.getByText("原合集已删除，当前内容作为快照保留。", { exact: true })).toBeVisible();
    await expect(managerSubscriptionSwitch).toBeDisabled();
    await expect(managerSubscriptionSwitch).toHaveAttribute("aria-checked", "false");
    await expect(manager.getByRole("button", { name: `查看表情 ${sourceEmote.emote.label}`, exact: true })).toBeVisible();

    await memberPage.setViewportSize({ width: 390, height: 844 });
    const managerBox = await manager.boundingBox();
    expect(managerBox).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
    await expect(subscriptionPanel).toBeVisible();
    const mobileSwitchBox = await managerSubscriptionSwitch.boundingBox();
    expect(mobileSwitchBox?.height).toBeGreaterThanOrEqual(44);
    expect(await memberPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await memberPage.screenshot({ path: testInfo.outputPath("emote-subscription-detached-mobile.png") });
  } finally {
    if (sourceEmoteId) {
      await ownerPage.request.delete(`/api/workspace/me/emotes/${encodeURIComponent(sourceEmoteId)}`).catch(() => null);
    }
    if (memberId) {
      await ownerPage.request.delete(`/api/workspace/members/${encodeURIComponent(memberId)}`).catch(() => null);
    }
    await ownerContext.close();
    await memberContext.close();
  }
});
