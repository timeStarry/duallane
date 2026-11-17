import { describe, expect, it } from "vitest";
import {
  buildBotAccessPolicyPatch,
  describeBotAccessPolicy,
  isSelectableBotSourceMember,
  makePrivateAssistantGroupPolicy,
  parseBotAccessPolicy,
  toggleStringId,
} from "./bot-access-policy";

describe("Bot access policy", () => {
  it("does not infer a v2 policy from legacy settings", () => {
    expect(parseBotAccessPolicy({ visibilityPolicy: "space_members", allowGroup: true })).toBeNull();
    expect(parseBotAccessPolicy({ version: 1, discovery: { audience: "space_members" } })).toBeNull();
  });

  it("creates the private assistant / approved group preset", () => {
    const policy = makePrivateAssistantGroupPolicy();
    expect(policy.discovery.audience).toBe("owner_only");
    expect(policy.direct.audience).toBe("owner_only");
    expect(policy.groups.audience).toBe("current_members");
    expect(policy.groups.allowBotTriggers).toBe(false);
    expect(describeBotAccessPolicy(policy)).toContain("仅创建者可私聊");
  });

  it("normalizes explicit policies and keeps patch objects isolated", () => {
    const policy = parseBotAccessPolicy({
      version: 2,
      discovery: { audience: "specified_members", memberIds: ["u1", "u1", ""] },
      direct: { audience: "owner_only", memberIds: [] },
      groups: { audience: "current_members", memberIds: [], allowBotTriggers: true, allowedBotIds: ["b1", "b1"] },
    });
    expect(policy).toMatchObject({
      version: 2,
      discovery: { audience: "specified_members", memberIds: ["u1"] },
      groups: { allowBotTriggers: true, allowedBotIds: ["b1"] },
    });
    const patch = buildBotAccessPolicyPatch(policy!);
    patch.accessPolicy.discovery.memberIds.push("u2");
    expect(policy?.discovery.memberIds).toEqual(["u1"]);
  });

  it("toggles stable IDs without duplicates", () => {
    expect(toggleStringId(["u1", "u2"], "u2")).toEqual(["u1"]);
    expect(toggleStringId(["u1"], "u2")).toEqual(["u1", "u2"]);
    expect(toggleStringId(["u1"], "")).toEqual(["u1"]);
  });

  it("only exposes configured custom Bots as trigger sources", () => {
    expect(
      [
        { id: "human-1", role: "member", botId: "bot-human" },
        { id: "system-echo", role: "bot" },
        { id: "legacy-bot", role: "bot", botId: "   " },
        { id: "bot-user-1", role: "bot", botId: "bot-config-1" },
      ].filter((member) => isSelectableBotSourceMember(member))
    ).toEqual([{ id: "bot-user-1", role: "bot", botId: "bot-config-1" }]);
    expect(
      isSelectableBotSourceMember(
        { id: "bot-user-1", role: "bot", botId: "bot-config-1" },
        "bot-user-1"
      )
    ).toBe(false);
  });
});
