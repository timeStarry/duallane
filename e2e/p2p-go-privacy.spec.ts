import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

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

async function createPrivateRoom(page: Page) {
  await page.goto("/");
  await page.getByTestId("home-card-direct").click();
  await expect.poll(() => /^\/direct\/[A-Za-z0-9_-]+$/.test(new URL(page.url()).pathname) && new URL(page.url()).hash.startsWith("#k=")).toBe(true);
  await expect(page.getByTestId("p2p-peer-status")).toContainText("等待对端加入");
  return page.url();
}

async function joinPrivateRoom(page: Page, inviteLink: string) {
  await page.goto(inviteLink);
  await expect(page.getByTestId("p2p-peer-status")).toContainText("对端已连接");
}

function privateMessage(page: Page, body: string) {
  return page.locator("[data-p2p-message-id]").filter({ hasText: body });
}

async function sendMessage(page: Page, body: string) {
  await page.getByLabel("发送端到端加密消息", { exact: true }).fill(body);
  await page.getByRole("button", { name: "加密发送", exact: true }).click();
}

function assertPrivate(observation: PrivacyObservation) {
  expect(observation.forbiddenUrl).toBe(false);
  expect(observation.forbiddenFrame).toBe(false);
  expect(observation.forbiddenRequest).toBe(false);
  expect(observation.unverifiedTraffic).toBe(false);
  expect(observation.clearTextFrame).toBe(false);
  expect(observation.nonSecureOutgoingFrame).toBe(false);
  expect(observation.p2pWebSocketCount).toBeGreaterThan(0);
  expect(observation.secureWsChatFrames).toBeGreaterThan(0);
}

test("Go P2P exchanges synthetic text and file content without exposing the fragment", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext({ acceptDownloads: true });
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  const ownerObservation = createPrivacyObservation(["go-p2p-direct-message", "go-p2p-direct-file"]);
  const guestObservation = createPrivacyObservation(["go-p2p-direct-message", "go-p2p-direct-file"]);
  ownerObservation.attach(ownerPage);
  guestObservation.attach(guestPage);

  try {
    const inviteLink = await createPrivateRoom(ownerPage);
    const secret = new URL(inviteLink).hash.slice(3);
    expect(secret.length).toBe(43);
    ownerObservation.setSecret(secret);
    guestObservation.setSecret(secret);
    await joinPrivateRoom(guestPage, inviteLink);
    await expect(ownerPage.getByTestId("p2p-peer-status")).toContainText("对端已连接");

    const directMessage = "go-p2p-direct-message";
    await sendMessage(ownerPage, directMessage);
    await expect(privateMessage(guestPage, directMessage)).toBeVisible();
    await expect(privateMessage(ownerPage, directMessage)).toHaveAttribute("data-delivery-status", "delivered");

    const fileName = "go-p2p-direct-file.bin";
    await ownerPage.getByLabel("选择端到端加密传输文件").setInputFiles({
      name: fileName,
      mimeType: "application/octet-stream",
      buffer: Buffer.from("go-p2p-direct-file")
    });
    const incomingTransfer = privateMessage(guestPage, fileName);
    await expect(incomingTransfer).toBeVisible();
    await expect(privateMessage(ownerPage, fileName)).toHaveAttribute("data-delivery-status", "delivered");
    const downloadPromise = guestPage.waitForEvent("download");
    await incomingTransfer.getByRole("button", { name: `下载 ${fileName}` }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(fileName);
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error("Playwright did not provide a path for the synthetic P2P file");
    expect(await readFile(downloadPath)).toEqual(Buffer.from("go-p2p-direct-file"));
    assertPrivate(ownerObservation.observation);
    assertPrivate(guestObservation.observation);
  } finally {
    await Promise.all([ownerContext.close(), guestContext.close()]);
  }
});

