import { readFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

async function openPrivateLane(page: Page, displayName: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /一对一直连/ }).click();
  await page.getByLabel("显示名称").fill(displayName);
}

function recordWebSocketPayloads(page: Page, payloads: string[]) {
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      payloads.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8"));
    });
  });
}

async function createPrivateRoom(page: Page, displayName: string) {
  await openPrivateLane(page, displayName);
  await page.getByRole("button", { name: "开始会话" }).click();
  await expect(page.getByRole("heading", { name: "分享这个邀请链接。" })).toBeVisible();

  const inviteLink = (await page.locator(".copy-box > span").textContent())?.trim() ?? "";
  await page.getByRole("button", { name: "进入聊天" }).click();
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

function isSecureSignalFrame(message: string | Buffer) {
  try {
    const raw = typeof message === "string" ? message : message.toString("utf8");
    const payload = JSON.parse(raw) as { type?: string; channel?: string };
    return payload.type === "secure" && payload.channel === "signal";
  } catch {
    return false;
  }
}

async function relayWithoutWebRtcSignaling(context: BrowserContext) {
  let signalingBlocked = true;
  await context.routeWebSocket(/\/ws\/p2p\//, (webSocket) => {
    const server = webSocket.connectToServer();
    webSocket.onMessage((message) => {
      if (!signalingBlocked || !isSecureSignalFrame(message)) {
        server.send(message);
      }
    });
    server.onMessage((message) => {
      if (!signalingBlocked || !isSecureSignalFrame(message)) {
        webSocket.send(message);
      }
    });
  });
  return () => {
    signalingBlocked = false;
  };
}

async function trackPeerConnections(context: BrowserContext) {
  await context.addInitScript(() => {
    const peerConnections: RTCPeerConnection[] = [];
    const dataChannels: RTCDataChannel[] = [];
    const p2pSockets: WebSocket[] = [];
    const NativePeerConnection = window.RTCPeerConnection;
    const NativeWebSocket = window.WebSocket;
    const originalCreateDataChannel = NativePeerConnection.prototype.createDataChannel;

    Object.defineProperty(NativePeerConnection.prototype, "createDataChannel", {
      configurable: true,
      value(this: RTCPeerConnection, ...args: Parameters<RTCPeerConnection["createDataChannel"]>) {
        const channel = Reflect.apply(originalCreateDataChannel, this, args) as RTCDataChannel;
        dataChannels.push(channel);
        return channel;
      }
    });
    const TrackedPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, args) {
        const peerConnection = Reflect.construct(target, args) as RTCPeerConnection;
        peerConnections.push(peerConnection);
        peerConnection.addEventListener("datachannel", (event) => dataChannels.push(event.channel));
        return peerConnection;
      }
    });
    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      value: TrackedPeerConnection
    });
    const TrackedWebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        if (socket.url.includes("/ws/p2p/")) {
          p2pSockets.push(socket);
        }
        return socket;
      }
    });
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: TrackedWebSocket
    });
    Object.defineProperty(window, "__duallaneP2pTestConnections", {
      configurable: true,
      value: { peerConnections, dataChannels, p2pSockets }
    });
  });
}

async function p2pSocketCount(page: Page) {
  return page.evaluate(() => {
    const tracked = (window as unknown as {
      __duallaneP2pTestConnections: { p2pSockets: WebSocket[] };
    }).__duallaneP2pTestConnections;
    return tracked.p2pSockets.length;
  });
}

async function closeLatestTrackedP2pSocket(page: Page) {
  await page.evaluate(() => {
    const tracked = (window as unknown as {
      __duallaneP2pTestConnections: { p2pSockets: WebSocket[] };
    }).__duallaneP2pTestConnections;
    const socket = [...tracked.p2pSockets].reverse().find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) {
      throw new Error("No open P2P WebSocket was tracked");
    }
    socket.close(4000, "p2p e2e reconnect");
  });
}

async function peerConnectionCount(page: Page) {
  return page.evaluate(() => {
    const tracked = (window as unknown as {
      __duallaneP2pTestConnections: { peerConnections: RTCPeerConnection[] };
    }).__duallaneP2pTestConnections;
    return tracked.peerConnections.length;
  });
}

async function closeTrackedPeerConnections(page: Page) {
  await page.evaluate(() => {
    const tracked = (window as unknown as {
      __duallaneP2pTestConnections: {
        peerConnections: RTCPeerConnection[];
        dataChannels: RTCDataChannel[];
      };
    }).__duallaneP2pTestConnections;
    for (const channel of [...tracked.dataChannels]) {
      if (channel.readyState !== "closed") {
        channel.close();
      }
    }
    for (const peerConnection of [...tracked.peerConnections]) {
      if (peerConnection.connectionState !== "closed") {
        peerConnection.close();
      }
    }
  });
}

