/**
 * Contract-only identity definition for the built-in Echo bot.
 *
 * This module deliberately has no database or Workspace service dependency.
 * Seeding, member projection, direct-conversation creation, and message
 * delivery must be wired by a later integration slice.
 */

export const ECHO_USER_ID = "usr_system_echo";
export const ECHO_GITHUB_LOGIN = "__duallane_echo__";

export const ECHO_CONVERSATION_POLICY = Object.freeze({
  DIRECT_ONLY: "direct-only"
});

const ECHO_CAPABILITIES = Object.freeze({
  canStartDirectConversation: true,
  canJoinGroups: false
});

export const ECHO_IDENTITY = Object.freeze({
  id: ECHO_USER_ID,
  githubLogin: ECHO_GITHUB_LOGIN,
  displayName: "回声",
  description: "需求与反馈助手",
  avatarUrl: "/assets/echo-avatar.svg",
  kind: "bot",
  role: "member",
  conversationPolicy: ECHO_CONVERSATION_POLICY.DIRECT_ONLY,
  alwaysVisible: true,
  authenticationAllowed: false,
  memberManaged: false,
  contentAccess: "participants-only"
});

const ECHO_PUBLIC_PROJECTION = Object.freeze({
  id: ECHO_USER_ID,
  displayName: ECHO_IDENTITY.displayName,
  description: ECHO_IDENTITY.description,
  avatarUrl: ECHO_IDENTITY.avatarUrl,
  kind: "bot",
  role: "member",
  capabilities: ECHO_CAPABILITIES
});

/** Return the server-owned identity definition. No client input is accepted. */
export function getEchoIdentityDefinition() {
  return ECHO_IDENTITY;
}

/**
 * Return only fields safe for member/conversation/message source projections.
 * A fresh object prevents callers from mutating the shared contract object.
 */
export function projectEchoIdentity() {
  return {
    ...ECHO_PUBLIC_PROJECTION,
    capabilities: { ...ECHO_PUBLIC_PROJECTION.capabilities }
  };
}

/**
 * Check that a value is the server-shaped Echo projection, rather than a
 * human attempting to claim the official BOT badge through request input.
 */
export function isCanonicalEchoProjection(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return value.id === ECHO_PUBLIC_PROJECTION.id &&
    value.displayName === ECHO_PUBLIC_PROJECTION.displayName &&
    value.description === ECHO_PUBLIC_PROJECTION.description &&
    value.avatarUrl === ECHO_PUBLIC_PROJECTION.avatarUrl &&
    value.kind === "bot" &&
    value.role === "member" &&
    value.capabilities?.canStartDirectConversation === true &&
    value.capabilities?.canJoinGroups === false;
}

/** Echo never authenticates or receives a Workspace user Session. */
export function isEchoAuthenticationAllowed() {
  return false;
}

/** Echo may only participate in a direct conversation. */
export function canEchoJoinConversationType(type) {
  return type === "direct";
}

/** The policy is intentionally explicit for callers that need both flags. */
export function getEchoConversationCapabilities() {
  return { ...ECHO_CAPABILITIES };
}

