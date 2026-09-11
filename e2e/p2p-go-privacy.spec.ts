import { readFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

type PrivacyObservation = {
  forbiddenUrl: boolean;
  forbiddenFrame: boolean;
  forbiddenRequest: boolean;
  unverifiedTraffic: boolean;
  clearTextFrame: boolean;
  nonSecureOutgoingFrame: boolean;
  secureWsChatFrames: number;
  p2pWebSocketCount: number;
  p2pHttpRequestCount: number;
};

function createPrivacyObservation(clearTokens: string[]) {
  let secret = "";
  // The owner's key becomes observable in the invite UI only after room
  // creation. Retain bounded memory-only observations until that moment so
  // initial requests are checked too; never serialize this buffer as evidence.
  const pending: { value: string; kind: "url" | "frame" | "request" }[] = [];
  let pendingBytes = 0;
  const observation: PrivacyObservation = {
    forbiddenUrl: false,
    forbiddenFrame: false,
    forbiddenRequest: false,
    unverifiedTraffic: false,
    clearTextFrame: false,
    nonSecureOutgoingFrame: false,
    secureWsChatFrames: 0,
    p2pWebSocketCount: 0,
    p2pHttpRequestCount: 0
  };

  function containsForbiddenContent(value: string) {
    return /#k=|%23k(?:=|%3d)/i.test(value) || (secret !== "" && value.includes(secret));
  }

  function inspectSecret(value: string, kind: "url" | "frame" | "request") {
    if (!secret) {
      pendingBytes += Buffer.byteLength(value);
      if (pending.length < 1024 && pendingBytes <= 2 * 1024 * 1024) pending.push({ value, kind });
      else observation.unverifiedTraffic = true;
    }
    if (!containsForbiddenContent(value)) return;
    if (kind === "url") observation.forbiddenUrl = true;
    if (kind === "frame") observation.forbiddenFrame = true;
    if (kind === "request") observation.forbiddenRequest = true;
  }

  function inspectUrl(value: string) {
    inspectSecret(value, "url");
  }

  function inspectFrame(frame: string | Buffer, outgoing: boolean) {
    const raw = typeof frame === "string" ? frame : frame.toString("utf8");
    inspectSecret(raw, "frame");
    if (clearTokens.some((token) => token !== "" && raw.includes(token))) {
      observation.clearTextFrame = true;
    }

    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") {
        if (outgoing) observation.nonSecureOutgoingFrame = true;
        return;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      if (outgoing) observation.nonSecureOutgoingFrame = true;
      return;
    }

    if (parsed.type === "secure") {
      const encrypted =
        parsed.v === 1 &&
        ["signal", "profile", "ws-chat"].includes(String(parsed.channel)) &&
        typeof parsed.nonce === "string" &&
        parsed.nonce.length > 0 &&
        typeof parsed.ciphertext === "string" &&
        parsed.ciphertext.length > 0 &&
        !Object.hasOwn(parsed, "body") &&
        !Object.hasOwn(parsed, "payload");
      if (parsed.channel === "ws-chat" && encrypted) {
        observation.secureWsChatFrames += 1;
      }
      if (outgoing && (!encrypted || Object.keys(parsed).some((key) => !["type", "v", "channel", "nonce", "ciphertext"].includes(key)))) {
        observation.nonSecureOutgoingFrame = true;
      }
      return;
    }

    if (outgoing && parsed.type !== "leave") {
      observation.nonSecureOutgoingFrame = true;
    }
  }

  return {
    observation,
    setSecret(value: string) {
      secret = value;
      for (const item of pending) inspectSecret(item.value, item.kind);
      pending.length = 0;
      pendingBytes = 0;
    },
    attach(page: Page) {
      page.on("request", (request) => {
        const url = request.url();
        inspectUrl(url);
        inspectSecret(JSON.stringify(request.headers()), "request");
        inspectSecret(request.postData() ?? "", "request");
        if (url.includes("/api/p2p/")) {
          observation.p2pHttpRequestCount += 1;
        }
      });
      page.on("websocket", (socket) => {
        const p2pSocket = socket.url().includes("/ws/p2p/");
        inspectUrl(socket.url());
        if (!p2pSocket) {
          return;
        }
        observation.p2pWebSocketCount += 1;
        socket.on("framesent", (frame) => inspectFrame(frame.payload, true));
        socket.on("framereceived", (frame) => inspectFrame(frame.payload, false));
      });
    }
  };
}

