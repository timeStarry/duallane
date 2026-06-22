import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { getIceServers } from "./ice.mjs";

describe("ice service", () => {
  it("returns default stun servers without turn config", () => {
    expect(getIceServers({})).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
  });

  it("returns static turn credentials when provided", () => {
    expect(getIceServers({
      DUALLANE_STUN_URLS: "stun:one.example, stun:two.example",
      DUALLANE_TURN_URLS: "turns:turn.example:5349",
      DUALLANE_TURN_USERNAME: "user",
      DUALLANE_TURN_CREDENTIAL: "pass"
    })).toEqual([
      { urls: "stun:one.example" },
      { urls: "stun:two.example" },
      { urls: ["turns:turn.example:5349"], username: "user", credential: "pass" }
    ]);
  });

  it("generates coturn rest credentials from a shared secret", () => {
    const nowMs = 1_700_000_000_000;
    const username = "1700000600:duallane";
    const credential = crypto.createHmac("sha1", "secret").update(username).digest("base64");

    expect(getIceServers({
      DUALLANE_TURN_URLS: "turn:turn.example:3478,turns:turn.example:5349",
      DUALLANE_TURN_SHARED_SECRET: "secret",
      DUALLANE_TURN_TTL_SECONDS: "600"
    }, nowMs)).toContainEqual({
      urls: ["turn:turn.example:3478", "turns:turn.example:5349"],
      username,
      credential
    });
  });
});
