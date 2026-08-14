import { describe, expect, it } from "vitest";
import {
  CARD_BLOCK_TYPE,
  CARD_FALLBACK_TYPE,
  CardRegistry,
  CardValidationError,
  WORKSPACE_V1_BLOCK_TYPES,
  createCardRegistry,
  isWorkspaceV1ContentBlock,
  normalizeCardBlock,
  normalizeCardPayload
} from "./workspace-cards.mjs";

const cardBlock = (overrides = {}) => ({
  type: CARD_BLOCK_TYPE,
  cardId: "card_echo_1",
  cardType: "echo.solicitation",
  schemaVersion: 1,
  fallbackText: "新的需求征集",
  ...overrides
});

function expectCardError(callback, code) {
  let error;
  try {
    callback();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(CardValidationError);
  expect(error?.code).toBe(code);
}

describe("Workspace card blocks", () => {
  it("normalizes only the stable reference fields", () => {
    expect(normalizeCardBlock({ ...cardBlock(), payload: { trusted: false }, extra: "ignored" })).toEqual(cardBlock());
  });

  it("rejects malformed identifiers, versions, and fallback text", () => {
    for (const input of [
      { cardId: "bad id" },
      { cardType: "Echo/solicitation" },
      { schemaVersion: 0 },
      { fallbackText: "<b>unsafe</b>" }
    ]) {
      expect(() => normalizeCardBlock({ ...cardBlock(), ...input })).toThrow(CardValidationError);
    }
  });

  it("keeps every current v1 block type compatible", () => {
    expect(WORKSPACE_V1_BLOCK_TYPES).toEqual([
      "text", "mention", "link", "emoji", "attachment", "emote_collection"
    ]);
    for (const type of WORKSPACE_V1_BLOCK_TYPES) {
      expect(isWorkspaceV1ContentBlock({ type })).toBe(true);
    }
    expect(isWorkspaceV1ContentBlock({ type: "card" })).toBe(false);
  });
});

describe("Workspace card payload safety", () => {
  it("accepts bounded JSON and returns a detached normalized value", () => {
    const payload = { header: { title: "需求征集" }, actions: [{ id: "vote", label: "投票" }], status: "pong:hello" };
    const normalized = normalizeCardPayload(payload);
    expect(normalized).toEqual(payload);
    expect(normalized).not.toBe(payload);
  });

  it("rejects HTML, script-like content, and non-http URLs", () => {
    for (const payload of [
      { text: "<script>alert(1)</script>" },
      { text: "<div>unsafe</div>" },
      { text: "javascript:alert(1)" },
      { text: "<button onclick=evil()>点我</button>" },
      { url: "data:text/html,unsafe" },
      { constructor: { polluted: true } }
    ]) {
      expect(() => normalizeCardPayload(payload)).toThrow(CardValidationError);
    }
  });

  it("rejects private and unregistered public URLs", () => {
    expectCardError(() => normalizeCardPayload({ imageUrl: "http://127.0.0.1/admin" }, { allowPublicUrls: true }), "card.private_url");
    expectCardError(() => normalizeCardPayload({ imageUrl: "http://[fc00::1]/admin" }, { allowPublicUrls: true }), "card.private_url");
    expectCardError(() => normalizeCardPayload({ callbackUrl: "https://example.com/callback" }), "card.url_forbidden");
    expect(normalizeCardPayload({ imageUrl: "https://example.com/image.png" }, { allowPublicUrls: true }))
      .toEqual({ imageUrl: "https://example.com/image.png" });
  });

  it("rejects oversized, too-deep, and too-many-node payloads", () => {
    expectCardError(() => normalizeCardPayload({ text: "x".repeat(17 * 1024) }), "card.text_too_large");
    let deep = "leaf";
    for (let index = 0; index < 9; index += 1) deep = { child: deep };
    expectCardError(() => normalizeCardPayload(deep), "card.payload_too_deep");
    expectCardError(() => normalizeCardPayload(Array.from({ length: 201 }, () => 1)), "card.payload_too_complex");
  });
});

describe("Workspace card registry", () => {
  it("resolves registered cards and safely falls back for unknown versions", () => {
    const registry = createCardRegistry([{ cardType: "echo.solicitation", schemaVersion: 1 }]);
    expect(registry).toBeInstanceOf(CardRegistry);
    expect(registry.resolve(cardBlock())).toMatchObject({ type: "card", block: cardBlock() });
    expect(registry.resolve(cardBlock({ schemaVersion: 2 }))).toEqual({
      type: CARD_FALLBACK_TYPE,
      reason: "card.unknown_version",
      block: cardBlock({ schemaVersion: 2 }),
      fallbackText: "新的需求征集"
    });
  });

  it("runs the registered payload validator only after generic safety checks", () => {
    const registry = new CardRegistry([{
      cardType: "echo.solicitation",
      schemaVersion: 1,
      validatePayload(payload) {
        if (payload.options?.length < 2) {
          throw new CardValidationError("card.domain_invalid", "至少需要两个选项");
        }
        return { ...payload, validated: true };
      }
    }]);
    expect(registry.validatePayload(cardBlock(), { options: ["a", "b"] })).toMatchObject({
      type: "card",
      payload: { options: ["a", "b"], validated: true }
    });
    expectCardError(() => registry.validatePayload(cardBlock(), { options: ["<script>"] }), "card.unsafe_content");
  });

  it("rejects duplicate definitions", () => {
    expect(() => createCardRegistry([
      { cardType: "echo.solicitation", schemaVersion: 1 },
      { cardType: "echo.solicitation", schemaVersion: 1 }
    ]), "card.duplicate_definition");
  });
});