function secureSignalFrame(message: string | Buffer) {
  try {
    const raw = typeof message === "string" ? message : message.toString("utf8");
    const value: unknown = JSON.parse(raw);
    return Boolean(
      value &&
        typeof value === "object" &&
        (value as { type?: unknown }).type === "secure" &&
        (value as { channel?: unknown }).channel === "signal"
    );
  } catch {
    return false;
  }
}

async function blockWebRtcSignaling(context: BrowserContext) {
  let blocked = true;
  await context.routeWebSocket(/\/ws\/p2p\//, (webSocket) => {
    const server = webSocket.connectToServer();
    webSocket.onMessage((message) => {
      if (!blocked || !secureSignalFrame(message)) {
        server.send(message);
      }
    });
    server.onMessage((message) => {
      if (!blocked || !secureSignalFrame(message)) {
        webSocket.send(message);
      }
    });
  });
  return () => {
    blocked = false;
  };
}

async function openPrivateLane(page: Page, displayName: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /一对一直连/ }).click();
  await page.getByLabel("显示名称").fill(displayName);
}

async function createPrivateRoom(page: Page, displayName: string) {
  await openPrivateLane(page, displayName);
  await page.getByRole("button", { name: "开始会话" }).click();
  await expect(page.getByRole("heading", { name: "邀请对方，开始交流" })).toBeVisible();
  const inviteLink = (await page.locator(".p2p-waiting-invite .copy-box > span").textContent())?.trim() ?? "";
  return inviteLink;
}

async function joinPrivateRoom(page: Page, inviteLink: string, displayName: string) {
  await page.goto(inviteLink);
  await page.getByLabel("显示名称").fill(displayName);
  await page.getByRole("button", { name: "加入会话" }).click();
}

function privateMessage(page: Page, body: string) {
  return page.locator("article.message").filter({ hasText: body });
}

function fileTransfer(page: Page, fileName: string) {
  return page.locator(".file-transfer").filter({ hasText: fileName });
}

async function waitForDirectStatus(page: Page) {
  await expect(page.locator("button.p2p-status-trigger").getByText("浏览器直连", { exact: true })).toBeVisible({
    timeout: 30_000
  });
}

