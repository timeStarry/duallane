export type BotPolicyAudience = "owner_only" | "specified_members" | "space_members";
export type BotGroupAudience = "owner_only" | "specified_members" | "current_members";

export interface BotAccessPolicy {
  version: 2;
  discovery: {
    audience: BotPolicyAudience;
    memberIds: string[];
  };
  direct: {
    audience: BotPolicyAudience;
    memberIds: string[];
  };
  groups: {
    audience: BotGroupAudience;
    memberIds: string[];
    allowBotTriggers: boolean;
    allowedBotIds: string[];
  };
}

export interface BotSourceMember {
  id: string;
  role?: string;
  botId?: string | null;
}

/**
 * Bot source policies persist the configured Bot ID, not the public member ID.
 * The backend only includes botId for custom Bots in an authorized projection;
 * legacy member payloads and system Bots therefore fail closed here.
 */
export function isSelectableBotSourceMember(
  member: BotSourceMember,
  excludedMemberId?: string
): member is BotSourceMember & { botId: string } {
  return (
    member.role === "bot" &&
    member.id !== excludedMemberId &&
    typeof member.botId === "string" &&
    member.botId.trim().length > 0
  );
}

export const BOT_ACCESS_POLICY_VERSION = 2 as const;

const MEMBER_AUDIENCES: readonly BotPolicyAudience[] = [
  "owner_only",
  "specified_members",
  "space_members",
];
const GROUP_AUDIENCES: readonly BotGroupAudience[] = [
  "owner_only",
  "specified_members",
  "current_members",
];

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function memberAudience(value: unknown): BotPolicyAudience {
  return MEMBER_AUDIENCES.includes(value as BotPolicyAudience)
    ? (value as BotPolicyAudience)
    : "owner_only";
}

function groupAudience(value: unknown): BotGroupAudience {
  return GROUP_AUDIENCES.includes(value as BotGroupAudience)
    ? (value as BotGroupAudience)
    : "owner_only";
}

/**
 * Only an explicit version-2 object is accepted. Legacy settings deliberately
 * return null so loading the settings page cannot silently migrate or widen
 * the old visibility fields.
 */
export function parseBotAccessPolicy(value: unknown): BotAccessPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== BOT_ACCESS_POLICY_VERSION) return null;
  const discovery = raw.discovery && typeof raw.discovery === "object" ? raw.discovery as Record<string, unknown> : {};
  const direct = raw.direct && typeof raw.direct === "object" ? raw.direct as Record<string, unknown> : {};
  const groups = raw.groups && typeof raw.groups === "object" ? raw.groups as Record<string, unknown> : {};
  return {
    version: BOT_ACCESS_POLICY_VERSION,
    discovery: { audience: memberAudience(discovery.audience), memberIds: stringList(discovery.memberIds) },
    direct: { audience: memberAudience(direct.audience), memberIds: stringList(direct.memberIds) },
    groups: {
      audience: groupAudience(groups.audience),
      memberIds: stringList(groups.memberIds),
      allowBotTriggers: groups.allowBotTriggers === true,
      allowedBotIds: stringList(groups.allowedBotIds),
    },
  };
}

export function makePrivateAssistantGroupPolicy(): BotAccessPolicy {
  return {
    version: BOT_ACCESS_POLICY_VERSION,
    discovery: { audience: "owner_only", memberIds: [] },
    direct: { audience: "owner_only", memberIds: [] },
    groups: { audience: "current_members", memberIds: [], allowBotTriggers: false, allowedBotIds: [] },
  };
}

export function cloneBotAccessPolicy(policy: BotAccessPolicy): BotAccessPolicy {
  return {
    version: BOT_ACCESS_POLICY_VERSION,
    discovery: { audience: policy.discovery.audience, memberIds: [...policy.discovery.memberIds] },
    direct: { audience: policy.direct.audience, memberIds: [...policy.direct.memberIds] },
    groups: {
      audience: policy.groups.audience,
      memberIds: [...policy.groups.memberIds],
      allowBotTriggers: policy.groups.allowBotTriggers,
      allowedBotIds: [...policy.groups.allowedBotIds],
    },
  };
}

export function buildBotAccessPolicyPatch(policy: BotAccessPolicy): { accessPolicy: BotAccessPolicy } {
  return { accessPolicy: cloneBotAccessPolicy(policy) };
}

export function isExplicitBotAccessPolicy(value: unknown): value is BotAccessPolicy {
  return parseBotAccessPolicy(value) !== null;
}

export function describeBotAccessPolicy(policy: BotAccessPolicy): string {
  const direct = policy.direct.audience === "owner_only"
    ? "仅创建者可私聊"
    : policy.direct.audience === "specified_members"
      ? `创建者与 ${policy.direct.memberIds.length} 名指定成员可私聊`
      : "空间成员可私聊";
  const group = policy.groups.audience === "current_members"
    ? "已批准群内当前成员可使用"
    : policy.groups.audience === "specified_members"
      ? `已批准群内 ${policy.groups.memberIds.length} 名指定成员可使用`
      : "仅创建者可在群内使用";
  const bot = policy.groups.allowBotTriggers ? "已启用指定 Bot 来源" : "Bot 之间默认不互相触发";
  return `${direct}；${group}；${bot}`;
}

export function toggleStringId(ids: readonly string[], id: string): string[] {
  const value = String(id).trim();
  if (!value) return [...ids];
  return ids.includes(value) ? ids.filter((item) => item !== value) : [...ids, value];
}
