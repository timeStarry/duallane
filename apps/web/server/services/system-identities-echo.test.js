import { describe, expect, it } from "vitest";
import {
  ECHO_IDENTITY,
  getSystemIdentityConversationCapabilities,
  getSystemIdentityDefinition,
  hasParticipantOnlyContent,
  isAlwaysVisibleSystemIdentity,
  isAuthenticationAllowedIdentity,
  isMemberManagedIdentity,
  SYSTEM_IDENTITY_CONVERSATION_POLICIES
} from "./system-identities.mjs";

describe("registered Echo system identity", () => {
  it("resolves the stable Echo identity through the shared registry", () => {
    expect(getSystemIdentityDefinition(ECHO_IDENTITY.id)).toBe(ECHO_IDENTITY);
    expect(getSystemIdentityDefinition({ id: ECHO_IDENTITY.id })).toBe(ECHO_IDENTITY);
    expect(ECHO_IDENTITY).toMatchObject({
      id: "usr_system_echo",
      displayName: "回声",
      kind: "bot",
      conversationPolicy: SYSTEM_IDENTITY_CONVERSATION_POLICIES.DIRECT_ONLY,
      alwaysVisible: true,
      authenticationAllowed: false,
      memberManaged: false,
      contentAccess: "participants-only"
    });
  });

  it("reuses shared policy helpers for direct-only visibility and privacy", () => {
    expect(getSystemIdentityConversationCapabilities(ECHO_IDENTITY)).toEqual({
      canStartDirectConversation: true,
      canJoinGroups: false
    });
    expect(isAlwaysVisibleSystemIdentity(ECHO_IDENTITY)).toBe(true);
    expect(isMemberManagedIdentity(ECHO_IDENTITY)).toBe(false);
    expect(hasParticipantOnlyContent(ECHO_IDENTITY)).toBe(true);
  });

  it("keeps the registered bot out of authentication and user identity flows", () => {
    expect(isAuthenticationAllowedIdentity(ECHO_IDENTITY)).toBe(false);
    expect(isAuthenticationAllowedIdentity({ ...ECHO_IDENTITY, kind: "human" })).toBe(false);
    expect(getSystemIdentityDefinition({ id: "usr_human_named_echo", kind: "bot" })).toBeNull();
  });
});

