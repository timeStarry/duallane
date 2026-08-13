export type EmotePickerPackId = "emoji" | "bili" | "douyin" | "wechat" | "qq" | "feishu" | "xiaohongshu" | "heybox" | "tieba" | "custom";
export type EmotePickerPreferenceScope = "p2p" | "workspace-composer" | "workspace-reaction";

export const EMOTE_PICKER_PACK_STORAGE_KEY = "duallane-emote-picker-pack";

type EmotePickerStorage = Pick<Storage, "getItem" | "setItem">;

export function getPreferredEmotePickerPack(
  scope: EmotePickerPreferenceScope,
  availablePackIds: readonly EmotePickerPackId[],
  fallbackPackId: EmotePickerPackId,
  storage: EmotePickerStorage | null = getBrowserStorage()
) {
  if (!storage) return fallbackPackId;
  try {
    const storedPackId = storage.getItem(getStorageKey(scope)) as EmotePickerPackId | null;
    return storedPackId && availablePackIds.includes(storedPackId) ? storedPackId : fallbackPackId;
  } catch {
    return fallbackPackId;
  }
}

export function rememberPreferredEmotePickerPack(
  scope: EmotePickerPreferenceScope,
  packId: EmotePickerPackId,
  storage: EmotePickerStorage | null = getBrowserStorage()
) {
  if (!storage) return;
  try {
    storage.setItem(getStorageKey(scope), packId);
  } catch {
    // Storage can be unavailable in private browsing or restricted embeds.
  }
}

export function getEmotePickerPackStorageKey(scope: EmotePickerPreferenceScope) {
  return getStorageKey(scope);
}

export function rememberEmotePickerPackOnClose(
  scope: EmotePickerPreferenceScope,
  packId: EmotePickerPackId,
  storage: EmotePickerStorage | null = getBrowserStorage()
) {
  rememberPreferredEmotePickerPack(scope, packId, storage);
}

function getStorageKey(scope: EmotePickerPreferenceScope) {
  return `${EMOTE_PICKER_PACK_STORAGE_KEY}:${scope}`;
}

function getBrowserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
