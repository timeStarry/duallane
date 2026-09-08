import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";

type EmoteResponseGateSnapshot = {
  uploadHeadersReady: boolean;
  uploadStatus: number | null;
  responseBodyReleased: boolean;
  upstreamBodyRead: boolean;
  responseBodyLength: number;
  responseBodyText: string;
  preReleaseLibraryLoads: number;
  postReleaseLibraryLoads: number;
  preReleaseNotifications: number;
  postReleaseNotifications: number;
};

type EmoteResponseGate = {
  release: () => void;
  snapshot: () => EmoteResponseGateSnapshot;
};

type PageWithEmoteResponseGate = Window & {
  __duallaneEmoteResponseGate?: EmoteResponseGate;
};

type UploadResponse = {
  emote: {
    id: string;
    label: string;
  };
};

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function createUniquePng(seed: string): Buffer {
  const width = 4;
  const height = 4;
  const seedBytes = Buffer.from(seed.replaceAll("-", ""), "hex");
  const rowSize = 1 + width * 4;
  const pixels = Buffer.alloc(height * rowSize);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = y * rowSize + 1 + x * 4;
      const seedOffset = (y * width + x) % seedBytes.length;
      pixels[pixelOffset] = seedBytes[seedOffset] ^ (x * 29);
      pixels[pixelOffset + 1] = seedBytes[(seedOffset + 5) % seedBytes.length] ^ (y * 37);
      pixels[pixelOffset + 2] = seedBytes[(seedOffset + 10) % seedBytes.length] ^ ((x + y) * 17);
      pixels[pixelOffset + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function parseUploadResponse(raw: string): UploadResponse {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("emote upload response must be an object");
  }
  const emote = (parsed as { emote?: unknown }).emote;
  if (!emote || typeof emote !== "object" || Array.isArray(emote)) {
    throw new Error("emote upload response is missing its emote object");
  }
  const id = (emote as { id?: unknown }).id;
  const label = (emote as { label?: unknown }).label;
  if (typeof id !== "string" || id === "" || typeof label !== "string" || label === "") {
    throw new Error("emote upload response has an invalid emote projection");
  }
  return { emote: { id, label } };
}

async function installEmoteResponseGate(page: Page) {
  await page.addInitScript(() => {
    const libraryPath = "/api/workspace/me/emote-library";
    const uploadPath = "/api/workspace/me/emotes";
    const changedEvent = "duallane:workspace-emote-library-changed";
    const originalFetch = window.fetch.bind(window);
    let releaseBody: (() => void) | null = null;
    let releasePromise: Promise<void> | null = null;
    let uploadHeadersReady = false;
    let uploadStatus: number | null = null;
    let responseBodyReleased = false;
    let upstreamBodyRead = false;
    let responseBodyLength = 0;
    let responseBodyText = "";
    let preReleaseLibraryLoads = 0;
    let postReleaseLibraryLoads = 0;
    let preReleaseNotifications = 0;
    let postReleaseNotifications = 0;

    window.addEventListener(changedEvent, () => {
      if (!uploadHeadersReady) return;
      if (responseBodyReleased) postReleaseNotifications += 1;
      else preReleaseNotifications += 1;
    });

    const gate: EmoteResponseGate = {
      release() {
        releaseBody?.();
      },
      snapshot() {
        return {
          uploadHeadersReady,
          uploadStatus,
          responseBodyReleased,
          upstreamBodyRead,
          responseBodyLength,
          responseBodyText,
          preReleaseLibraryLoads,
          postReleaseLibraryLoads,
          preReleaseNotifications,
          postReleaseNotifications
        };
      }
    };
    (window as PageWithEmoteResponseGate).__duallaneEmoteResponseGate = gate;

    window.fetch = (input, init) => {
      const requestURL = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
      const requestMethod = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = new URL(requestURL, window.location.href);

      if (requestMethod === "GET" && url.pathname === libraryPath && uploadHeadersReady) {
        if (responseBodyReleased) postReleaseLibraryLoads += 1;
        else preReleaseLibraryLoads += 1;
      }

      if (requestMethod !== "POST" || url.pathname !== uploadPath) {
        return originalFetch(input, init);
      }

      releasePromise = new Promise<void>((resolve) => {
        releaseBody = resolve;
      });
      return originalFetch(input, init).then((upstream) => {
        uploadStatus = upstream.status;
        uploadHeadersReady = true;
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            await releasePromise;
            responseBodyReleased = true;
            const bytes = new Uint8Array(await upstream.arrayBuffer());
            upstreamBodyRead = true;
            responseBodyLength = bytes.byteLength;
            responseBodyText = new TextDecoder().decode(bytes);
            controller.enqueue(bytes);
            controller.close();
          }
        });
        const headers = new Headers(upstream.headers);
        headers.delete("content-length");
        return new Response(body, {
          headers,
          status: upstream.status,
          statusText: upstream.statusText
        });
      });
    };
  });
}

function gateSnapshot(page: Page): Promise<EmoteResponseGateSnapshot> {
  return page.evaluate(() => {
    const gate = (window as PageWithEmoteResponseGate).__duallaneEmoteResponseGate;
    if (!gate) throw new Error("emote response gate was not installed");
    return gate.snapshot();
  });
}

async function enterWorkspaceAsSeededOwner(page: Page) {
  await page.goto("/workspace");
  await page.getByRole("button", { name: "使用 GitHub 登录" }).click();
  await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
  await expect(page.locator(".workspace-shell")).toHaveAttribute("aria-busy", "false");
}

