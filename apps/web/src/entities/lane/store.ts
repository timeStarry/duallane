import { create } from "zustand";

export type LaneId = "workspace" | "p2p";
export type ThemeMode = "system" | "light" | "dark";
export type SettingsTab = "appearance" | "profile" | "devices" | "qr" | "space" | "bots";
export type InspectorTab = "thread" | "details" | "file";

export interface LightboxItem {
  id: string;
  url: string;
  fileName: string;
  mimeType: string;
  width?: number;
  height?: number;
  sourceMessageId?: string;
  conversationId?: string;
}

interface LaneUIState {
  activeLane: LaneId;
  themeMode: ThemeMode;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  inspectorThreadRootId: string | null;
  inspectorFile: LightboxItem | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  searchOpen: boolean;
  lightboxOpen: boolean;
  lightboxItems: LightboxItem[];
  lightboxIndex: number;

  setActiveLane: (lane: LaneId) => void;
  setThemeMode: (mode: ThemeMode) => void;
  openThreadInspector: (rootMessageId: string) => void;
  openDetailsInspector: () => void;
  openFileInspector: (file: LightboxItem) => void;
  closeInspector: () => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setSearchOpen: (open: boolean) => void;
  openLightbox: (items: LightboxItem[], index: number) => void;
  closeLightbox: () => void;
  setLightboxIndex: (index: number) => void;
}

function applyThemeToDocument(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (mode === "system") {
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    root.dataset.theme = prefersDark ? "dark" : "light";
  } else {
    root.dataset.theme = mode;
  }
}

export const useLaneStore = create<LaneUIState>((set) => ({
  activeLane: "workspace",
  themeMode: "system",
  inspectorOpen: false,
  inspectorTab: "details",
  inspectorThreadRootId: null,
  inspectorFile: null,
  settingsOpen: false,
  settingsTab: "appearance",
  searchOpen: false,
  lightboxOpen: false,
  lightboxItems: [],
  lightboxIndex: 0,

  setActiveLane: (activeLane) => set({ activeLane }),
  setThemeMode: (themeMode) => {
    applyThemeToDocument(themeMode);
    set({ themeMode });
  },
  openThreadInspector: (rootMessageId) =>
    set({
      inspectorOpen: true,
      inspectorTab: "thread",
      inspectorThreadRootId: rootMessageId,
    }),
  openDetailsInspector: () =>
    set({
      inspectorOpen: true,
      inspectorTab: "details",
    }),
  openFileInspector: (file) =>
    set({
      inspectorOpen: true,
      inspectorTab: "file",
      inspectorFile: file,
    }),
  closeInspector: () => set({ inspectorOpen: false }),
  openSettings: (tab) =>
    set((s) => ({
      settingsOpen: true,
      settingsTab: tab || s.settingsTab,
    })),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  openLightbox: (lightboxItems, lightboxIndex) =>
    set({ lightboxOpen: true, lightboxItems, lightboxIndex }),
  closeLightbox: () => set({ lightboxOpen: false }),
  setLightboxIndex: (lightboxIndex) => set({ lightboxIndex }),
}));
