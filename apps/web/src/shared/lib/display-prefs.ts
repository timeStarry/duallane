import { create } from "zustand";

export type DisplayPrefsScope = "device" | "account";

export interface DisplayPrefsValues {
  collapseImagesByDefault: boolean;
  collapseStickersByDefault: boolean;
  collapseLongMessagesByDefault: boolean;
}

export interface DisplayPrefsState extends DisplayPrefsValues {
  displayPrefsScope: DisplayPrefsScope;
  messageOverrides: Record<string, "collapsed" | "expanded">;
  setScope: (
    scope: DisplayPrefsScope,
    accountPrefs?: Record<string, unknown>,
    onSyncAccount?: (patch: Record<string, unknown>) => void
  ) => void;
  updateDisplayPref: (
    patch: Partial<DisplayPrefsValues>,
    onSyncAccount?: (patch: Record<string, unknown>) => void
  ) => void;
  hydrateFromAccountPreferences: (rawUserPrefs?: Record<string, unknown>) => void;
  setMessageOverride: (messageId: string, state: "collapsed" | "expanded" | null) => void;
  toggleMessageCollapse: (messageId: string, currentlyCollapsed: boolean) => void;
}

export const DISPLAY_PREFS_STORAGE_KEY = "dl_display_prefs_v1";
export const MESSAGE_COLLAPSE_OVERRIDES_KEY = "dl_collapsed_msg_overrides_v1";

const DEFAULT_VALUES: DisplayPrefsValues = {
  collapseImagesByDefault: false,
  collapseStickersByDefault: false,
  collapseLongMessagesByDefault: false,
};

function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const s = window.localStorage;
    return s && typeof s.getItem === "function" ? s : null;
  } catch {
    return null;
  }
}

interface StoredDevicePayload extends DisplayPrefsValues {
  displayPrefsScope: DisplayPrefsScope;
}

function loadStoredDevicePrefs(): StoredDevicePayload {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return { ...DEFAULT_VALUES, displayPrefsScope: "device" };
  }
  try {
    const raw = storage.getItem(DISPLAY_PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VALUES, displayPrefsScope: "device" };
    const parsed = JSON.parse(raw) as Partial<StoredDevicePayload>;
    return {
      collapseImagesByDefault: Boolean(parsed.collapseImagesByDefault),
      collapseStickersByDefault: Boolean(parsed.collapseStickersByDefault),
      collapseLongMessagesByDefault: Boolean(parsed.collapseLongMessagesByDefault),
      displayPrefsScope: parsed.displayPrefsScope === "account" ? "account" : "device",
    };
  } catch {
    return { ...DEFAULT_VALUES, displayPrefsScope: "device" };
  }
}

function saveStoredDevicePrefs(payload: StoredDevicePayload): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(DISPLAY_PREFS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota errors
  }
}

