import { describe, expect, it } from "vitest";
import {
  ECHO_CONVERSATION_POLICY,
  ECHO_GITHUB_LOGIN,
  ECHO_IDENTITY,
  ECHO_USER_ID,
  canEchoJoinConversationType,
  getEchoConversationCapabilities,
  getEchoIdentityDefinition,
  isCanonicalEchoProjection,
  isEchoAuthenticationAllowed,
  projectEchoIdentity
} from "./echo-identity.mjs";

describe("Echo identity contract", () => {
  it("defines a stable official bot identity without claiming database seed", () => {
    expect(getEchoIdentityDefinition()).toEqual({
      id: ECHO_USER_ID,
      githubLogin: ECHO_GITHUB_LOGIN,
      displayName: "回声",
      description: "需求与反馈助手",
      avatarUrl: "/assets/echo-avatar.png",
      kind: "bot",
      role: "member",
      conversationPolicy: ECHO_CONVERSATION_POLICY.DIRECT_ONLY,
      alwaysVisible: true,
      authenticationAllowed: false,
      memberManaged: false,
      contentAccess: "participants-only"
    });
    expect(Object.isFrozen(ECHO_IDENTITY)).toBe(true);
  });

  it("derives the official BOT projection and ignores client-shaped identity data", () => {
    const projection = projectEchoIdentity();
    expect(projection).toEqual({
      id: ECHO_USER_ID,
      displayName: "回声",
      description: "需求与反馈助手",
      avatarUrl: "/assets/echo-avatar.png",
      kind: "bot",
      role: "member",
      capabilities: {
        canStartDirectConversation: true,
        canJoinGroups: false
      }
    });
    expect(isCanonicalEchoProjection(projection)).toBe(true);

    const forged = {
      ...projection,
      id: "usr_human",
      kind: "bot",
      capabilities: { canStartDirectConversation: true, canJoinGroups: true }
    };
    expect(isCanonicalEchoProjection(forged)).toBe(false);
    expect(isCanonicalEchoProjection({ ...projection, kind: "human" })).toBe(false);
  });

  it("keeps Echo direct-only and prevents all user Session authentication", () => {
    expect(canEchoJoinConversationType("direct")).toBe(true);
    expect(canEchoJoinConversationType("group")).toBe(false);
    expect(canEchoJoinConversationType("topic")).toBe(false);
    expect(getEchoConversationCapabilities()).toEqual({
      canStartDirectConversation: true,
      canJoinGroups: false
    });
    expect(isEchoAuthenticationAllowed()).toBe(false);
    expect(ECHO_IDENTITY.authenticationAllowed).toBe(false);
    expect(ECHO_IDENTITY.memberManaged).toBe(false);
  });
});