// AppV1 currently uses encrypted WebSocket transport for both text and files.
// This verifies that transport's confidentiality; it does not claim RTC parity.
test("Go P2P relays only encrypted secure envelopes when WebRTC is unavailable", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  for (const context of [ownerContext, guestContext]) {
    await context.addInitScript(() => {
      Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: undefined });
    });
  }
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  const ownerMessage = "go-p2p-relay-owner";
  const guestMessage = "go-p2p-relay-guest";
  const ownerObservation = createPrivacyObservation([ownerMessage, guestMessage]);
  const guestObservation = createPrivacyObservation([ownerMessage, guestMessage]);
  ownerObservation.attach(ownerPage);
  guestObservation.attach(guestPage);
  try {
    const inviteLink = await createPrivateRoom(ownerPage);
    const secret = new URL(inviteLink).hash.slice(3);
    ownerObservation.setSecret(secret);
    guestObservation.setSecret(secret);
    await joinPrivateRoom(guestPage, inviteLink);
    await expect(ownerPage.getByTestId("p2p-peer-status")).toContainText("对端已连接");
    await sendMessage(ownerPage, ownerMessage);
    await expect(privateMessage(guestPage, ownerMessage)).toBeVisible();
    await expect(privateMessage(ownerPage, ownerMessage)).toHaveAttribute("data-delivery-status", "delivered");
    await sendMessage(guestPage, guestMessage);
    await expect(privateMessage(ownerPage, guestMessage)).toBeVisible();
    await expect(privateMessage(guestPage, guestMessage)).toHaveAttribute("data-delivery-status", "delivered");
    assertPrivate(ownerObservation.observation);
    assertPrivate(guestObservation.observation);
  } finally {
    await Promise.all([ownerContext.close(), guestContext.close()]);
  }
});

test("Go P2P rejects an invalid fragment before opening a room transport", async ({ page }) => {
  const observation = createPrivacyObservation([]);
  observation.setSecret("not-a-valid-key");
  observation.attach(page);
  await page.goto("/direct/go-p2p-invalid-fragment#k=not-a-valid-key");
  await expect(page.getByText("无效的端到端加密密钥长度", { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/direct$/);
  expect(observation.observation.forbiddenUrl).toBe(false);
  expect(observation.observation.forbiddenRequest).toBe(false);
  expect(observation.observation.forbiddenFrame).toBe(false);
  expect(observation.observation.p2pHttpRequestCount).toBe(0);
  expect(observation.observation.p2pWebSocketCount).toBe(0);
});

test("Go P2P cannot decrypt a peer using a different browser-only key", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  const message = "go-p2p-wrong-key-body";
  const ownerObservation = createPrivacyObservation([message]);
  const guestObservation = createPrivacyObservation([message]);
  ownerObservation.attach(ownerPage);
  guestObservation.attach(guestPage);
  try {
    const inviteLink = await createPrivateRoom(ownerPage);
    const invite = new URL(inviteLink);
    const correctKey = invite.hash.slice(3);
    const wrongKey = `${correctKey[0] === "A" ? "B" : "A"}${correctKey.slice(1)}`;
    ownerObservation.setSecret(correctKey);
    guestObservation.setSecret(wrongKey);
    invite.hash = `k=${wrongKey}`;
    await joinPrivateRoom(guestPage, invite.toString());
    await expect(ownerPage.getByTestId("p2p-peer-status")).toContainText("对端已连接");
    await sendMessage(ownerPage, message);
    await expect(guestPage.getByText(/检测到无法解密的对端密文/)).toBeVisible();
    await expect.poll(() => guestObservation.observation.secureWsChatFrames).toBeGreaterThan(0);
    await expect(privateMessage(guestPage, message)).toHaveCount(0);
    await expect(privateMessage(ownerPage, message)).not.toHaveAttribute("data-delivery-status", "delivered");
    assertPrivate(ownerObservation.observation);
    assertPrivate(guestObservation.observation);
  } finally {
    await Promise.all([ownerContext.close(), guestContext.close()]);
  }
});
