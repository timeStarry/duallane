import { isThemeId, type ThemeId } from "./tokens";

export type AppearanceMode = "light" | "dark" | "system";
export type AppearanceDensity = "comfortable" | "compact";
export type AppearanceMotion = "system" | "reduced";
export type AppearanceTransparency = "auto" | "opaque";

export type AppearancePreferences = Readonly<{
  version: 1;
  themeId: ThemeId;
  mode: AppearanceMode;
  density: AppearanceDensity;
  motion: AppearanceMotion;
  transparency: AppearanceTransparency;
}>;

export type AppearancePatch = Partial<Omit<AppearancePreferences, "version">>;
export type AppearanceUpdate = AppearancePatch | ((current: AppearancePreferences) => AppearancePatch);
export type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

export const APPEARANCE_STORAGE_KEY = "duallane-appearance";
export const LEGACY_THEME_STORAGE_KEY = "duallane-theme-mode";
export const DEFAULT_APPEARANCE: AppearancePreferences = Object.freeze({
  version: 1,
  themeId: "original",
  mode: "system",
  density: "comfortable",
  motion: "system",
  transparency: "auto"
});

function isMode(value: unknown): value is AppearanceMode {
  return value === "light" || value === "dark" || value === "system";
}

/** Whitelisting keeps all content, secrets and unknown fields out of local preferences. */
export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_APPEARANCE;
  const input = value as Record<string, unknown>;
  if (input.version !== 1) return DEFAULT_APPEARANCE;
  return Object.freeze({
    version: 1,
    themeId: isThemeId(input.themeId) ? input.themeId : DEFAULT_APPEARANCE.themeId,
    mode: isMode(input.mode) ? input.mode : DEFAULT_APPEARANCE.mode,
    density: input.density === "compact" ? "compact" : "comfortable",
    motion: input.motion === "reduced" ? "reduced" : "system",
    transparency: input.transparency === "opaque" ? "opaque" : "auto"
  });
}

export function parseAppearancePreferences(serialized: string | null): AppearancePreferences {
  if (serialized === null) return DEFAULT_APPEARANCE;
  try {
    return normalizeAppearancePreferences(JSON.parse(serialized));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearancePreferences(storage: AppearanceStorage | null, preferences: AppearancePreferences): boolean {
  if (!storage) return false;
  try {
    storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(normalizeAppearancePreferences(preferences)));
    return true;
  } catch {
    return false;
  }
}

export function loadAppearancePreferences(storage: AppearanceStorage | null): {
  preferences: AppearancePreferences;
  storageAvailable: boolean;
} {
  if (!storage) return { preferences: DEFAULT_APPEARANCE, storageAvailable: false };
  try {
    const current = storage.getItem(APPEARANCE_STORAGE_KEY);
    // A current record takes precedence, even if corrupt; stale legacy values cannot resurrect it.
    if (current !== null) return { preferences: parseAppearancePreferences(current), storageAvailable: true };
    const legacy = storage.getItem(LEGACY_THEME_STORAGE_KEY);
    if (isMode(legacy)) {
      const preferences = normalizeAppearancePreferences({ ...DEFAULT_APPEARANCE, mode: legacy });
      return { preferences, storageAvailable: saveAppearancePreferences(storage, preferences) };
    }
    return { preferences: DEFAULT_APPEARANCE, storageAvailable: true };
  } catch {
    return { preferences: DEFAULT_APPEARANCE, storageAvailable: false };
  }
}

export function sameAppearancePreferences(left: AppearancePreferences, right: AppearancePreferences): boolean {
  return left.themeId === right.themeId && left.mode === right.mode && left.density === right.density &&
    left.motion === right.motion && left.transparency === right.transparency;
}
