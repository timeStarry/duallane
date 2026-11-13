import { create } from "zustand";
import { DESIGN_TOKENS, isAccentId, type AccentId, type ThemeMode, type ThemePreference } from "@duallane/design-tokens";

export type TransparencyMode = "glass" | "solid";

interface ThemeState {
  preference: ThemePreference;
  resolvedMode: ThemeMode;
  accent: AccentId;
  transparency: TransparencyMode;
  reducedMotion: boolean;
  setPreference: (preference: ThemePreference) => void;
  setAccent: (accent: AccentId) => void;
  setTransparency: (transparency: TransparencyMode) => void;
  setReducedMotion: (reduced: boolean) => void;
}

const STORAGE_KEY = "duallane-v1-appearance";

function resolveSystemMode(): ThemeMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readPersistedAppearance(): Partial<Pick<ThemeState, "preference" | "accent" | "transparency" | "reducedMotion">> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      preference: parsed.preference === "light" || parsed.preference === "dark" || parsed.preference === "system" ? parsed.preference : undefined,
      accent: isAccentId(parsed.accent) ? parsed.accent : undefined,
      transparency: parsed.transparency === "solid" ? "solid" : parsed.transparency === "glass" ? "glass" : undefined,
      reducedMotion: typeof parsed.reducedMotion === "boolean" ? parsed.reducedMotion : undefined
    };
  } catch {
    return {};
  }
}

function persistAppearance(state: Pick<ThemeState, "preference" | "accent" | "transparency" | "reducedMotion">) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota errors in restricted browsers.
  }
}

export function applyVibrancyTokensToRoot(mode: ThemeMode, accent: AccentId, transparency: TransparencyMode, reducedMotion: boolean) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const palette = DESIGN_TOKENS.modes[mode];
  const accentPalette = DESIGN_TOKENS.accents[accent];

  root.dataset.themeMode = mode;
  root.dataset.accent = accent;
  root.dataset.transparency = transparency;
  root.dataset.motion = reducedMotion ? "reduced" : "normal";
  root.style.colorScheme = mode;

  const vars: Record<string, string> = {
    "--dl-bg": palette.bg,
    "--dl-canvas-from": palette.canvasFrom,
    "--dl-canvas-to": palette.canvasTo,
    "--dl-surface": palette.surface,
    "--dl-soft": palette.soft,
    "--dl-glass-chrome": palette.glassChrome,
    "--dl-glass-elevated": palette.glassElevated,
    "--dl-glass-pill": palette.glassPill,
    "--dl-glass-highlight": palette.glassHighlight,
    "--dl-line": palette.line,
    "--dl-line-strong": palette.lineStrong,
    "--dl-text": palette.text,
    "--dl-muted": palette.muted,
    "--dl-control": palette.control,
    "--dl-focus": palette.focus,
    "--dl-backdrop": palette.backdrop,
    "--dl-shadow-menu": palette.shadowMenu,
    "--dl-shadow-dialog": palette.shadowDialog,
    "--dl-direct": palette.direct,
    "--dl-direct-soft": palette.directSoft,
    "--dl-on-direct": palette.onDirect,
    "--dl-shared": palette.shared,
    "--dl-shared-soft": palette.sharedSoft,
    "--dl-on-shared": palette.onShared,
    "--dl-accent": mode === "dark" ? accentPalette.dark : accentPalette.light,
    "--dl-accent-soft": mode === "dark" ? accentPalette.darkSoft : accentPalette.lightSoft,
    "--dl-success": palette.success,
    "--dl-success-soft": palette.successSoft,
    "--dl-warning": palette.warning,
    "--dl-warning-soft": palette.warningSoft,
    "--dl-danger": palette.danger,
    "--dl-danger-soft": palette.dangerSoft
  };

  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}

const initial = readPersistedAppearance();
const initialPreference: ThemePreference = initial.preference ?? "system";
const initialResolvedMode: ThemeMode = initialPreference === "system" ? resolveSystemMode() : initialPreference;
const initialAccent: AccentId = initial.accent ?? "azure";
const initialTransparency: TransparencyMode = initial.transparency ?? "glass";
const initialReducedMotion = initial.reducedMotion ?? (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: initialPreference,
  resolvedMode: initialResolvedMode,
  accent: initialAccent,
  transparency: initialTransparency,
  reducedMotion: initialReducedMotion,
  setPreference: (preference) => {
    const resolvedMode = preference === "system" ? resolveSystemMode() : preference;
    const { accent, transparency, reducedMotion } = get();
    applyVibrancyTokensToRoot(resolvedMode, accent, transparency, reducedMotion);
    persistAppearance({ preference, accent, transparency, reducedMotion });
    set({ preference, resolvedMode });
  },
  setAccent: (accent) => {
    const { preference, resolvedMode, transparency, reducedMotion } = get();
    applyVibrancyTokensToRoot(resolvedMode, accent, transparency, reducedMotion);
    persistAppearance({ preference, accent, transparency, reducedMotion });
    set({ accent });
  },
  setTransparency: (transparency) => {
    const { preference, resolvedMode, accent, reducedMotion } = get();
    applyVibrancyTokensToRoot(resolvedMode, accent, transparency, reducedMotion);
    persistAppearance({ preference, accent, transparency, reducedMotion });
    set({ transparency });
  },
  setReducedMotion: (reducedMotion) => {
    const { preference, resolvedMode, accent, transparency } = get();
    applyVibrancyTokensToRoot(resolvedMode, accent, transparency, reducedMotion);
    persistAppearance({ preference, accent, transparency, reducedMotion });
    set({ reducedMotion });
  }
}));

export function initializeV1Theme() {
  const state = useThemeStore.getState();
  applyVibrancyTokensToRoot(state.resolvedMode, state.accent, state.transparency, state.reducedMotion);
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => {
      const current = useThemeStore.getState();
      if (current.preference === "system") {
        const nextMode = resolveSystemMode();
        applyVibrancyTokensToRoot(nextMode, current.accent, current.transparency, current.reducedMotion);
        useThemeStore.setState({ resolvedMode: nextMode });
      }
    });
  }
}
