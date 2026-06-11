import { describe, expect, it } from "vitest";
import { attachP2PSocket, createP2PRoom } from "./p2p.mjs";

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
  it("rejects the third peer for one-to-one rooms", () => {
    const { roomId } = createP2PRoom("Owner", "http://127.0.0.1:5173");
    const first = new MockSocket();
    const second = new MockSocket();
    const third = new MockSocket();

    attachP2PSocket(roomId, first, "A");
    attachP2PSocket(roomId, second, "B");
    attachP2PSocket(roomId, third, "C");

    expect(third.messages).toContainEqual({ type: "system", event: "room-full" });
    expect(third.closed).toBe(true);
  });
});
