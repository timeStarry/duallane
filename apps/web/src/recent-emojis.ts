export const RECENT_EMOJIS_STORAGE_KEY = "duallane-recent-emojis";

type RecentEmojiRecord = {
  id: string;
  count: number;
  lastUsedAt: number;
};

type RecentEmojiStorage = Pick<Storage, "getItem" | "setItem">;

export function getRecentEmojiIds(
  availableIds: readonly string[],
  limit = 8,
  storage: RecentEmojiStorage | null = getBrowserStorage()
) {
  const available = new Set(availableIds);
  return readRecords(storage)
    .filter((record) => available.has(record.id))
    .sort(compareRecords)
    .slice(0, Math.max(0, limit))
    .map((record) => record.id);
}

export function recordRecentEmojiUse(
  emojiId: string,
  availableIds: readonly string[],
  storage: RecentEmojiStorage | null = getBrowserStorage(),
  now = Date.now()
) {
  if (!storage || !availableIds.includes(emojiId)) return getRecentEmojiIds(availableIds, 8, storage);
  const existing = readRecords(storage);
  const current = existing.find((record) => record.id === emojiId);
  const next = existing.filter((record) => record.id !== emojiId);
  next.push({
    id: emojiId,
    count: Math.min((current?.count ?? 0) + 1, Number.MAX_SAFE_INTEGER),
    lastUsedAt: now
  });
  next.sort(compareRecords);
  try {
    storage.setItem(RECENT_EMOJIS_STORAGE_KEY, JSON.stringify(next.slice(0, 24)));
  } catch {
    // Local storage can be unavailable in private browsing or restricted embeds.
  }
  return next.filter((record) => availableIds.includes(record.id)).slice(0, 8).map((record) => record.id);
}

function compareRecords(left: RecentEmojiRecord, right: RecentEmojiRecord) {
  return right.count - left.count || right.lastUsedAt - left.lastUsedAt;
}

function readRecords(storage: RecentEmojiStorage | null): RecentEmojiRecord[] {
  if (!storage) return [];
  try {
    const value = JSON.parse(storage.getItem(RECENT_EMOJIS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((record): record is RecentEmojiRecord =>
      record &&
      typeof record.id === "string" &&
      Number.isFinite(record.count) && record.count > 0 &&
      Number.isFinite(record.lastUsedAt) && record.lastUsedAt >= 0
    );
  } catch {
    return [];
  }
}

function getBrowserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
