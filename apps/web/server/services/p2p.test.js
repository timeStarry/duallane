import { afterEach, describe, expect, it, vi } from "vitest";
import { attachP2PSocket, createP2PRoom, getP2PRoom } from "./p2p.mjs";

class MockSocket {
  readyState = 1;
  messages = [];
  closed = false;
  handlers = new Map();

  send(message) {
    this.messages.push(JSON.parse(message));
  }

  close() {
    this.closed = true;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }
}

describe("p2p service", () => {
  afterEach(() => {
    delete process.env.DUALLANE_EMPTY_ROOM_GRACE_MS;
    vi.useRealTimers();
  });

  it("creates high entropy room ids and exposes no creator metadata", () => {
    const first = createP2PRoom("http://127.0.0.1:5173");
    const second = createP2PRoom("http://127.0.0.1:5173");

    expect(first.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.roomId).not.toBe(second.roomId);
    expect(first).not.toHaveProperty("createdBy");
  });

  it("rejects the third peer for one-to-one rooms", () => {
    const { roomId } = createP2PRoom("http://127.0.0.1:5173");
    const first = new MockSocket();
    const second = new MockSocket();
    const third = new MockSocket();

    attachP2PSocket(roomId, first);
    attachP2PSocket(roomId, second);
    attachP2PSocket(roomId, third);

    expect(third.messages).toContainEqual({ type: "system", event: "room-full" });
    expect(third.closed).toBe(true);
  });

  it("does not relay plaintext message bodies", () => {
    const { roomId } = createP2PRoom("http://127.0.0.1:5173");
    const first = new MockSocket();
    const second = new MockSocket();

    attachP2PSocket(roomId, first);
    attachP2PSocket(roomId, second);

    second.messages = [];
    first.handlers.get("message")(JSON.stringify({ type: "message", body: "secret text" }));

    expect(first.messages).toContainEqual({ type: "system", event: "invalid-message" });
    expect(second.messages).toEqual([]);
  });

  it("relays secure envelopes without parsing ciphertext", () => {
    const { roomId } = createP2PRoom("http://127.0.0.1:5173");
    const first = new MockSocket();
    const second = new MockSocket();

    attachP2PSocket(roomId, first);
    attachP2PSocket(roomId, second);

    second.messages = [];
    first.handlers.get("message")(JSON.stringify({
      type: "secure",
      v: 1,
      channel: "ws-chat",
      nonce: "abc123_-",
      ciphertext: "ciphertext_-"
    }));

    expect(second.messages).toEqual([
      {
        type: "secure",
        v: 1,
        channel: "ws-chat",
        nonce: "abc123_-",
        ciphertext: "ciphertext_-",
        from: { id: expect.any(String) },
        receivedAt: expect.any(String)
      }
    ]);
  });

  it("removes a peer on leave", () => {
    const { roomId } = createP2PRoom("http://127.0.0.1:5173");
    const first = new MockSocket();
    const second = new MockSocket();

    attachP2PSocket(roomId, first);
    attachP2PSocket(roomId, second);

    second.messages = [];
    first.handlers.get("message")(JSON.stringify({ type: "leave" }));

    expect(first.closed).toBe(true);
    expect(second.messages).toContainEqual({
      type: "system",
      event: "peer-left",
      peers: [{ id: expect.any(String) }]
    });
  });

  it("cleans empty rooms after the grace period", () => {
    vi.useFakeTimers();
    process.env.DUALLANE_EMPTY_ROOM_GRACE_MS = "10000";
    const { roomId } = createP2PRoom("http://127.0.0.1:5173");
    const socket = new MockSocket();

    attachP2PSocket(roomId, socket);
    socket.handlers.get("close")();

    expect(getP2PRoom(roomId)).not.toBeNull();
    vi.advanceTimersByTime(9999);
    expect(getP2PRoom(roomId)).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(getP2PRoom(roomId)).toBeNull();
  });

  it("cancels empty room cleanup when a peer reconnects", () => {
    vi.useFakeTimers();
    process.env.DUALLANE_EMPTY_ROOM_GRACE_MS = "10000";
    const { roomId } = createP2PRoom("http://127.0.0.1:5173");
    const first = new MockSocket();
    const second = new MockSocket();

    attachP2PSocket(roomId, first);
    first.handlers.get("close")();
    vi.advanceTimersByTime(5000);
    attachP2PSocket(roomId, second);
    vi.advanceTimersByTime(5000);

    expect(getP2PRoom(roomId)).not.toBeNull();
  });
});