test("Go P2P exchanges synthetic text and file content between two browsers without exposing the fragment", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const contexts: BrowserContext[] = [ownerContext, guestContext];
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  const ownerObservation = createPrivacyObservation(["go-p2p-direct-message", "go-p2p-direct-file"]);
  const guestObservation = createPrivacyObservation(["go-p2p-direct-message", "go-p2p-direct-file"]);
  ownerObservation.attach(ownerPage);
  guestObservation.attach(guestPage);

  try {
    const inviteLink = await createPrivateRoom(ownerPage, "Go 浏览器甲");
    const invite = new URL(inviteLink);
    const secret = invite.hash.startsWith("#k=") ? invite.hash.slice(3) : "";
    expect(invite.pathname.startsWith("/direct/")).toBe(true);
    expect(secret.length).toBe(43);
    ownerObservation.setSecret(secret);

    guestObservation.setSecret(secret);
    await joinPrivateRoom(guestPage, inviteLink, "Go 浏览器乙");
    await waitForDirectStatus(ownerPage);
    await waitForDirectStatus(guestPage);

    const directMessage = "go-p2p-direct-message";
    await ownerPage.getByLabel("输入消息").fill(directMessage);
    await ownerPage.locator("form.composer button.send-button").click();
    await expect(guestPage.getByText(directMessage, { exact: true })).toBeVisible();
    await expect(privateMessage(ownerPage, directMessage).locator(".message-local-state")).toContainText("已送达");

    const fileName = "go-p2p-direct-file.bin";
    await ownerPage.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "application/octet-stream",
      buffer: Buffer.from("go-p2p-direct-file")
    });
    const incomingTransfer = fileTransfer(guestPage, fileName);
    await expect(incomingTransfer.getByRole("button", { name: "接受" })).toBeVisible();
    await incomingTransfer.getByRole("button", { name: "接受" }).click();
    await expect(incomingTransfer).toContainText("已完成", { timeout: 30_000 });
    await expect(fileTransfer(ownerPage, fileName)).toContainText("已完成", { timeout: 30_000 });
    await guestPage.evaluate(() => {
      Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    });
    const downloadPromise = guestPage.waitForEvent("download");
    await incomingTransfer.getByRole("button", { name: "保存" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(fileName);
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    if (!downloadPath) {
      throw new Error("Playwright did not provide a path for the Go P2P file");
    }
    expect(await readFile(downloadPath)).toEqual(Buffer.from("go-p2p-direct-file"));

    for (const observation of [ownerObservation.observation, guestObservation.observation]) {
      expect(observation.forbiddenUrl).toBe(false);
      expect(observation.forbiddenFrame).toBe(false);
      expect(observation.forbiddenRequest).toBe(false);
      expect(observation.unverifiedTraffic).toBe(false);
      expect(observation.clearTextFrame).toBe(false);
      expect(observation.nonSecureOutgoingFrame).toBe(false);
      expect(observation.p2pWebSocketCount).toBeGreaterThan(0);
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("Go P2P fallback relays only encrypted secure envelopes and keeps #k out of requests", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const contexts: BrowserContext[] = [ownerContext, guestContext];
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  const ownerMessage = "go-p2p-fallback-owner";
  const guestMessage = "go-p2p-fallback-guest";
  const ownerObservation = createPrivacyObservation([ownerMessage, guestMessage]);
  const guestObservation = createPrivacyObservation([ownerMessage, guestMessage]);
  ownerObservation.attach(ownerPage);
  guestObservation.attach(guestPage);
  const unblockOwner = await blockWebRtcSignaling(ownerContext);
  const unblockGuest = await blockWebRtcSignaling(guestContext);

  try {
    const inviteLink = await createPrivateRoom(ownerPage, "Go 中转甲");
    const invite = new URL(inviteLink);
    const secret = invite.hash.startsWith("#k=") ? invite.hash.slice(3) : "";
    expect(secret.length).toBe(43);
    ownerObservation.setSecret(secret);
    guestObservation.setSecret(secret);
    await joinPrivateRoom(guestPage, inviteLink, "Go 中转乙");

    await expect(ownerPage.locator("button.p2p-status-trigger").getByText("文本中转", { exact: true })).toBeVisible({
      timeout: 30_000
    });
    await expect(guestPage.locator("button.p2p-status-trigger").getByText("文本中转", { exact: true })).toBeVisible({
      timeout: 30_000
    });

    await ownerPage.getByLabel("输入消息").fill(ownerMessage);
    await ownerPage.locator("form.composer button.send-button").click();
    await expect(guestPage.getByText(ownerMessage, { exact: true })).toBeVisible();
    await expect(privateMessage(ownerPage, ownerMessage).locator(".message-local-state")).toContainText("已送达");

    await guestPage.getByLabel("输入消息").fill(guestMessage);
    await guestPage.locator("form.composer button.send-button").click();
    await expect(ownerPage.getByText(guestMessage, { exact: true })).toBeVisible();
    await expect(privateMessage(guestPage, guestMessage).locator(".message-local-state")).toContainText("已送达");

    for (const observation of [ownerObservation.observation, guestObservation.observation]) {
      expect(observation.forbiddenUrl).toBe(false);
      expect(observation.forbiddenFrame).toBe(false);
      expect(observation.forbiddenRequest).toBe(false);
      expect(observation.unverifiedTraffic).toBe(false);
      expect(observation.clearTextFrame).toBe(false);
      expect(observation.nonSecureOutgoingFrame).toBe(false);
      expect(observation.secureWsChatFrames).toBeGreaterThan(0);
    }
  } finally {
    unblockOwner();
    unblockGuest();
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("Go P2P rejects an invalid #k fragment before opening a room transport", async ({ page }) => {
  const observation = createPrivacyObservation([]);
  observation.setSecret("not-a-valid-key");
  observation.attach(page);
  await page.goto("/direct/go-p2p-invalid-fragment#k=not-a-valid-key");
  await expect(page.getByRole("heading", { name: "邀请链接不完整。" })).toBeVisible();
  expect(observation.observation.forbiddenUrl).toBe(false);
  expect(observation.observation.forbiddenRequest).toBe(false);
  expect(observation.observation.forbiddenFrame).toBe(false);
  expect(observation.observation.p2pHttpRequestCount).toBe(0);
  expect(observation.observation.p2pWebSocketCount).toBe(0);
});

test("Go P2P cannot decrypt a peer using a well-formed but different browser-only key", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  await guestContext.addInitScript(() => {
    const observedWindow = window as typeof window & { p2pTestDecryptFailures: number };
    observedWindow.p2pTestDecryptFailures = 0;
    const decrypt = SubtleCrypto.prototype.decrypt;
    SubtleCrypto.prototype.decrypt = function (...args: Parameters<SubtleCrypto["decrypt"]>) {
      return decrypt.apply(this, args).catch((error: unknown) => {
        observedWindow.p2pTestDecryptFailures += 1;
        throw error;
      });
    };
  });
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  const message = "go-p2p-wrong-key-body";
  const ownerObservation = createPrivacyObservation([message]);
  const guestObservation = createPrivacyObservation([message]);
  ownerObservation.attach(ownerPage);
  guestObservation.attach(guestPage);
  try {
    const inviteLink = await createPrivateRoom(ownerPage, "Go 密钥甲");
    const invite = new URL(inviteLink);
    const correctKey = invite.hash.slice(3);
    const wrongKey = `${correctKey[0] === "A" ? "B" : "A"}${correctKey.slice(1)}`;
    ownerObservation.setSecret(correctKey);
    guestObservation.setSecret(wrongKey);
    invite.hash = `k=${wrongKey}`;
    await joinPrivateRoom(guestPage, invite.toString(), "Go 密钥乙");
    // Observe failure without recording any key, plaintext or exception value.
    // The current chat UI does not render the internal decryption error state.
    const failures = () => guestPage.evaluate(() => (window as typeof window & { p2pTestDecryptFailures: number }).p2pTestDecryptFailures);
    await expect.poll(failures).toBeGreaterThan(0);
    await expect(ownerPage.locator("button.p2p-status-trigger").getByText("文本中转", { exact: true })).toBeVisible();
    const beforeMessage = await failures();
    await ownerPage.getByLabel("输入消息").fill(message);
    await ownerPage.locator("form.composer button.send-button").click();
    await expect.poll(failures).toBeGreaterThan(beforeMessage);
    await expect.poll(() => guestObservation.observation.secureWsChatFrames).toBeGreaterThan(0);
    await expect(guestPage.getByText(message, { exact: true })).toHaveCount(0);
    await expect(guestPage.locator('input[type="file"]')).toBeDisabled();
    for (const observation of [ownerObservation.observation, guestObservation.observation]) {
      expect(observation.forbiddenUrl).toBe(false);
      expect(observation.forbiddenFrame).toBe(false);
      expect(observation.forbiddenRequest).toBe(false);
      expect(observation.unverifiedTraffic).toBe(false);
      expect(observation.nonSecureOutgoingFrame).toBe(false);
      expect(observation.clearTextFrame).toBe(false);
      expect(observation.p2pWebSocketCount).toBeGreaterThan(0);
    }
  } finally {
    await Promise.all([ownerContext.close(), guestContext.close()]);
  }
});
