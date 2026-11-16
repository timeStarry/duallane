import { create } from "zustand";
import { emotePacks } from "@/emotes";

export const RECENT_EMOJIS_V1_STORAGE_KEY = "dl_recent_emojis_v1";
const MAX_RECENT_EMOJIS = 8;

const emojiPack = emotePacks.find((p) => p.id === "emoji");
const VALID_EMOJI_ID_SET = new Set((emojiPack?.items || []).map((i) => i.id));
const COMPACT_ID_MAP = new Map<string, string>();
const GLYPH_TO_EMOJI_ID = new Map<string, string>();
for (const item of emojiPack?.items || []) {
  COMPACT_ID_MAP.set(item.id.replace(/[-_]/g, "").toLowerCase(), item.id);
  if (item.kind === "unicode" && item.value) {
    GLYPH_TO_EMOJI_ID.set(item.value, item.id);
  }
}

function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const s = window.localStorage;
    return s && typeof s.getItem === "function" ? s : null;
  } catch {
    return null;
  }
}

export function loadRecentEmojiIdsV1(): string[] {
  const storage = getSafeLocalStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_EMOJIS_V1_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of parsed) {
      const id = typeof entry === "string" ? entry.trim() : "";
      if (id && VALID_EMOJI_ID_SET.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
        if (out.length >= MAX_RECENT_EMOJIS) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

function persistRecentEmojiIdsV1(ids: string[]): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(RECENT_EMOJIS_V1_STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_RECENT_EMOJIS)));
  } catch {
    // Ignore storage quota errors
  }
}

export function resolveBuiltinEmojiId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("emoji:")) {
    const id = trimmed.slice("emoji:".length);
    if (VALID_EMOJI_ID_SET.has(id)) return id;
    return COMPACT_ID_MAP.get(id.replace(/[-_]/g, "").toLowerCase()) || null;
  }
  if (VALID_EMOJI_ID_SET.has(trimmed)) {
    return trimmed;
  }
  return (
    GLYPH_TO_EMOJI_ID.get(trimmed) ||
    COMPACT_ID_MAP.get(trimmed.replace(/[-_]/g, "").toLowerCase()) ||
    null
  );
}

interface RecentEmojisState {
  recentIds: string[];
  recordEmoji: (input: string) => void;
}

export const useRecentEmojisStore = create<RecentEmojisState>((set, get) => ({
  recentIds: loadRecentEmojiIdsV1(),
  recordEmoji: (input: string) => {
    const resolved = resolveBuiltinEmojiId(input);
    if (!resolved) return;
    const prev = get().recentIds;
    const next = [resolved, ...prev.filter((id) => id !== resolved)].slice(0, MAX_RECENT_EMOJIS);
    persistRecentEmojiIdsV1(next);
    set({ recentIds: next });
  },
}));
