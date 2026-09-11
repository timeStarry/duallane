import { describe, expect, it } from "vitest";
import { contextGrantTargets, grantSubmission, initialGrantDraft, type BotGrantOwner, type BotGrantSettings, type BotGroupPolicy, type GrantConversation } from "./context-grants";

const bot: BotGrantOwner = { id: "bot-a", botUserId: "user-bot-a", ownerUserId: "owner-a", status: "active" };
const settings: BotGrantSettings = { allowDirect: true, allowGroup: true, visibilityPolicy: "space_members", context: { maxMessages: 50 } };
const direct: GrantConversation = { id: "direct-a", type: "direct", members: [{ id: "owner-a" }, { id: "user-bot-a" }] };
const group: GrantConversation = { id: "group-a", type: "group", title: "测试群", members: [{ id: "owner-a" }], capabilities: { canManageMembers: true } };
const policy: BotGroupPolicy = { conversationId: "group-a", status: "active", allowTrigger: true, allowContext: false, contextMaxMessages: 8 };

describe("Bot conversation context grants", () => {
  it("only lists owner-Bot direct conversations and returned group policies", () => {
    const unrelated = { ...direct, id: "other-direct", members: [{ id: "owner-a" }, { id: "someone-else" }] };
    const targets = contextGrantTargets(bot, settings, [direct, unrelated, group, { ...group, id: "ungranted-group" }], [policy]);
    expect(targets.map(target => target.id)).toEqual(["direct-a", "group-a"]);
    expect(targets[0].known).toBe(false);
    expect(targets[1]).toMatchObject({ known: true, allowTrigger: true, allowContext: false, maxMessages: 8 });
  });
  it("does not interpret a private grant's missing read API as a saved disabled state", () => {
    const target = contextGrantTargets(bot, settings, [direct], [])[0];
    expect(target.known).toBe(false);
    const request = grantSubmission(bot.id, target, { allowTrigger: false, allowContext: true, maxMessages: "3" });
    expect(request).toEqual({ path: "/api/workspace/bots/bot-a/context-grants/direct-a", body: { allowTrigger: false, allowContext: true, maxMessages: 3 } });
  });
  it("keeps group membership active when explicitly closing both permissions", () => {
    const target = contextGrantTargets(bot, settings, [group], [policy])[0];
    const request = grantSubmission(bot.id, target, { allowTrigger: false, allowContext: false, maxMessages: "8" });
    expect(request).toEqual({ path: "/api/workspace/bots/bot-a/group-policies/group-a", body: { status: "active", allowTrigger: false, allowContext: false, maxMessages: 8 } });
    expect(request.body).not.toHaveProperty("scopes");
  });
  it.each(["pending", "removed", "rejected"])("never approves or re-adds a %s group grant", status => {
    const target = contextGrantTargets(bot, settings, [group], [{ ...policy, status }])[0];
    expect(target.readOnlyReason).toBeTruthy();
    expect(() => grantSubmission(bot.id, target, initialGrantDraft(target))).toThrow();
  });
  it("retains read-only group rows when management or membership was revoked", () => {
    for (const conversations of [[], [{ ...group, capabilities: { canManageMembers: false } }]]) {
      const target = contextGrantTargets(bot, settings, conversations, [policy])[0];
      expect(target.id).toBe("group-a");
      expect(() => grantSubmission(bot.id, target, initialGrantDraft(target))).toThrow(/只读/);
    }
  });
  it("respects active direct and enabled group policy prerequisites", () => {
    expect(contextGrantTargets({ ...bot, status: "paused" }, settings, [direct], [])[0].readOnlyReason).toBeTruthy();
    expect(contextGrantTargets(bot, { ...settings, allowDirect: false }, [direct], [])[0].readOnlyReason).toBeTruthy();
    expect(contextGrantTargets(bot, { ...settings, visibilityPolicy: "private" }, [group], [policy])[0].readOnlyReason).toBeTruthy();
  });
  it.each(["", "0", "201", "1.5", "NaN"])("rejects invalid message limit %s before sending", maxMessages => {
    const target = contextGrantTargets(bot, settings, [direct], [])[0];
    expect(() => grantSubmission(bot.id, target, { allowTrigger: true, allowContext: true, maxMessages })).toThrow(/1 到 200/);
  });
});
