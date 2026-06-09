import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./services/db.mjs";
import { attachP2PSocket, createP2PRoom, getP2PRoom } from "./services/p2p.mjs";
import {
  createRelayMessage,
  getWorkspaceBootstrap,
  listConversations,
  reserveTransferQuota,
  WorkspaceValidationError
} from "./services/workspace.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = process.env.DUALLANE_DATA_DIR ?? path.resolve(rootDir, "../../data");
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

await mkdir(dataDir, { recursive: true });
const db = openDatabase(dataDir);

const app = Fastify({
  logger: true,
  genReqId: () => crypto.randomUUID()
});

await app.register(fastifyCookie, {
  secret: process.env.SESSION_SECRET || "duallane-local-dev-secret-change-me"
});
await app.register(fastifyWebsocket);

app.get("/api/health", async () => ({
  ok: true,
  service: "duallane",
  lane: "ready",
  dataDir
}));

app.post("/api/p2p/rooms", async (request, reply) => {
  const displayName = normalizeDisplayName(request.body?.displayName);
  if (!displayName) {
    return reply.code(400).send({ error: "displayName is required" });
  }

  const baseUrl = process.env.PUBLIC_BASE_URL || `${request.protocol}://${request.host}`;
  const room = createP2PRoom(displayName, baseUrl);
  return reply.code(201).send(room);
});

app.get("/api/p2p/rooms/:roomId", async (request, reply) => {
  const room = getP2PRoom(request.params.roomId);
  if (!room) {
    return reply.code(404).send({ error: "room not found" });
  }
  return room;
});

app.get("/ws/p2p/:roomId", { websocket: true }, (socket, request) => {
  const peerName = normalizeDisplayName(request.query.name) || "Guest";
  attachP2PSocket(request.params.roomId, socket, peerName);
});

app.get("/api/workspace/bootstrap", async () => {
  return getWorkspaceBootstrap(db);
});

app.get("/api/workspace/conversations", async () => {
  return { conversations: listConversations(db) };
});

app.post("/api/workspace/messages", async (request, reply) => {
  try {
    const message = createRelayMessage(db, request, request.body ?? {});
    return reply.code(201).send({ message });
  } catch (error) {
    if (error instanceof WorkspaceValidationError) {
      return reply.code(400).send({ error: error.message });
    }
    throw error;
  }
});

app.post("/api/workspace/transfers/reserve", async (request, reply) => {
  try {
    const reservation = reserveTransferQuota(db, request, request.body ?? {});
    const statusCode = reservation.status === "rejected" ? 409 : 201;
    return reply.code(statusCode).send(reservation);
  } catch (error) {
    if (error instanceof WorkspaceValidationError) {
      return reply.code(400).send({ error: error.message });
    }
    throw error;
  }
});

if (process.env.NODE_ENV === "production") {
  const distDir = path.resolve(rootDir, "dist");
  await app.register(fastifyStatic, {
    root: distDir,
    prefix: "/"
  });
  app.setNotFoundHandler(async (_request, reply) => {
    return reply.sendFile("index.html");
  });
}

app.listen({ port, host });

function normalizeDisplayName(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, 80);
}