test("two private-lane users exchange messages and a file without sending plaintext to signaling", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const contexts: BrowserContext[] = [ownerContext, guestContext];
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  const sentWebSocketPayloads: string[] = [];
  const backendRequestSnapshots: Array<Promise<{ url: string; headers: Record<string, string>; postData: string }>> = [];

  recordWebSocketPayloads(ownerPage, sentWebSocketPayloads);
  recordWebSocketPayloads(guestPage, sentWebSocketPayloads);
  for (const page of [ownerPage, guestPage]) {
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/api/p2p/") || url.includes("/ws/p2p/")) {
        const postData = request.postData() ?? "";
        backendRequestSnapshots.push(
          request.allHeaders().then((headers) => ({
            url,
            headers,
            postData
          }))
        );
      }
    });
  }

  try {
    const inviteLink = await createPrivateRoom(ownerPage, "直连用户甲");
    const inviteUrl = new URL(inviteLink);
    const roomSecret = inviteUrl.hash.slice("#k=".length);
    expect(inviteUrl.searchParams.get("lane")).toBe("p2p");
    expect(inviteUrl.searchParams.get("room")).toBeTruthy();
    expect(inviteUrl.hash).toMatch(/^#k=[A-Za-z0-9_-]+$/);
    expect(roomSecret).not.toBe("");

    const retryMessage = "p2p-e2e-retry-after-peer-joins";
    await ownerPage.getByLabel("输入消息").fill(retryMessage);
    await ownerPage.locator("form.composer button.send-button").click();
    const retryMessageCard = privateMessage(ownerPage, retryMessage);
    await expect(retryMessageCard).toContainText("对方尚未在线，消息未送达");
    await expect(retryMessageCard.getByRole("button", { name: "重试" })).toBeVisible();

    await joinPrivateRoom(guestPage, inviteLink, "直连用户乙");

    await expect(ownerPage.locator("details.p2p-status-control > summary").getByText("浏览器直连", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(guestPage.locator("details.p2p-status-control > summary").getByText("浏览器直连", { exact: true })).toBeVisible({ timeout: 20_000 });

    await retryMessageCard.getByRole("button", { name: "重试" }).click();
    await expect(guestPage.getByText(retryMessage, { exact: true })).toHaveCount(1);
    await expect(retryMessageCard.locator(".message-local-state")).toContainText("已送达");

    await guestPage.evaluate(() => {
      const originalSend = RTCDataChannel.prototype.send;
      let dropped = false;
      Object.defineProperty(RTCDataChannel.prototype, "send", {
        configurable: true,
        value(this: RTCDataChannel, data: unknown) {
          if (!dropped && typeof data === "string") {
            try {
              const envelope = JSON.parse(data) as { kind?: string };
              if (envelope.kind === "chat-ack") {
                dropped = true;
                return;
              }
            } catch {
              // Non-protocol data is forwarded unchanged.
            }
          }
          return Reflect.apply(originalSend, this, [data]);
        }
      });
    });

    const ackRetryMessage = "p2p-e2e-retry-after-ack-timeout";
    await ownerPage.getByLabel("输入消息").fill(ackRetryMessage);
    await ownerPage.locator("form.composer button.send-button").click();
    const ackRetryMessageCard = privateMessage(ownerPage, ackRetryMessage);
    await expect(guestPage.getByText(ackRetryMessage, { exact: true })).toHaveCount(1);
    await expect(ackRetryMessageCard).toContainText("未收到对方确认", { timeout: 12_000 });
    await ackRetryMessageCard.getByRole("button", { name: "重试" }).click();
    await expect(guestPage.getByText(ackRetryMessage, { exact: true })).toHaveCount(1);
    await expect(ackRetryMessageCard.locator(".message-local-state")).toContainText("已送达");

    const ownerSecretMessage = "p2p-e2e-owner-secret";
    await ownerPage.getByLabel("输入消息").fill(ownerSecretMessage);
    await ownerPage.locator("form.composer button.send-button").click();
    await expect(guestPage.getByText(ownerSecretMessage, { exact: true })).toBeVisible();
    await expect(privateMessage(ownerPage, ownerSecretMessage).locator(".message-local-state")).toContainText("已送达");

    const guestSecretMessage = "p2p-e2e-guest-secret";
    await guestPage.getByLabel("输入消息").fill(guestSecretMessage);
    await guestPage.locator("form.composer button.send-button").click();
    await expect(ownerPage.getByText(guestSecretMessage, { exact: true })).toBeVisible();
    await expect(privateMessage(guestPage, guestSecretMessage).locator(".message-local-state")).toContainText("已送达");

    const privateFileBytes = Buffer.from("private file bytes stay on the browser data channel");
    await ownerPage.locator('input[type="file"]').setInputFiles({
      name: "private-lane-e2e.txt",
      mimeType: "text/plain",
      buffer: privateFileBytes
    });
    await expect(guestPage.getByText("private-lane-e2e.txt", { exact: true })).toBeVisible();
    const guestFileTransfer = fileTransfer(guestPage, "private-lane-e2e.txt");
    await guestFileTransfer.getByRole("button", { name: "接受" }).click();
    await expect(guestFileTransfer).toContainText("已完成");
    await expect(fileTransfer(ownerPage, "private-lane-e2e.txt")).toContainText("已完成");

    await guestPage.evaluate(() => {
      Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    });
    const downloadPromise = guestPage.waitForEvent("download");
    await guestFileTransfer.getByRole("button", { name: "保存" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("private-lane-e2e.txt");
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    if (!downloadPath) {
      throw new Error("Playwright did not provide a path for the downloaded P2P file");
    }
    expect(await readFile(downloadPath)).toEqual(privateFileBytes);

    await ownerPage.evaluate(() => {
      const originalSend = RTCDataChannel.prototype.send;
      let corrupted = false;
      Object.defineProperty(RTCDataChannel.prototype, "send", {
        configurable: true,
        value(this: RTCDataChannel, data: unknown) {
          let outgoing = data;
          if (!corrupted && typeof data === "string") {
            try {
              const envelope = JSON.parse(data) as { kind?: string; data?: string };
              if (envelope.kind === "file-chunk" && envelope.data) {
                corrupted = true;
                envelope.data = `${envelope.data[0] === "A" ? "B" : "A"}${envelope.data.slice(1)}`;
                outgoing = JSON.stringify(envelope);
              }
            } catch {
              // Non-protocol data is forwarded unchanged.
            }
          }
          return Reflect.apply(originalSend, this, [outgoing]);
        }
      });
    });

    const corruptedFileName = "private-lane-corrupted-e2e.txt";
    await ownerPage.locator('input[type="file"]').setInputFiles({
      name: corruptedFileName,
      mimeType: "text/plain",
      buffer: Buffer.from("this payload is intentionally corrupted after hashing")
    });
    const corruptedGuestTransfer = fileTransfer(guestPage, corruptedFileName);
    await expect(corruptedGuestTransfer).toBeVisible();
    await corruptedGuestTransfer.getByRole("button", { name: "接受" }).click();
    await expect(corruptedGuestTransfer).toContainText("文件分片校验失败");
    await expect(fileTransfer(ownerPage, corruptedFileName)).toContainText("文件分片校验失败");
    await expect(corruptedGuestTransfer.getByRole("button", { name: "保存" })).toHaveCount(0);

    const backendRequests = await Promise.all(backendRequestSnapshots);
    expect(backendRequests.length).toBeGreaterThan(0);
    for (const request of backendRequests) {
      const serializedRequest = JSON.stringify(request);
      expect(serializedRequest).not.toContain("#k=");
      expect(serializedRequest).not.toContain(roomSecret);
    }
    const serializedFrames = sentWebSocketPayloads.join("\n");
    expect(serializedFrames).not.toContain(roomSecret);
    expect(serializedFrames).not.toContain(ownerSecretMessage);
    expect(serializedFrames).not.toContain(guestSecretMessage);
    expect(serializedFrames).not.toContain("private file bytes stay on the browser data channel");
    expect(serializedFrames).not.toContain(privateFileBytes.toString("base64"));
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("private-lane text falls back to encrypted WebSocket relay and receives acknowledgements", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const contexts: BrowserContext[] = [ownerContext, guestContext];
  const sentWebSocketPayloads: string[] = [];

  const enableOwnerSignaling = await relayWithoutWebRtcSignaling(ownerContext);
  const enableGuestSignaling = await relayWithoutWebRtcSignaling(guestContext);
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  recordWebSocketPayloads(ownerPage, sentWebSocketPayloads);
  recordWebSocketPayloads(guestPage, sentWebSocketPayloads);

  try {
    const inviteLink = await createPrivateRoom(ownerPage, "中转用户甲");
    await joinPrivateRoom(guestPage, inviteLink, "中转用户乙");

    const relayStatus = "文本中转";
    await expect(ownerPage.locator("details.p2p-status-control > summary").getByText(relayStatus, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(guestPage.locator("details.p2p-status-control > summary").getByText(relayStatus, { exact: true })).toBeVisible({ timeout: 20_000 });

    const ownerMessage = "p2p-e2e-encrypted-relay-owner";
    await ownerPage.getByLabel("输入消息").fill(ownerMessage);
    await ownerPage.locator("form.composer button.send-button").click();
    await expect(guestPage.getByText(ownerMessage, { exact: true })).toBeVisible();
    await expect(privateMessage(ownerPage, ownerMessage).locator(".message-local-state")).toContainText("已送达");

    const guestMessage = "p2p-e2e-encrypted-relay-guest";
    await guestPage.getByLabel("输入消息").fill(guestMessage);
    await guestPage.locator("form.composer button.send-button").click();
    await expect(ownerPage.getByText(guestMessage, { exact: true })).toBeVisible();
    await expect(privateMessage(guestPage, guestMessage).locator(".message-local-state")).toContainText("已送达");

    const serializedFrames = sentWebSocketPayloads.join("\n");
    expect(serializedFrames).not.toContain(ownerMessage);
    expect(serializedFrames).not.toContain(guestMessage);

    enableOwnerSignaling();
    enableGuestSignaling();
    await expect(ownerPage.locator("details.p2p-status-control > summary").getByText("浏览器直连", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(guestPage.locator("details.p2p-status-control > summary").getByText("浏览器直连", { exact: true })).toBeVisible({ timeout: 20_000 });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("private-lane rebuilds RTC and DataChannel connections after an abrupt close", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const contexts: BrowserContext[] = [ownerContext, guestContext];

  await trackPeerConnections(ownerContext);
  await trackPeerConnections(guestContext);
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();

  try {
    const inviteLink = await createPrivateRoom(ownerPage, "恢复用户甲");
    await joinPrivateRoom(guestPage, inviteLink, "恢复用户乙");

    const directStatus = "浏览器直连";
    const ownerDirectStatus = ownerPage.locator("details.p2p-status-control > summary").getByText(directStatus, { exact: true });
    const guestDirectStatus = guestPage.locator("details.p2p-status-control > summary").getByText(directStatus, { exact: true });
    await expect(ownerDirectStatus).toBeVisible({ timeout: 20_000 });
    await expect(guestDirectStatus).toBeVisible({ timeout: 20_000 });

    const ownerConnectionCount = await peerConnectionCount(ownerPage);
    const guestConnectionCount = await peerConnectionCount(guestPage);
    const ownerSocketCount = await p2pSocketCount(ownerPage);
    expect(ownerConnectionCount).toBeGreaterThan(0);
    expect(guestConnectionCount).toBeGreaterThan(0);
    expect(ownerSocketCount).toBeGreaterThan(0);

    await closeLatestTrackedP2pSocket(ownerPage);
    await expect.poll(() => p2pSocketCount(ownerPage), { timeout: 10_000 }).toBeGreaterThan(ownerSocketCount);
    expect(await peerConnectionCount(ownerPage)).toBe(ownerConnectionCount);
    await expect(ownerDirectStatus).toBeVisible();

    const signalRecoveredMessage = "p2p-e2e-message-after-signal-recovery";
    await ownerPage.getByLabel("输入消息").fill(signalRecoveredMessage);
    await ownerPage.locator("form.composer button.send-button").click();
    await expect(guestPage.getByText(signalRecoveredMessage, { exact: true })).toBeVisible();
    await expect(privateMessage(ownerPage, signalRecoveredMessage).locator(".message-local-state")).toContainText("已送达");

    await Promise.all([
      closeTrackedPeerConnections(ownerPage),
      closeTrackedPeerConnections(guestPage)
    ]);

    await expect.poll(() => peerConnectionCount(ownerPage), { timeout: 20_000 }).toBeGreaterThan(ownerConnectionCount);
    await expect.poll(() => peerConnectionCount(guestPage), { timeout: 20_000 }).toBeGreaterThan(guestConnectionCount);
    await expect(ownerDirectStatus).toBeVisible({ timeout: 20_000 });
    await expect(guestDirectStatus).toBeVisible({ timeout: 20_000 });
    await expect(ownerPage.getByRole("heading", { name: "房间已满。" })).toHaveCount(0);
    await expect(guestPage.getByRole("heading", { name: "房间已满。" })).toHaveCount(0);

    const recoveredMessage = "p2p-e2e-message-after-rtc-recovery";
    await ownerPage.getByLabel("输入消息").fill(recoveredMessage);
    await ownerPage.locator("form.composer button.send-button").click();
    await expect(guestPage.getByText(recoveredMessage, { exact: true })).toBeVisible();
    await expect(privateMessage(ownerPage, recoveredMessage).locator(".message-local-state")).toContainText("已送达");
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
