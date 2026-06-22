const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ROOM_PEERS = 2;
const DEFAULT_EMPTY_ROOM_GRACE_MS = 10 * 1000;

export function createP2PRoom(baseUrl) {
  const now = Date.now();
  const roomId = makeRoomId();
  const expiresAt = new Date(now + ROOM_TTL_MS).toISOString();
  const room = {
    id: roomId,
    createdAt: new Date(now).toISOString(),
    expiresAt,
    cleanupTimer: null,
    peers: new Map()
  };

  rooms.set(roomId, room);

  return {
    roomId,
    inviteLink: `${baseUrl.replace(/\/$/, "")}/?lane=p2p&room=${roomId}`,
    expiresAt
  };
}

export function getP2PRoom(roomId) {
  pruneExpiredRooms();
  const room = rooms.get(roomId);
  if (!room) {
    return null;
  }

  return {
    roomId: room.id,
    expiresAt: room.expiresAt,
    peerCount: room.peers.size
  };
}

export function attachP2PSocket(roomId, socket) {
  pruneExpiredRooms();
  const room = rooms.get(roomId);
  if (!room) {
    socket.send(JSON.stringify({ type: "system", event: "room-not-found" }));
    socket.close();
    return;
  }
  if (room.peers.size >= MAX_ROOM_PEERS) {
    socket.send(JSON.stringify({ type: "system", event: "room-full" }));
    socket.close();
    return;
  }

  cancelRoomCleanup(room);
  const peerId = crypto.randomUUID();
  const peer = {
    id: peerId,
    socket
  };
  room.peers.set(peerId, peer);

  socket.send(JSON.stringify({
    type: "system",
    event: "joined",
    peerId,
    peers: publicPeers(room)
  }));
  broadcast(room, peerId, {
    type: "system",
    event: "peer-joined",
    peers: publicPeers(room)
  });
  broadcastPresence(room);

  socket.on("message", (rawMessage) => {
    const parsed = parseSocketMessage(rawMessage);
    if (!parsed) {
      socket.send(JSON.stringify({ type: "system", event: "invalid-message" }));
      return;
    }

    if (parsed.type === "leave") {
      detachPeer(room, peerId, true);
      socket.close();
      return;
    }

    broadcast(room, peerId, {
      ...parsed,
      from: publicPeer(peer),
      receivedAt: new Date().toISOString()
    });
  });

  socket.on("close", () => {
    detachPeer(room, peerId);
  });
}

function parseSocketMessage(rawMessage) {
  try {
    const value = JSON.parse(String(rawMessage));
    if (!value || typeof value !== "object" || typeof value.type !== "string") {
      return null;
    }
    if (value.type === "leave") {
      return { type: "leave" };
    }
    if (value.type === "secure" && value.v === 1 && isSafeChannel(value.channel) && isSafeBase64Url(value.nonce) && isSafeBase64Url(value.ciphertext)) {
      return {
        type: "secure",
        v: 1,
        channel: value.channel,
        nonce: value.nonce,
        ciphertext: value.ciphertext
      };
    }
    return null;
  } catch {
    return null;
  }
}

function broadcast(room, exceptPeerId, payload) {
  const encoded = JSON.stringify(payload);
  for (const [peerId, peer] of room.peers) {
    if (peerId !== exceptPeerId && peer.socket.readyState === 1) {
      peer.socket.send(encoded);
    }
  }
}

function broadcastPresence(room) {
  const encoded = JSON.stringify({
    type: "system",
    event: "peer-list",
    peers: publicPeers(room)
  });
  for (const peer of room.peers.values()) {
    if (peer.socket.readyState === 1) {
      peer.socket.send(encoded);
    }
  }
}

function publicPeers(room) {
  return Array.from(room.peers.values(), publicPeer);
}

function publicPeer(peer) {
  return {
    id: peer.id
  };
}

function pruneExpiredRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (Date.parse(room.expiresAt) <= now) {
      for (const peer of room.peers.values()) {
        peer.socket.close();
      }
      rooms.delete(roomId);
    }
  }
}

function detachPeer(room, peerId, immediateCleanup = false) {
  const deleted = room.peers.delete(peerId);
  if (!deleted) {
    return;
  }
  broadcast(room, peerId, {
    type: "system",
    event: "peer-left",
    peers: publicPeers(room)
  });
  broadcastPresence(room);
  if (room.peers.size === 0) {
    scheduleRoomCleanup(room, immediateCleanup ? 0 : getEmptyRoomGraceMs());
  }
}

function scheduleRoomCleanup(room, delayMs) {
  cancelRoomCleanup(room);
  if (delayMs <= 0) {
    rooms.delete(room.id);
    return;
  }
  room.cleanupTimer = setTimeout(() => {
    if (room.peers.size === 0) {
      rooms.delete(room.id);
    }
  }, delayMs);
}

function cancelRoomCleanup(room) {
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
}

function getEmptyRoomGraceMs() {
  const parsed = Number(process.env.DUALLANE_EMPTY_ROOM_GRACE_MS);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_EMPTY_ROOM_GRACE_MS;
}

function makeRoomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isSafeChannel(value) {
  return ["signal", "ws-chat", "profile"].includes(value);
}

function isSafeBase64Url(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && value.length <= 16384;
}

const rooms = new Map();