function loadStoredOverrides(): Record<string, "collapsed" | "expanded"> {
  const storage = getSafeLocalStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(MESSAGE_COLLAPSE_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, "collapsed" | "expanded"> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === "collapsed" || v === "expanded") {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveStoredOverrides(overrides: Record<string, "collapsed" | "expanded">): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    const entries = Object.entries(overrides).slice(-400);
    storage.setItem(MESSAGE_COLLAPSE_OVERRIDES_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Ignore
  }
}

function extractAccountDisplayPrefs(
  rawUserPrefs?: Record<string, unknown>
): Partial<DisplayPrefsValues> | null {
  if (!rawUserPrefs || typeof rawUserPrefs !== "object") return null;
  const sub = rawUserPrefs.displayPrefs;
  if (sub && typeof sub === "object" && !Array.isArray(sub)) {
    const obj = sub as Record<string, unknown>;
    return {
      collapseImagesByDefault: Boolean(obj.collapseImagesByDefault),
      collapseStickersByDefault: Boolean(obj.collapseStickersByDefault),
      collapseLongMessagesByDefault: Boolean(obj.collapseLongMessagesByDefault),
    };
  }
  return null;
}

const initial = loadStoredDevicePrefs();

export const useDisplayPrefsStore = create<DisplayPrefsState>((set, get) => ({
  collapseImagesByDefault: initial.collapseImagesByDefault,
  collapseStickersByDefault: initial.collapseStickersByDefault,
  collapseLongMessagesByDefault: initial.collapseLongMessagesByDefault,
  displayPrefsScope: initial.displayPrefsScope,
  messageOverrides: loadStoredOverrides(),

  setScope: (scope, accountPrefs, onSyncAccount) => {
    const cur = get();
    if (scope === "account") {
      const remote = extractAccountDisplayPrefs(accountPrefs);
      const nextValues: DisplayPrefsValues = remote
        ? {
            collapseImagesByDefault: Boolean(remote.collapseImagesByDefault),
            collapseStickersByDefault: Boolean(remote.collapseStickersByDefault),
            collapseLongMessagesByDefault: Boolean(remote.collapseLongMessagesByDefault),
          }
        : {
            collapseImagesByDefault: cur.collapseImagesByDefault,
            collapseStickersByDefault: cur.collapseStickersByDefault,
            collapseLongMessagesByDefault: cur.collapseLongMessagesByDefault,
          };
      saveStoredDevicePrefs({ ...nextValues, displayPrefsScope: "account" });
      set({ ...nextValues, displayPrefsScope: "account" });
      if (!remote && onSyncAccount) {
        onSyncAccount({ displayPrefs: nextValues });
      }
    } else {
      const nextPayload: StoredDevicePayload = {
        collapseImagesByDefault: cur.collapseImagesByDefault,
        collapseStickersByDefault: cur.collapseStickersByDefault,
        collapseLongMessagesByDefault: cur.collapseLongMessagesByDefault,
        displayPrefsScope: "device",
      };
      saveStoredDevicePrefs(nextPayload);
      set({ displayPrefsScope: "device" });
    }
  },

  updateDisplayPref: (patch, onSyncAccount) => {
    const cur = get();
    const nextValues: DisplayPrefsValues = {
      collapseImagesByDefault:
        patch.collapseImagesByDefault ?? cur.collapseImagesByDefault,
      collapseStickersByDefault:
        patch.collapseStickersByDefault ?? cur.collapseStickersByDefault,
      collapseLongMessagesByDefault:
        patch.collapseLongMessagesByDefault ?? cur.collapseLongMessagesByDefault,
    };
    saveStoredDevicePrefs({
      ...nextValues,
      displayPrefsScope: cur.displayPrefsScope,
    });
    set(nextValues);
    if (cur.displayPrefsScope === "account" && onSyncAccount) {
      onSyncAccount({ displayPrefs: nextValues });
    }
  },

  hydrateFromAccountPreferences: (rawUserPrefs) => {
    if (get().displayPrefsScope !== "account") return;
    const remote = extractAccountDisplayPrefs(rawUserPrefs);
    if (!remote) return;
    const nextValues: DisplayPrefsValues = {
      collapseImagesByDefault: Boolean(remote.collapseImagesByDefault),
      collapseStickersByDefault: Boolean(remote.collapseStickersByDefault),
      collapseLongMessagesByDefault: Boolean(remote.collapseLongMessagesByDefault),
    };
    saveStoredDevicePrefs({ ...nextValues, displayPrefsScope: "account" });
    set(nextValues);
  },

  setMessageOverride: (messageId, state) => {
    if (!messageId) return;
    set((s) => {
      const next = { ...s.messageOverrides };
      if (!state) {
        delete next[messageId];
      } else {
        next[messageId] = state;
      }
      saveStoredOverrides(next);
      return { messageOverrides: next };
    });
  },

  toggleMessageCollapse: (messageId, currentlyCollapsed) => {
    if (!messageId) return;
    get().setMessageOverride(messageId, currentlyCollapsed ? "expanded" : "collapsed");
  },
}));

export const LONG_MESSAGE_LINE_THRESHOLD = 12;
export const LONG_MESSAGE_CHAR_THRESHOLD = 600;

export function analyzeLongMessage(text: string): {
  isLong: boolean;
  lineCount: number;
  previewText: string;
} {
  if (!text) {
    return { isLong: false, lineCount: 0, previewText: "" };
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const rawLineCount = lines.length;
  const isLong =
    rawLineCount > LONG_MESSAGE_LINE_THRESHOLD ||
    normalized.length > LONG_MESSAGE_CHAR_THRESHOLD;

  if (!isLong) {
    return { isLong: false, lineCount: rawLineCount, previewText: normalized };
  }

  const effectiveLineCount = Math.max(
    rawLineCount,
    Math.ceil(normalized.length / 50)
  );
  let preview = lines.slice(0, 6).join("\n");
  if (preview.length > 280) {
    preview = `${preview.slice(0, 280).trimEnd()}…`;
  } else if (lines.length > 6) {
    preview = `${preview.trimEnd()}…`;
  }
  return {
    isLong: true,
    lineCount: effectiveLineCount,
    previewText: preview,
  };
}
