import type { EmotePack } from "../../emotes";
import type { WorkspaceAutoHidePreferences } from "../../workspace-auto-hide";
import type { WorkspaceRouteAccountSection } from "../../app-route";

export type AccountSettingsSection = WorkspaceRouteAccountSection | "appearance";
export type SettingsUser = {
  id: string;
  githubLogin?: string;
  displayName: string;
  nickname?: string | null;
  remark?: string;
  description?: string;
  avatarUrl?: string;
  searchDiscoverable?: boolean;
  recallReason?: string;
  kind: "human" | "bot" | "system";
  role: "owner" | "admin" | "member" | "auditor";
  roleLabel?: string;
  capabilities?: { canStartDirectConversation?: boolean; canJoinGroups?: boolean; canManage?: boolean };
  joinedAt: string;
};
export type SettingsNotice = (tone: "info" | "success" | "warning", text: string) => void;
export type SettingsEmoteSettings = WorkspaceAutoHidePreferences & {
  availablePacks: Array<{ id: Exclude<EmotePack["id"], "custom">; label: string; defaultEnabled: boolean }>;
  enabledPackIds: Array<Exclude<EmotePack["id"], "custom">>;
  clickImageEmoteToSend: boolean;
  replyAutoMention: boolean;
  minimumEnabled: number;
};
export type SettingsEmoteLibrarySummary = { usage: { itemCount: number; subscribedItemCount: number } };
export type SettingsServices = {
  json: <T>(path: string, options?: RequestInit) => Promise<T>;
  fetch: (path: string, options?: RequestInit) => Promise<Response>;
  loadEmoteLibrary: (force?: boolean) => Promise<SettingsEmoteLibrarySummary>;
  copyText: (value: string) => Promise<boolean>;
};

/** The application owns the confirmation and must invoke a continuation only after save returns true. */
export type SettingsNavigationGuard = {
  message: string;
  save: () => Promise<boolean>;
  discard: () => void | boolean;
};
export type RegisterSettingsNavigationGuard = (guard: SettingsNavigationGuard | null) => void;

export type SettingsNotificationPreferences = {
  email: string | null;
  maskedEmail: string | null;
  emailSource: "github" | "custom";
  emailVerified: boolean;
  githubEmail: string | null;
  enabled: boolean;
  immediateEnabled: boolean;
  digestEnabled: boolean;
  mailAvailable: boolean;
};
export type SettingsNtfyPreferences = {
  enabled: boolean;
  topic: string;
  serverUrl: string;
  subscriptionUrl: string;
  createdAt: string;
  rotatedAt: string | null;
  updatedAt: string;
};
