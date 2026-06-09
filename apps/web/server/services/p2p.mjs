const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

export function createP2PRoom(displayName, baseUrl) {
  const now = Date.now();
  const roomId = crypto.randomUUID().slice(0, 8);
  const expiresAt = new Date(now + ROOM_TTL_MS).toISOString();
  const room = {
    id: roomId,
    createdBy: displayName,
    createdAt: new Date(now).toISOString(),
    expiresAt,
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
    createdBy: room.createdBy,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    peerCount: room.peers.size
  };
}

export function attachP2PSocket(roomId, socket, peerName) {
  pruneExpiredRooms();
  const room = rooms.get(roomId);
  if (!room) {
    socket.send(JSON.stringify({ type: "system", event: "room-not-found" }));
    socket.close();
    return;
  }

  const peerId = crypto.randomUUID();
  const peer = {
    id: peerId,
    name: peerName || "Guest",
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
    peer: publicPeer(peer)
  });

  socket.on("message", (rawMessage) => {
    const parsed = parseSocketMessage(rawMessage);
    if (!parsed) {
      socket.send(JSON.stringify({ type: "system", event: "invalid-message" }));
      return;
    }

    broadcast(room, peerId, {
      ...parsed,
      from: publicPeer(peer),
      receivedAt: new Date().toISOString()
    });
  });

  socket.on("close", () => {
    room.peers.delete(peerId);
    broadcast(room, peerId, {
      type: "system",
      event: "peer-left",
      peer: publicPeer(peer)
    });
  });
}

function parseSocketMessage(rawMessage) {
  try {
    const value = JSON.parse(String(rawMessage));
    if (!value || typeof value !== "object" || typeof value.type !== "string") {
      return null;
    }
    return value;
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

function publicPeers(room) {
  return Array.from(room.peers.values(), publicPeer);
}

function publicPeer(peer) {
  return {
    id: peer.id,
    name: peer.name
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

const rooms = new Map();
