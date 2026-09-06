import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./index.mjs";

const WORKSPACE_DISABLED = {
  error: {
    code: "workspace.disabled",
    message: "共享空间暂未开放"
  }
};

const DISABLED_HTTP_REQUESTS = [
  { method: "GET", url: "/api/workspace/bootstrap" },
  { method: "GET", url: "/api/workspace/statistics" },
  { method: "GET", url: "/api/workspace/settings/email" },
  { method: "GET", url: "/api/workspace/me/notifications" },
  { method: "GET", url: "/api/workspace/me/ntfy" },
  { method: "GET", url: "/api/workspace/conversations" },
  { method: "GET", url: "/api/workspace/conversations/conv_candidate/messages" },
  { method: "GET", url: "/api/workspace/conversations/conv_candidate/topics" },
  { method: "GET", url: "/api/workspace/conversations/conv_candidate" },
  { method: "GET", url: "/api/workspace/groups/conv_candidate/pins" },
  { method: "GET", url: "/api/workspace/members" },
  { method: "GET", url: "/api/workspace/member-visibility/usr_candidate" },
  { method: "GET", url: "/api/workspace/avatars/usr_candidate/version-1" },
  { method: "GET", url: "/api/workspace/me/emote-settings" },
  { method: "GET", url: "/api/workspace/me/emotes" },
  { method: "GET", url: "/api/workspace/me/emote-library" },
  { method: "GET", url: "/api/workspace/emotes/emote_candidate/content" },
  { method: "GET", url: "/api/workspace/emote-collection-shares/share_candidate" },
  { method: "GET", url: "/api/workspace/bots" },
  { method: "GET", url: "/api/workspace/bots/bot_candidate" },
  { method: "GET", url: "/api/workspace/bots/bot_candidate/settings" },
  { method: "GET", url: "/api/workspace/bots/bot_candidate/group-policies" },
  { method: "GET", url: "/api/workspace/bots/bot_candidate/connection" },
  { method: "GET", url: "/api/workspace/bots/bot_candidate/tokens" },
  { method: "GET", url: "/api/workspace/bot-setup/setup_candidate" },
  { method: "GET", url: "/api/workspace/cards/card_candidate" },
  { method: "GET", url: "/api/workspace/workflows/workflow_candidate" },
  { method: "GET", url: "/api/workspace/echo/requirements" },
  { method: "GET", url: "/api/workspace/echo/requirements/stats" },
  { method: "GET", url: "/api/workspace/echo/requirements/public_candidate" },
  { method: "GET", url: "/api/workspace/echo/requirements/public_candidate/history" },
  { method: "GET", url: "/api/workspace/echo/solicitations" },
  { method: "GET", url: "/api/workspace/echo/solicitations/public_candidate" },
  { method: "GET", url: "/api/workspace/echo/solicitations/public_candidate/votes" },
  { method: "GET", url: "/api/workspace/echo/solicitations/public_candidate/deliveries" },
  { method: "GET", url: "/api/workspace/topics/mine" },
  { method: "GET", url: "/api/workspace/topics" },
  { method: "GET", url: "/api/workspace/topics/topic_candidate" },
  { method: "GET", url: "/api/workspace/topics/topic_candidate/messages" },
  { method: "GET", url: "/api/workspace/topics/topic_candidate/members" },
  { method: "GET", url: "/api/workspace/topics/topic_candidate/projections" },
  { method: "GET", url: "/api/workspace/files/uploads/upload_candidate" },
  { method: "GET", url: "/api/workspace/files" },
  { method: "GET", url: "/api/workspace/files/attachment_candidate/preview" },
  { method: "GET", url: "/api/workspace/files/attachment_candidate/download" },
  { method: "GET", url: "/api/bot-gateway/v1/me" },
  { method: "GET", url: "/api/bot-gateway/v1/conversations/conv_candidate/context" },
  { method: "GET", url: "/api/bot-gateway/v1/attachments/attachment_candidate" },
  { method: "GET", url: "/api/bot-gateway/v1/setup/status" },
  { method: "POST", url: "/api/workspace/bots", payload: { name: "candidate-disabled" } },
  { method: "POST", url: "/api/workspace/invites", payload: { defaultRole: "member", maxUses: 1, expiresInHours: 1 } },
  { method: "POST", url: "/api/workspace/messages", payload: {} },
  { method: "POST", url: "/api/workspace/files/uploads/reserve", payload: { fileName: "candidate.txt", byteSize: 1, mimeType: "text/plain" } },
  { method: "POST", url: "/api/bot-gateway/v1/messages", payload: {} }
];

async function waitForClose(socket) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for disabled candidate WebSocket close"));
    }, 1000);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("close", onClose);
      socket.off("error", onError);
    }

    function onClose(code, reason) {
      cleanup();
      resolve({ code, reason: reason.toString() });
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

describe("Node passive release candidate", () => {
  let app;
  let dataDir;

  afterEach(async () => {
    await app?.close();
    app = null;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  it("does not open the database or bootstrap Workspace, while preserving P2P and health/version", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "duallane-node-candidate-passive-"));
    app = await createApp({
      logger: false,
      env: {
        NODE_ENV: "production",
        SERVE_STATIC: "false",
        WORKSPACE_ENABLED: "false",
        DATABASE_AUTO_MIGRATE: "false",
        WORKSPACE_EMAIL_WORKER_ENABLED: "false",
        WORKSPACE_NTFY_WORKER_ENABLED: "false",
        WORKSPACE_ECHO_DELIVERY_WORKER_ENABLED: "false",
        DUALLANE_DATA_DIR: dataDir,
        PUBLIC_BASE_URL: "http://127.0.0.1:8787",
        DATABASE_URL: "postgres://[candidate-database-must-not-open"
      }
    });
    await app.ready();

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      ok: true,
      service: "duallane",
      lane: "ready",
      appVersion: JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version
    });

    const p2pRoom = await app.inject({
      method: "POST",
      url: "/api/p2p/rooms",
      payload: { maxPeers: 2 }
    });
    expect(p2pRoom.statusCode).toBe(201);
    expect(p2pRoom.json()).toMatchObject({ roomId: expect.any(String), maxPeers: 2 });

    const iceServers = await app.inject({ method: "GET", url: "/api/p2p/ice-servers" });
    expect(iceServers.statusCode).toBe(200);
    expect(iceServers.json()).toEqual({ iceServers: expect.any(Array) });

    for (const request of DISABLED_HTTP_REQUESTS) {
      const response = await app.inject(request);
      expect(response.statusCode, request.url).toBe(503);
      expect(response.json(), request.url).toEqual(WORKSPACE_DISABLED);
    }

    // This proves application-level Workspace rejection only; it does not
    // claim that external WebSocket dependencies are ready.
    for (const url of ["/ws/workspace", "/ws/bot-gateway"]) {
      const socket = await app.injectWS(url);
      await expect(waitForClose(socket)).resolves.toEqual({
        code: 1013,
        reason: "workspace disabled"
      });
    }

    expect(await readdir(dataDir)).toEqual([]);
  });
});