test("picker waits for its real upload body before refreshing the emote library", async ({ page }) => {
  await installEmoteResponseGate(page);
  let uploadedEmoteId: string | null = null;
  let uploadResponseStatus: number | null = null;
  const preExistingEmoteIds = new Set<string>();
  try {
    await enterWorkspaceAsSeededOwner(page);

    const bootstrapResponse = await page.request.get("/api/workspace/bootstrap");
    expect(bootstrapResponse.status()).toBe(200);
    const bootstrap = await bootstrapResponse.json() as {
      members: Array<{ id: string; displayName: string; kind: string }>;
    };
    const echo = bootstrap.members.find((member) => member.id === "usr_system_echo");
    expect(echo).toMatchObject({ displayName: "回声", kind: "bot" });

    const conversationResponse = await page.request.post("/api/workspace/conversations", {
      data: { type: "direct", targetUserId: echo!.id }
    });
    expect(conversationResponse.status()).toBe(201);
    const conversation = (await conversationResponse.json() as { conversation: { id: string } }).conversation;

    await page.goto(`/workspace/chat/${encodeURIComponent(conversation.id)}`);
    await expect(page.locator(".workspace-shell")).toHaveAttribute("data-app-state", "ready");
    const chat = page.getByRole("region", { name: echo!.displayName });
    await expect(chat).toBeVisible();

    const pickerLibraryResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/me/emote-library") &&
      response.request().method() === "GET" &&
      response.status() === 200
    );
    await chat.getByTitle("插入表情").click();
    const picker = page.getByRole("dialog", { name: "选择表情" });
    await expect(picker).toBeVisible();
    await pickerLibraryResponse;
    await picker.getByRole("tab", { name: "收藏", exact: true }).click();
    const uploadInput = picker.locator('input[type="file"]');
    await expect(uploadInput).toBeEnabled();

    const emoteListBeforeUpload = await page.request.get("/api/workspace/me/emotes");
    expect(emoteListBeforeUpload.status()).toBe(200);
    const emoteListPayload = await emoteListBeforeUpload.json() as {
      items?: Array<{ id: string }>;
    };
    const preExistingEmotes = emoteListPayload.items;
    if (!Array.isArray(preExistingEmotes)) {
      throw new Error("emote list response has no emote collection");
    }
    for (const emote of preExistingEmotes) {
      if (typeof emote.id === "string" && emote.id !== "") preExistingEmoteIds.add(emote.id);
    }

    const fileName = `picker-response-order-${randomUUID()}.png`;
    const uploadResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/workspace/me/emotes") &&
      response.request().method() === "POST"
    );
    await uploadInput.setInputFiles({
      name: fileName,
      mimeType: "image/png",
      buffer: createUniquePng(randomUUID())
    });
    const uploadResponse = await uploadResponsePromise;
    uploadResponseStatus = uploadResponse.status();
    expect(uploadResponseStatus).toBe(201);
    await expect.poll(() => gateSnapshot(page).then((snapshot) => snapshot.uploadHeadersReady)).toBe(true);
    const headersSnapshot = await gateSnapshot(page);
    expect(headersSnapshot.uploadStatus).toBe(201);
    expect(headersSnapshot.responseBodyReleased).toBe(false);
    expect(headersSnapshot.upstreamBodyRead).toBe(false);

    await page.evaluate(() => new Promise<void>((resolve) => {
      queueMicrotask(() => requestAnimationFrame(() => resolve()));
    }));
    const preReleaseSnapshot = await gateSnapshot(page);
    expect(preReleaseSnapshot.preReleaseLibraryLoads).toBe(0);
    expect(preReleaseSnapshot.preReleaseNotifications).toBe(0);

    await page.evaluate(() => {
      const gate = (window as PageWithEmoteResponseGate).__duallaneEmoteResponseGate;
      if (!gate) throw new Error("emote response gate was not installed");
      gate.release();
    });
    await expect.poll(() => gateSnapshot(page).then((snapshot) => snapshot.upstreamBodyRead)).toBe(true);
    await expect.poll(() => gateSnapshot(page).then((snapshot) => snapshot.responseBodyLength)).toBeGreaterThan(0);
    const uploadPayload = parseUploadResponse((await gateSnapshot(page)).responseBodyText);
    uploadedEmoteId = uploadPayload.emote.id;
    await expect.poll(() => gateSnapshot(page).then((snapshot) => snapshot.postReleaseLibraryLoads)).toBeGreaterThan(0);
    await expect.poll(() => gateSnapshot(page).then((snapshot) => snapshot.postReleaseNotifications)).toBe(1);
    await expect(picker.getByRole("button", { name: uploadPayload.emote.label, exact: true })).toBeVisible();
    await expect(uploadInput).toBeEnabled();
  } finally {
    const gateBeforeCleanup = await gateSnapshot(page);
    await page.evaluate(() => {
      const gate = (window as PageWithEmoteResponseGate).__duallaneEmoteResponseGate;
      if (!gate) throw new Error("emote response gate was not installed");
      gate.release();
    });

    if (uploadResponseStatus === 201 || gateBeforeCleanup.uploadHeadersReady) {
      await expect.poll(() => gateSnapshot(page).then((snapshot) => snapshot.upstreamBodyRead)).toBe(true);
      if (!uploadedEmoteId) {
        const uploadPayload = parseUploadResponse((await gateSnapshot(page)).responseBodyText);
        uploadedEmoteId = uploadPayload.emote.id;
      }
    }

    if (uploadedEmoteId && !preExistingEmoteIds.has(uploadedEmoteId)) {
      const cleanupResponse = await page.request.delete(
        `/api/workspace/me/emotes/${encodeURIComponent(uploadedEmoteId)}`
      );
      if (cleanupResponse.status() !== 200) {
        throw new Error(`focused emote cleanup returned HTTP ${cleanupResponse.status()}`);
      }
    }
  }
});
