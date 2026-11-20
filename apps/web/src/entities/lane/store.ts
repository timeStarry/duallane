import { create } from "zustand";
import { extractP2PRoomFromUrl, scrubP2PRoomFromUrl } from "@/shared/lib/p2p-lane";

export type LaneId = "workspace" | "p2p";
export type EntryView = "entry" | "workspace";
export type ThemeMode = "system" | "light" | "dark";
export type SettingsTab = "appearance" | "profile" | "emotes" | "devices" | "qr" | "space" | "bots";
export type SpaceAdminTab =
  | "overview"
  | "members"
  | "invites"
  | "storage"
  | "announcement"
  | "mobile"
  | "mail";
export type InspectorTab = "thread" | "details" | "file";

export interface LightboxItem {
  id: string;
  url: string;
  downloadUrl?: string;
  fileName: string;
  mimeType: string;
  byteSize?: number;
  width?: number;
  height?: number;
  sourceMessageId?: string;
  conversationId?: string;
}

interface LaneUIState {
  activeLane: LaneId;
  entryView: EntryView;
  mobileView: "list" | "chat";
  themeMode: ThemeMode;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  inspectorThreadRootId: string | null;
  inspectorFile: LightboxItem | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  pendingBotSetupId: string;
  pendingSharedEmotePackId: string;
  adminConsoleOpen: boolean;
  adminConsoleTab: SpaceAdminTab;
  searchOpen: boolean;
  contactsOpen: boolean;
  lightboxOpen: boolean;
  lightboxItems: LightboxItem[];
  lightboxIndex: number;

