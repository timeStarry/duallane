import { ECHO_IDENTITY } from "./echo-identity.mjs";

export { ECHO_IDENTITY } from "./echo-identity.mjs";

export const SYSTEM_IDENTITY_CONVERSATION_POLICIES = Object.freeze({
  DIRECT_ONLY: "direct-only",
  GROUP_CAPABLE: "group-capable"
});

export const BEACON_USER_ID = "usr_system_beacon";
export const BEACON_GITHUB_LOGIN = "__duallane_beacon__";

export const BEACON_IDENTITY = Object.freeze({
  id: BEACON_USER_ID,
  githubLogin: BEACON_GITHUB_LOGIN,
  displayName: "信标",
  description: "文件传输助手",
  avatarUrl: "/assets/beacon-avatar.png",
  kind: "bot",
  role: "member",
  conversationPolicy: SYSTEM_IDENTITY_CONVERSATION_POLICIES.DIRECT_ONLY,
  alwaysVisible: true,
  authenticationAllowed: false,
  memberManaged: false,
  contentAccess: "participants-only"
});

const SYSTEM_IDENTITIES = new Map([
  [BEACON_IDENTITY.id, BEACON_IDENTITY],
  [ECHO_IDENTITY.id, ECHO_IDENTITY]
]);

const CONVERSATION_POLICY_CAPABILITIES = Object.freeze({
  [SYSTEM_IDENTITY_CONVERSATION_POLICIES.DIRECT_ONLY]: Object.freeze({
    canStartDirectConversation: true,
    canJoinGroups: false
  }),
  [SYSTEM_IDENTITY_CONVERSATION_POLICIES.GROUP_CAPABLE]: Object.freeze({
    canStartDirectConversation: true,
    canJoinGroups: true
  })
});

export function getSystemIdentityDefinition(identity) {
  const id = typeof identity === "string" ? identity : identity?.id;
  return id ? SYSTEM_IDENTITIES.get(id) ?? null : null;
}

export function getSystemIdentityConversationCapabilities(identity) {
  const definition = getSystemIdentityDefinition(identity);
  return getConversationPolicyCapabilities(definition?.conversationPolicy);
}

export function getConversationPolicyCapabilities(policy) {
  return CONVERSATION_POLICY_CAPABILITIES[policy] ?? Object.freeze({
    canStartDirectConversation: false,
    canJoinGroups: false
  });
}

export function isAuthenticationAllowedIdentity(identity) {
  const definition = getSystemIdentityDefinition(identity);
  return identity?.kind === "human" && (!definition || definition.authenticationAllowed === true);
}

export function isAlwaysVisibleSystemIdentity(identity) {
  return getSystemIdentityDefinition(identity)?.alwaysVisible === true;
}

export function listAlwaysVisibleSystemIdentityIds() {
  return Array.from(SYSTEM_IDENTITIES.values())
    .filter((identity) => identity.alwaysVisible)
    .map((identity) => identity.id);
}

export function isMemberManagedIdentity(identity) {
  const definition = getSystemIdentityDefinition(identity);
  return definition ? definition.memberManaged === true : true;
}

export function hasParticipantOnlyContent(identity) {
  return getSystemIdentityDefinition(identity)?.contentAccess === "participants-only";
}
