import { create } from "zustand";
import {
  apiV1,
  type CustomEmoteDTO,
  type EmoteCollectionDTO,
  type EmoteCollectionShareDetailDTO,
  type EmoteLibraryDTO,
  type EmoteSettingsDTO,
} from "@/shared/lib/api-v1";
import { visibleEmotePacks } from "@/emotes";

const DEFAULT_ENABLED_PACK_IDS = visibleEmotePacks
  .filter((p) => p.defaultEnabled !== false)
  .map((p) => p.id);

const EMPTY_LIBRARY: EmoteLibraryDTO = {
  entries: [],
  emotes: [],
  collections: [],
  usage: {
    itemCount: 0,
    totalBytes: 0,
    subscribedItemCount: 0,
    subscribedTotalBytes: 0,
    totalItemCount: 0,
    allTotalBytes: 0,
    collectionCount: 0,
    subscribedCollectionCount: 0,
    overLimit: false,
  },
  limits: {
    maxItems: null,
    maxTotalBytes: 1024 * 1024 * 1024,
    maxInputBytes: 10 * 1024 * 1024,
    maxCollections: null,
    maxCollectionItems: 100,
    maxBatchItems: 50,
  },
};

const DEFAULT_SETTINGS: EmoteSettingsDTO = {
  availablePacks: visibleEmotePacks.map((p) => ({
    id: p.id,
    label: p.label,
    defaultEnabled: p.defaultEnabled !== false,
  })),
  enabledPackIds: DEFAULT_ENABLED_PACK_IDS,
  clickImageEmoteToSend: true,
  replyAutoMention: false,
  minimumEnabled: 1,
};

const PREVIEW_CUSTOM_EMOTES: CustomEmoteDTO[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "image",
    label: "摸鱼狗头",
    token: "[custom:00000000-0000-4000-8000-000000000001]",
    src: "/emotes/bili/doge.png",
    animated: false,
    byteSize: 8192,
    createdAt: "2026-11-14T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    kind: "image",
    label: "大哭",
    token: "[custom:00000000-0000-4000-8000-000000000002]",
    src: "/emotes/bili/daku.png",
    animated: false,
    byteSize: 9216,
    createdAt: "2026-11-14T00:01:00.000Z",
  },
];

const PREVIEW_COLLECTIONS: EmoteCollectionDTO[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "摸鱼日常包",
    sourceCollectionId: null,
    originalCreatorUserId: "usr_me",
    originalCreator: { id: "usr_me", displayName: "星辰" },
    revision: 1,
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    sourceSubscription: {
      eligible: false,
      enabled: false,
      status: "off",
      readOnly: false,
    },
    items: PREVIEW_CUSTOM_EMOTES,
    itemCount: 2,
  },
];

let inflightLoad: Promise<void> | null = null;

const EMOTE_TAB_ORDER_STORAGE_KEY = "duallane:v1:emote-tab-order";

function loadStoredTabOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(EMOTE_TAB_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(String).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function persistStoredTabOrder(order: string[]): void {
  if (typeof window === "undefined") return;
  try {
    if (order.length === 0) {
      window.localStorage.removeItem(EMOTE_TAB_ORDER_STORAGE_KEY);
    } else {
      window.localStorage.setItem(EMOTE_TAB_ORDER_STORAGE_KEY, JSON.stringify(order));
    }
  } catch {
    // Ignore quota / privacy errors
  }
}

export function resolveOrderedPickerTabKeys(
  availableKeys: string[],
  tabOrder: string[]
): string[] {
  if (availableKeys.length <= 1) return [...availableKeys];
  const availableSet = new Set(availableKeys);
  const explicit = tabOrder.filter((key, idx) => availableSet.has(key) && tabOrder.indexOf(key) === idx);
  if (explicit.length === 0) return [...availableKeys];

  const explicitSet = new Set(explicit);
  const unseen = availableKeys.filter((k) => !explicitSet.has(k));
  if (unseen.length === 0) return explicit;

  const unseenCustomPacks = unseen.filter((k) => k.startsWith("pack:"));
  const unseenOthers = unseen.filter((k) => !k.startsWith("pack:"));
  const result = [...explicit];

  if (unseenCustomPacks.length > 0) {
    const favIndex = result.indexOf("favorites");
    const insertAt = favIndex >= 0 ? favIndex + 1 : 0;
    result.splice(insertAt, 0, ...unseenCustomPacks);
  }
  result.push(...unseenOthers);
  return result;
}

export type StudioTab = "packs" | "create" | "favorites" | "builtin";

export interface EmoteStoreState {
  hydrated: boolean;
  loading: boolean;
  library: EmoteLibraryDTO;
  settings: EmoteSettingsDTO;
  tabOrder: string[];

  // Telegram-style Shared Pack Preview Modal state
  activeSharedPackId: string | null;
  sharedPackDetail: EmoteCollectionShareDetailDTO | null;
  sharedPackLoading: boolean;
  sharedPackError: string;

  // Sticker & Pack Studio Modal state
  studioOpen: boolean;
  studioTab: StudioTab;
  studioSelectedPackId: string;

  // Quick toast / status banner for sticker actions (e.g. "已收藏到我的贴纸")
  toastMessage: string;

  showToast: (msg: string) => void;
  hydrateForPreview: () => void;
  loadEmoteState: (isPreviewMode?: boolean, force?: boolean) => Promise<void>;
  refreshLibrary: (isPreviewMode?: boolean) => Promise<void>;
  updateSettingsPatch: (
    patch: {
      enabledPackIds?: string[];
      clickImageEmoteToSend?: boolean;
      replyAutoMention?: boolean;
    },
    isPreviewMode?: boolean
  ) => Promise<void>;
  uploadStickers: (
    files: File[],
    options?: { collectionId?: string; addToLibrary?: boolean },
    isPreviewMode?: boolean
  ) => Promise<{ uploaded: CustomEmoteDTO[]; failed: string[] }>;
  createPackWithFiles: (
    name: string,
    files: File[],
    existingEmoteIds?: string[],
    isPreviewMode?: boolean
  ) => Promise<EmoteCollectionDTO | null>;
  favoriteFromMessage: (
    input: {
      messageId: string;
      customEmoteId?: string;
      attachmentId?: string;
      emoteKey?: string;
    },
    targetCollectionId?: string,
    isPreviewMode?: boolean
  ) => Promise<CustomEmoteDTO | null>;
  renamePack: (collectionId: string, name: string, isPreviewMode?: boolean) => Promise<void>;
  deletePack: (
    collectionId: string,
    disposition?: "keep" | "remove",
    isPreviewMode?: boolean
  ) => Promise<void>;
  addStickersToPack: (
    collectionId: string,
    emoteIds: string[],
    isPreviewMode?: boolean
  ) => Promise<void>;
  removeStickerFromPack: (
    collectionId: string,
    emoteId: string,
    isPreviewMode?: boolean
  ) => Promise<void>;
  renameSticker: (emoteId: string, label: string, isPreviewMode?: boolean) => Promise<void>;
  deleteSticker: (emoteId: string, isPreviewMode?: boolean) => Promise<void>;
  togglePackSubscription: (
    collectionId: string,
    enabled: boolean,
    isPreviewMode?: boolean
  ) => Promise<void>;
  createPackShare: (
    collectionId: string,
    isPreviewMode?: boolean
  ) => Promise<EmoteCollectionShareDetailDTO | null>;

  openSharedPack: (shareId: string, isPreviewMode?: boolean) => Promise<void>;
  closeSharedPack: () => void;
  importSharedPack: (
    shareId: string,
    options: {
      asCollection: boolean;
      subscribeToSourceChanges?: boolean;
      emoteIds?: string[];
      collectionName?: string;
    },
    isPreviewMode?: boolean
  ) => Promise<boolean>;

  openStudio: (tab?: StudioTab, packId?: string) => void;
  closeStudio: () => void;
  setStudioTab: (tab: StudioTab) => void;
  setStudioSelectedPackId: (packId: string) => void;
  hydrateTabOrderFromPreferences: (rawOrder: unknown) => void;
  setTabOrder: (
    nextOrder: string[],
    onPersistPreferences?: (order: string[]) => void
  ) => void;
  moveTabOrder: (
    tabKey: string,
    direction: "left" | "right" | "top",
    availableKeys: string[],
    onPersistPreferences?: (order: string[]) => void
  ) => void;
  reorderTabBefore: (
    draggedKey: string,
    targetKey: string,
    availableKeys: string[],
    onPersistPreferences?: (order: string[]) => void
  ) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function selectFavoriteEmotes(entries: EmoteLibraryDTO["entries"]): CustomEmoteDTO[] {
  return entries.flatMap((entry) => (entry.type === "emote" && entry.emote ? [entry.emote] : []));
}

export function resolveCustomEmoteSrc(emote: Pick<CustomEmoteDTO, "id" | "src">): string {
  return emote.src || `/api/workspace/emotes/${encodeURIComponent(emote.id)}/content`;
}

function previewFavoriteEntry(emote: CustomEmoteDTO): EmoteLibraryDTO["entries"][number] {
  return { type: "emote", id: emote.id, emote };
}

export const useEmoteStore = create<EmoteStoreState>((set, get) => ({
  hydrated: false,
  loading: false,
  library: EMPTY_LIBRARY,
  settings: DEFAULT_SETTINGS,
  tabOrder: loadStoredTabOrder(),

  activeSharedPackId: null,
  sharedPackDetail: null,
  sharedPackLoading: false,
  sharedPackError: "",

  studioOpen: false,
  studioTab: "packs",
  studioSelectedPackId: "",

  toastMessage: "",

  showToast: (msg) => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toastMessage: msg });
    if (msg) {
      toastTimer = setTimeout(() => {
        set((s) => (s.toastMessage === msg ? { toastMessage: "" } : s));
      }, 2400);
    }
  },

  hydrateForPreview: () => {
    set({
      hydrated: true,
      loading: false,
      library: {
        ...EMPTY_LIBRARY,
        entries: PREVIEW_CUSTOM_EMOTES.map(previewFavoriteEntry),
        emotes: PREVIEW_CUSTOM_EMOTES,
        collections: PREVIEW_COLLECTIONS,
        usage: {
          ...EMPTY_LIBRARY.usage,
          itemCount: PREVIEW_CUSTOM_EMOTES.length,
          totalBytes: 17408,
          collectionCount: PREVIEW_COLLECTIONS.length,
        },
      },
      settings: DEFAULT_SETTINGS,
    });
  },

  loadEmoteState: async (isPreviewMode = false, force = false) => {
    if (isPreviewMode) {
      get().hydrateForPreview();
      return;
    }
    if (get().hydrated && !force) return;
    if (inflightLoad && !force) return inflightLoad;

    set({ loading: true });
    const run = Promise.all([
      apiV1.getEmoteSettings().catch(() => ({ settings: DEFAULT_SETTINGS })),
      apiV1.getEmoteLibrary().catch(() => EMPTY_LIBRARY),
    ])
      .then(([settingsRes, lib]) => {
        const rawSettings = settingsRes?.settings || DEFAULT_SETTINGS;
        const enabledPackIds =
          Array.isArray(rawSettings.enabledPackIds) && rawSettings.enabledPackIds.length > 0
            ? rawSettings.enabledPackIds
            : DEFAULT_ENABLED_PACK_IDS;
        set({
          hydrated: true,
          loading: false,
          settings: {
            ...DEFAULT_SETTINGS,
            ...rawSettings,
            enabledPackIds,
          },
          library: {
            ...EMPTY_LIBRARY,
            ...lib,
            emotes: Array.isArray(lib?.emotes) ? lib.emotes : [],
            collections: Array.isArray(lib?.collections) ? lib.collections : [],
            entries: Array.isArray(lib?.entries) ? lib.entries : [],
          },
        });
      })
      .finally(() => {
        inflightLoad = null;
      });

    inflightLoad = run;
    return run;
  },

  refreshLibrary: async (isPreviewMode = false) => {
    if (isPreviewMode) return;
    try {
      const lib = await apiV1.getEmoteLibrary();
      set({
        hydrated: true,
        library: {
          ...EMPTY_LIBRARY,
          ...lib,
          emotes: Array.isArray(lib?.emotes) ? lib.emotes : [],
          collections: Array.isArray(lib?.collections) ? lib.collections : [],
          entries: Array.isArray(lib?.entries) ? lib.entries : [],
        },
      });
    } catch {
      // Non-fatal
    }
  },

  updateSettingsPatch: async (patch, isPreviewMode = false) => {
    const prev = get().settings;
    set({ settings: { ...prev, ...patch } });
    if (isPreviewMode) return;
    try {
      const res = await apiV1.updateEmoteSettings(patch);
      if (res.settings) {
        set({ settings: { ...prev, ...res.settings } });
      }
    } catch {
      set({ settings: prev });
    }
  },

  uploadStickers: async (files, options, isPreviewMode = false) => {
    const uploaded: CustomEmoteDTO[] = [];
    const failed: string[] = [];
    if (files.length === 0) return { uploaded, failed };

    if (isPreviewMode) {
      for (const file of files) {
        const id = crypto.randomUUID();
        const label = file.name.replace(/\.[^.]+$/, "").slice(0, 16) || "贴纸";
        const item: CustomEmoteDTO = {
          id,
          kind: "image",
          label,
          token: `[custom:${id}]`,
          src: URL.createObjectURL(file),
          animated: file.type === "image/gif",
          byteSize: file.size,
          createdAt: new Date().toISOString(),
        };
        uploaded.push(item);
      }
      set((s) => {
        const addToFavorites = !options?.collectionId || options.addToLibrary !== false;
        const nextEmotes = addToFavorites ? [...uploaded, ...s.library.emotes] : s.library.emotes;
        const nextCollections = options?.collectionId
          ? s.library.collections.map((c) =>
              c.id === options.collectionId
                ? { ...c, items: [...c.items, ...uploaded], itemCount: c.items.length + uploaded.length }
                : c
            )
          : s.library.collections;
        return {
          library: {
            ...s.library,
            entries: addToFavorites
              ? [...uploaded.map(previewFavoriteEntry), ...s.library.entries]
              : s.library.entries,
            emotes: nextEmotes,
            collections: nextCollections,
          },
        };
      });
      return { uploaded, failed };
    }

    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, files.length) }, async () => {
        while (cursor < files.length) {
          const file = files[cursor++];
          try {
            const res = await apiV1.uploadCustomEmote(file, options);
            if (res.emote) uploaded.push(res.emote);
          } catch (err) {
            failed.push(`${file.name}：${err instanceof Error ? err.message : "上传失败"}`);
          }
        }
      })
    );
    await get().refreshLibrary(false);
    return { uploaded, failed };
  },

  createPackWithFiles: async (name, files, existingEmoteIds = [], isPreviewMode = false) => {
    const trimmed = name.trim();
    if (!trimmed) return null;

    if (isPreviewMode) {
      const id = crypto.randomUUID();
      const existingItems = get().library.emotes.filter((e) => existingEmoteIds.includes(e.id));
      const created: EmoteCollectionDTO = {
        id,
        name: trimmed,
        sourceCollectionId: null,
        originalCreatorUserId: "usr_me",
        originalCreator: { id: "usr_me", displayName: "我" },
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceSubscription: { eligible: false, enabled: false, status: "off", readOnly: false },
        items: existingItems,
        itemCount: existingItems.length,
      };
      set((s) => ({
        library: {
          ...s.library,
          collections: [created, ...s.library.collections],
        },
        studioSelectedPackId: id,
      }));
      if (files.length > 0) {
        await get().uploadStickers(files, { collectionId: id, addToLibrary: false }, true);
      }
      return get().library.collections.find((c) => c.id === id) || created;
    }

    const res = await apiV1.createEmoteCollection(trimmed, existingEmoteIds);
    const created = res.collection;
    if (files.length > 0 && created?.id) {
      await get().uploadStickers(files, { collectionId: created.id, addToLibrary: false }, false);
    } else {
      await get().refreshLibrary(false);
    }
    set({ studioSelectedPackId: created.id });
    return get().library.collections.find((c) => c.id === created.id) || created;
  },

  favoriteFromMessage: async (input, targetCollectionId, isPreviewMode = false) => {
    if (isPreviewMode) {
      const item = PREVIEW_CUSTOM_EMOTES[0];
      get().showToast(targetCollectionId ? "已收入表情包" : "已收藏到我的贴纸");
      return item;
    }
    const res = await apiV1.favoriteMessageEmote(input);
    const emote = res.emote;
    if (emote && targetCollectionId) {
      await apiV1.addEmotesToCollection(targetCollectionId, [emote.id]);
    }
    await get().refreshLibrary(false);
    get().showToast(targetCollectionId ? "已收藏并收入表情包" : "已收藏到我的贴纸");
    return emote || null;
  },

  renamePack: async (collectionId, name, isPreviewMode = false) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (isPreviewMode) {
      set((s) => ({
        library: {
          ...s.library,
          collections: s.library.collections.map((c) =>
            c.id === collectionId ? { ...c, name: trimmed } : c
          ),
        },
      }));
      return;
    }
    await apiV1.renameEmoteCollection(collectionId, trimmed);
    await get().refreshLibrary(false);
  },

  deletePack: async (collectionId, disposition = "keep", isPreviewMode = false) => {
    if (isPreviewMode) {
      set((s) => ({
        library: {
          ...s.library,
          collections: s.library.collections.filter((c) => c.id !== collectionId),
        },
        studioSelectedPackId:
          s.studioSelectedPackId === collectionId ? "" : s.studioSelectedPackId,
      }));
      return;
    }
    await apiV1.deleteEmoteCollection(collectionId, disposition);
    if (get().studioSelectedPackId === collectionId) {
      set({ studioSelectedPackId: "" });
    }
    await get().refreshLibrary(false);
  },

  addStickersToPack: async (collectionId, emoteIds, isPreviewMode = false) => {
    if (emoteIds.length === 0) return;
    if (isPreviewMode) {
      const additions = get().library.emotes.filter((e) => emoteIds.includes(e.id));
      set((s) => ({
        library: {
          ...s.library,
          collections: s.library.collections.map((c) => {
            if (c.id !== collectionId) return c;
            const merged = [
              ...c.items,
              ...additions.filter((a) => !c.items.some((x) => x.id === a.id)),
            ];
            return { ...c, items: merged, itemCount: merged.length };
          }),
        },
      }));
      return;
    }
    await apiV1.addEmotesToCollection(collectionId, emoteIds);
    await get().refreshLibrary(false);
  },

  removeStickerFromPack: async (collectionId, emoteId, isPreviewMode = false) => {
    if (isPreviewMode) {
      set((s) => ({
        library: {
          ...s.library,
          collections: s.library.collections.map((c) => {
            if (c.id !== collectionId) return c;
            const items = c.items.filter((x) => x.id !== emoteId);
            return { ...c, items, itemCount: items.length };
          }),
        },
      }));
      return;
    }
    await apiV1.removeEmoteFromCollection(collectionId, emoteId);
    await get().refreshLibrary(false);
  },

  renameSticker: async (emoteId, label, isPreviewMode = false) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    if (isPreviewMode) {
      set((s) => ({
        library: {
          ...s.library,
          entries: s.library.entries.map((entry) =>
            entry.type === "emote" && entry.emote?.id === emoteId
              ? { ...entry, emote: { ...entry.emote, label: trimmed } }
              : entry
          ),
          emotes: s.library.emotes.map((e) => (e.id === emoteId ? { ...e, label: trimmed } : e)),
        },
      }));
      return;
    }
    await apiV1.renameCustomEmote(emoteId, trimmed);
    await get().refreshLibrary(false);
  },

  deleteSticker: async (emoteId, isPreviewMode = false) => {
    if (isPreviewMode) {
      set((s) => ({
        library: {
          ...s.library,
          entries: s.library.entries.filter(
            (entry) => entry.type !== "emote" || entry.emote?.id !== emoteId
          ),
          emotes: s.library.emotes.filter((e) => e.id !== emoteId),
        },
      }));
      return;
    }
    await apiV1.deleteCustomEmote(emoteId);
    await get().refreshLibrary(false);
  },

  togglePackSubscription: async (collectionId, enabled, isPreviewMode = false) => {
    if (isPreviewMode) {
      set((s) => ({
        library: {
          ...s.library,
          collections: s.library.collections.map((c) =>
            c.id === collectionId
              ? {
                  ...c,
                  sourceSubscription: {
                    ...c.sourceSubscription,
                    enabled,
                    status: enabled ? "synced" : "paused",
                    readOnly: enabled,
                  },
                }
              : c
          ),
        },
      }));
      return;
    }
    const res = await apiV1.updateEmoteCollectionSubscription(collectionId, enabled);
    if (res.library) {
      set({
        library: {
          ...EMPTY_LIBRARY,
          ...res.library,
          entries: Array.isArray(res.library.entries) ? res.library.entries : [],
          emotes: Array.isArray(res.library.emotes) ? res.library.emotes : [],
          collections: Array.isArray(res.library.collections) ? res.library.collections : [],
        },
      });
    } else {
      await get().refreshLibrary(false);
    }
  },

  createPackShare: async (collectionId, isPreviewMode = false) => {
    if (isPreviewMode) {
      const pack = get().library.collections.find((c) => c.id === collectionId);
      if (!pack) return null;
      const shareId = "22222222-2222-4222-8222-222222222222";
      return {
        id: shareId,
        sourceCollectionId: pack.id,
        name: pack.name,
        itemCount: pack.itemCount,
        createdAt: new Date().toISOString(),
        sharedBy: { id: "usr_me", displayName: "星辰" },
        originalCreator: pack.originalCreator,
        canRevoke: true,
        canSubscribeToSourceChanges: true,
        covers: pack.items.slice(0, 4).map((i) => ({
          id: i.id,
          label: i.label,
          src: resolveCustomEmoteSrc(i),
          animated: i.animated,
        })),
        items: pack.items,
        sharePath: `/workspace/emotes/shared/${shareId}`,
      };
    }
    const res = await apiV1.createEmoteCollectionShare(collectionId);
    return res.share || null;
  },

  openSharedPack: async (shareId, isPreviewMode = false) => {
    const cleaned = shareId.trim();
    if (!cleaned) return;
    set({
      activeSharedPackId: cleaned,
      sharedPackDetail: null,
      sharedPackLoading: true,
      sharedPackError: "",
    });
    if (isPreviewMode) {
      const pack = PREVIEW_COLLECTIONS[0];
      set({
        sharedPackLoading: false,
        sharedPackDetail: {
          id: cleaned,
          sourceCollectionId: pack.id,
          name: pack.name,
          itemCount: pack.itemCount,
          createdAt: pack.createdAt,
          sharedBy: { id: "usr_me", displayName: "星辰" },
          originalCreator: pack.originalCreator,
          canRevoke: false,
          canSubscribeToSourceChanges: true,
          items: pack.items,
          sharePath: `/workspace/emotes/shared/${cleaned}`,
        },
      });
      return;
    }
    try {
      const res = await apiV1.getEmoteCollectionShare(cleaned);
      set({
        sharedPackLoading: false,
        sharedPackDetail: res.share || null,
      });
    } catch (err) {
      set({
        sharedPackLoading: false,
        sharedPackError: err instanceof Error ? err.message : "该表情包分享已失效或不存在",
      });
    }
  },

  closeSharedPack: () => {
    set({
      activeSharedPackId: null,
      sharedPackDetail: null,
      sharedPackLoading: false,
      sharedPackError: "",
    });
    if (
      typeof window !== "undefined" &&
      window.location.pathname.startsWith("/workspace/emotes/shared/")
    ) {
      window.history.replaceState(null, "", "/workspace");
    }
  },

  importSharedPack: async (shareId, options, isPreviewMode = false) => {
    if (isPreviewMode) {
      get().showToast(
        options.asCollection ? "已添加整套表情包到表情栏" : "已添加选中贴纸到收藏"
      );
      get().closeSharedPack();
      return true;
    }
    await apiV1.importEmoteCollectionShare(shareId, options);
    await get().refreshLibrary(false);
    get().showToast(
      options.asCollection ? "已添加整套表情包到表情栏" : "已添加选中贴纸到收藏"
    );
    get().closeSharedPack();
    return true;
  },

  openStudio: (tab = "packs", packId = "") => {
    set((s) => ({
      studioOpen: true,
      studioTab: tab,
      studioSelectedPackId: packId || s.studioSelectedPackId || s.library.collections[0]?.id || "",
    }));
  },

  closeStudio: () => set({ studioOpen: false }),
  setStudioTab: (tab) => set({ studioTab: tab }),
  setStudioSelectedPackId: (packId) => set({ studioSelectedPackId: packId }),

  hydrateTabOrderFromPreferences: (rawOrder) => {
    if (!Array.isArray(rawOrder)) return;
    const cleaned = rawOrder.map(String).filter(Boolean);
    if (cleaned.length > 0) {
      persistStoredTabOrder(cleaned);
      set({ tabOrder: cleaned });
    }
  },

  setTabOrder: (nextOrder, onPersistPreferences) => {
    const deduped = nextOrder.filter((key, idx) => Boolean(key) && nextOrder.indexOf(key) === idx);
    persistStoredTabOrder(deduped);
    set({ tabOrder: deduped });
    onPersistPreferences?.(deduped);
  },

  moveTabOrder: (tabKey, direction, availableKeys, onPersistPreferences) => {
    const ordered = resolveOrderedPickerTabKeys(availableKeys, get().tabOrder);
    const idx = ordered.indexOf(tabKey);
    if (idx < 0) return;
    const next = [...ordered];
    if (direction === "top") {
      if (idx === 0) return;
      next.splice(idx, 1);
      next.unshift(tabKey);
    } else if (direction === "left") {
      if (idx === 0) return;
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    } else if (direction === "right") {
      if (idx >= next.length - 1) return;
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    }
    get().setTabOrder(next, onPersistPreferences);
  },

  reorderTabBefore: (draggedKey, targetKey, availableKeys, onPersistPreferences) => {
    if (!draggedKey || !targetKey || draggedKey === targetKey) return;
    const ordered = resolveOrderedPickerTabKeys(availableKeys, get().tabOrder);
    const fromIdx = ordered.indexOf(draggedKey);
    const toIdx = ordered.indexOf(targetKey);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const next = [...ordered];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, draggedKey);
    get().setTabOrder(next, onPersistPreferences);
  },
}));