  setActiveLane: (lane: LaneId) => void;
  setEntryView: (view: EntryView, pushHistory?: boolean) => void;
  setMobileView: (view: "list" | "chat") => void;
  setThemeMode: (mode: ThemeMode) => void;
  openThreadInspector: (rootMessageId: string) => void;
  openDetailsInspector: () => void;
  openFileInspector: (file: LightboxItem) => void;
  closeInspector: () => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setPendingBotSetupId: (setupId: string) => void;
  setPendingSharedEmotePackId: (shareId: string) => void;
  openAdminConsole: (tab?: SpaceAdminTab) => void;
  closeAdminConsole: () => void;
  setAdminConsoleTab: (tab: SpaceAdminTab) => void;
  setSearchOpen: (open: boolean) => void;
  setContactsOpen: (open: boolean) => void;
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

export function inferLaneFromLocation(
  loc: Partial<Pick<Location, "pathname" | "search" | "hash">> | undefined =
    typeof window !== "undefined" ? window.location : undefined
): LaneId {
  if (!loc) return "workspace";
  const pathname = loc.pathname || "/";
  if (
    pathname === "/direct" ||
    pathname.startsWith("/direct/") ||
    pathname.startsWith("/r/")
  ) {
    return "p2p";
  }
  if (loc.search) {
    const laneParam = new URLSearchParams(loc.search).get("lane");
    if (laneParam === "p2p" || laneParam === "direct") {
      return "p2p";
    }
  }
  return "workspace";
}

export function inferMobileViewFromLocation(
  loc: Partial<Pick<Location, "pathname">> | undefined =
    typeof window !== "undefined" ? window.location : undefined
): "list" | "chat" {
  if (!loc) return "chat";
  const pathname = loc.pathname || "/";
  if (pathname === "/direct") {
    return "list";
  }
  return "chat";
}

export function inferEntryViewFromLocation(
  loc: Partial<Pick<Location, "pathname" | "search">> | undefined =
    typeof window !== "undefined" ? window.location : undefined
): EntryView {
  if (!loc) return "entry";
  const pathname = loc.pathname || "/";
  if (pathname === "/workspace" || pathname.startsWith("/workspace/")) {
    return "workspace";
  }
  if (loc.search) {
    const params = new URLSearchParams(loc.search);
    if (
      params.get("lane") === "workspace" ||
      params.has("invite") ||
      params.has("setup") ||
      params.has("error") ||
      params.has("authError")
    ) {
      return "workspace";
    }
  }
  return "entry";
}

export function extractBotSetupIdFromLocation(
  loc: Partial<Pick<Location, "search">> | undefined =
    typeof window !== "undefined" ? window.location : undefined
): string {
  if (!loc?.search) return "";
  const raw = (new URLSearchParams(loc.search).get("setup") || "").trim();
  return /^setup_[A-Za-z0-9_-]{8,}$/u.test(raw) ? raw : "";
}

export function extractSharedEmotePackIdFromLocation(
  loc: Partial<Pick<Location, "pathname">> | undefined =
    typeof window !== "undefined" ? window.location : undefined
): string {
  const pathname = loc?.pathname || "";
  const match = /^\/workspace\/emotes\/shared\/([A-Za-z0-9_-]{8,128})\/?$/u.exec(pathname);
  return match ? match[1] : "";
}

export const useLaneStore = create<LaneUIState>((set, get) => ({
  activeLane: inferLaneFromLocation(),
  entryView: inferEntryViewFromLocation(),
  mobileView: inferMobileViewFromLocation(),
  themeMode: "system",
  inspectorOpen: false,
  inspectorTab: "details",
  inspectorThreadRootId: null,
  inspectorFile: null,
  settingsOpen: false,
  settingsTab: "appearance",
  pendingBotSetupId: extractBotSetupIdFromLocation(),
  pendingSharedEmotePackId: extractSharedEmotePackIdFromLocation(),
  adminConsoleOpen: false,
  adminConsoleTab: "overview",
  searchOpen: false,
  contactsOpen: false,
  lightboxOpen: false,
  lightboxItems: [],
  lightboxIndex: 0,

  setActiveLane: (activeLane) => {
    if (typeof window !== "undefined" && window.location && window.history?.replaceState) {
      if (activeLane === "workspace") {
        const pathname = window.location.pathname || "/";
        const search = window.location.search || "";
        if (pathname === "/direct" || pathname.startsWith("/direct/") || pathname.startsWith("/r/")) {
          window.history.replaceState(null, "", `/workspace${search}`);
        } else {
          scrubP2PRoomFromUrl(`/workspace${search}`);
        }
      } else {
        const existingRoomInUrl = window.location.pathname
          ? extractP2PRoomFromUrl(window.location)
          : null;
        if (!existingRoomInUrl && window.location.pathname !== "/direct") {
          window.history.replaceState(null, "", "/direct");
        }
      }
    }
    set(activeLane === "workspace" ? { activeLane, entryView: "workspace" } : { activeLane });
  },
  setEntryView: (entryView, pushHistory = false) => {
    if (typeof window !== "undefined" && window.location) {
      const search = entryView === "workspace" ? window.location.search || "" : "";
      const targetUrl = entryView === "workspace" ? `/workspace${search}` : "/";
      const currentUrl = `${window.location.pathname || "/"}${window.location.search || ""}${window.location.hash || ""}`;
      if (currentUrl !== targetUrl) {
        if (pushHistory && window.history?.pushState) {
          window.history.pushState(null, "", targetUrl);
        } else {
          window.history?.replaceState?.(null, "", targetUrl);
        }
      }
    }
    set({ activeLane: "workspace", entryView });
  },
  setMobileView: (mobileView) => {
    if (mobileView === "list") {
      const targetPath = get().activeLane === "p2p" ? "/direct" : "/workspace";
      scrubP2PRoomFromUrl(targetPath);
    }
    set({ mobileView });
  },
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
  setPendingBotSetupId: (pendingBotSetupId) => {
    if (
      !pendingBotSetupId &&
      typeof window !== "undefined" &&
      window.location?.search &&
      window.history?.replaceState
    ) {
      const params = new URLSearchParams(window.location.search);
      if (params.has("setup")) {
        params.delete("setup");
        const rest = params.toString();
        const nextUrl = `${window.location.pathname || "/workspace"}${rest ? `?${rest}` : ""}${window.location.hash || ""}`;
        window.history.replaceState(null, "", nextUrl);
      }
    }
    set({ pendingBotSetupId });
  },
  setPendingSharedEmotePackId: (pendingSharedEmotePackId) => set({ pendingSharedEmotePackId }),
  openAdminConsole: (tab) =>
    set((s) => ({
      adminConsoleOpen: true,
      adminConsoleTab: tab || s.adminConsoleTab,
      settingsOpen: false,
    })),
  closeAdminConsole: () => set({ adminConsoleOpen: false }),
  setAdminConsoleTab: (adminConsoleTab) => set({ adminConsoleTab }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setContactsOpen: (contactsOpen) => set({ contactsOpen }),
  openLightbox: (lightboxItems, lightboxIndex) =>
    set({ lightboxOpen: true, lightboxItems, lightboxIndex }),
  closeLightbox: () => set({ lightboxOpen: false }),
  setLightboxIndex: (lightboxIndex) => set({ lightboxIndex }),
}));
