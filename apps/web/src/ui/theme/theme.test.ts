import { describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_THEME_STORAGE_KEY,
  loadAppearancePreferences,
  normalizeAppearancePreferences,
  parseAppearancePreferences,
  saveAppearancePreferences,
  type AppearanceStorage
} from "./preferences";
import {
  appearanceCssVariables,
  DEFAULT_SYSTEM_APPEARANCE,
  resolveAppearance,
  type SystemAppearance
} from "./appearance";
import { createAppearanceStore, initializeAppearance, type AppearanceEnvironment } from "./store";
import { THEMES, type ThemeId } from "./tokens";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}

function environmentFixture(storage: AppearanceStorage | null = memoryStorage()) {
  let system: SystemAppearance = { ...DEFAULT_SYSTEM_APPEARANCE, supportsTransparency: true };
  const systemListeners = new Set<() => void>();
  const storageListeners = new Set<(key: string | null, value: string | null) => void>();
  const apply = vi.fn();
  const environment: AppearanceEnvironment = {
    storage,
    readSystem: () => system,
    apply,
    onSystemChange(listener) { systemListeners.add(listener); return () => { systemListeners.delete(listener); }; },
    onStorageChange(listener) { storageListeners.add(listener); return () => { storageListeners.delete(listener); }; }
  };
  return {
    environment, apply, systemListeners, storageListeners,
    system(patch: Partial<SystemAppearance>) { system = { ...system, ...patch }; systemListeners.forEach((listener) => listener()); },
    storage(key: string | null, value: string | null) { storageListeners.forEach((listener) => listener(key, value)); }
  };
}

describe("appearance preferences", () => {
  it("whitelists independent settings and never persists unrelated content", () => {
    const input = { ...DEFAULT_APPEARANCE, themeId: "grove", density: "compact", messages: ["private"], secret: "invite-key", token: "bot-secret" };
    const preferences = normalizeAppearancePreferences(input);
    expect(preferences).toEqual({ ...DEFAULT_APPEARANCE, themeId: "grove", density: "compact" });
    const storage = memoryStorage();
    expect(saveAppearancePreferences(storage, preferences)).toBe(true);
    expect(JSON.parse(storage.values.get(APPEARANCE_STORAGE_KEY)!)).toEqual(preferences);
    expect(storage.values.get(APPEARANCE_STORAGE_KEY)).not.toMatch(/private|invite-key|bot-secret/);
  });

  it.each([null, false, [], "dark", {}, { version: 2, themeId: "dusk" }, { version: "1" }])("rejects unsupported shape/schema: %j", (input) => {
    expect(normalizeAppearancePreferences(input)).toEqual(DEFAULT_APPEARANCE);
  });

  it("falls back for an unknown theme without losing valid independent preferences", () => {
    expect(normalizeAppearancePreferences({ version: 1, themeId: "unknown", mode: "dark", density: "compact", motion: "reduced", transparency: "opaque" }))
      .toEqual({ ...DEFAULT_APPEARANCE, mode: "dark", density: "compact", motion: "reduced", transparency: "opaque" });
    expect(normalizeAppearancePreferences({ ...DEFAULT_APPEARANCE, themeId: "__proto__" }).themeId).toBe("original");
    expect(normalizeAppearancePreferences({ version: 1, mode: "auto", density: {}, motion: 1, transparency: [] })).toEqual(DEFAULT_APPEARANCE);
  });

  it("restores every registered theme with independent mode and density preferences", () => {
    for (const themeId of Object.keys(THEMES) as ThemeId[]) {
      const preferences = { ...DEFAULT_APPEARANCE, themeId, mode: "dark" as const, density: "compact" as const };
      const storage = memoryStorage();
      expect(saveAppearancePreferences(storage, preferences)).toBe(true);
      expect(loadAppearancePreferences(storage).preferences).toEqual(preferences);
    }
  });

  it("migrates a valid legacy mode once, preserving the legacy key for old clients", () => {
    const storage = memoryStorage({ [LEGACY_THEME_STORAGE_KEY]: "dark" });
    const first = loadAppearancePreferences(storage);
    expect(first.preferences).toEqual({ ...DEFAULT_APPEARANCE, mode: "dark" });
    expect(first.storageAvailable).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.values.get(LEGACY_THEME_STORAGE_KEY)).toBe("dark");
    loadAppearancePreferences(storage);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("does not revive legacy preferences when a current record is corrupt or incompatible", () => {
    for (const current of ["broken json", JSON.stringify({ version: 2, mode: "dark" })]) {
      const storage = memoryStorage({ [APPEARANCE_STORAGE_KEY]: current, [LEGACY_THEME_STORAGE_KEY]: "dark" });
      expect(loadAppearancePreferences(storage).preferences).toEqual(DEFAULT_APPEARANCE);
      expect(storage.setItem).not.toHaveBeenCalled();
    }
    expect(parseAppearancePreferences("null")).toEqual(DEFAULT_APPEARANCE);
  });

  it("keeps a valid legacy choice in memory when migration cannot write", () => {
    const storage = { getItem: (key: string) => key === LEGACY_THEME_STORAGE_KEY ? "light" : null, setItem: () => { throw new Error("quota"); } };
    expect(loadAppearancePreferences(storage)).toEqual({ preferences: { ...DEFAULT_APPEARANCE, mode: "light" }, storageAvailable: false });
    expect(loadAppearancePreferences({ getItem: () => { throw new Error("denied"); }, setItem: vi.fn() }))
      .toEqual({ preferences: DEFAULT_APPEARANCE, storageAvailable: false });
  });
});

describe("system resolution and semantic colors", () => {
  const system: SystemAppearance = { ...DEFAULT_SYSTEM_APPEARANCE, supportsTransparency: true };

  it("follows the system only for system mode and always honors reduced motion/transparency", () => {
    expect(resolveAppearance(DEFAULT_APPEARANCE, { ...system, dark: true }).mode).toBe("dark");
    const explicit = { ...DEFAULT_APPEARANCE, mode: "light" as const };
    expect(resolveAppearance(explicit, { ...system, dark: true, reducedMotion: true, reducedTransparency: true }))
      .toMatchObject({ mode: "light", motion: "reduced", transparency: "opaque" });
    expect(resolveAppearance(DEFAULT_APPEARANCE, { ...system, forcedColors: true }).transparency).toBe("opaque");
    expect(resolveAppearance(DEFAULT_APPEARANCE, DEFAULT_SYSTEM_APPEARANCE).transparency).toBe("opaque");
  });

  it("uses the selected complete palette for every legacy alias and solid material fallback", () => {
    for (const themeId of Object.keys(THEMES) as ThemeId[]) {
      for (const mode of ["light", "dark"] as const) {
        const resolved = resolveAppearance({ ...DEFAULT_APPEARANCE, themeId, mode, transparency: "opaque", motion: "reduced" }, system);
        const variables = appearanceCssVariables(resolved);
        expect(variables["--ink"]).toBe(THEMES[themeId][mode].text);
        expect(variables["--panel"]).toBe(THEMES[themeId][mode].surface);
        expect(variables["--relay-dark"]).toBe(THEMES[themeId][mode].shared);
        expect(variables["--panel-glass"]).toBe(THEMES[themeId][mode].surface);
        expect(variables["--motion-base"]).toBe("0ms");
        expect(variables["--touch-target"]).toBe("44px");
        expect(variables["--on-direct"]).toBe(THEMES[themeId][mode]["on-direct"]);
      }
    }
  });

  it("ships complete safe color maps with readable text and lane actions for every theme", () => {
    const luminance = (hex: string) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (foreground: string, background: string) => {
      const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (light + 0.05) / (dark + 0.05);
    };
    for (const theme of Object.values(THEMES)) for (const mode of ["light", "dark"] as const) {
      const colors = theme[mode];
      expect(Object.keys(colors).sort()).toEqual(Object.keys(THEMES.original.light).sort());
      for (const color of Object.values(colors)) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      for (const pair of [[colors.text, colors.surface], [colors.muted, colors.surface], [colors.muted, colors.soft], [colors["on-shared"], colors.shared], [colors["on-direct"], colors.direct], [colors.danger, colors["danger-soft"]]]) {
        expect(contrast(pair[0], pair[1]), `${theme.name}/${mode}: ${pair.join(" on ")}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("appearance lifecycle", () => {
  it("initializes the stored system palette before application rendering", () => {
    const storage = memoryStorage({ [APPEARANCE_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_APPEARANCE, themeId: "dusk" }) });
    const fixture = environmentFixture(storage);
    fixture.system({ dark: true });
    const snapshot = initializeAppearance(fixture.environment);
    expect(snapshot.resolved).toMatchObject({ themeId: "dusk", mode: "dark" });
    expect(fixture.apply).toHaveBeenCalledWith(snapshot.preferences, snapshot.resolved);
    expect(fixture.systemListeners.size).toBe(0);
  });

  it("updates system state without changing preferences and cleans up every subscription", () => {
    const fixture = environmentFixture();
    const store = createAppearanceStore(fixture.environment);
    const preferences = store.getSnapshot().preferences;
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    fixture.system({ dark: true, reducedMotion: true });
    expect(store.getSnapshot().resolved).toMatchObject({ mode: "dark", motion: "reduced" });
    expect(store.getSnapshot().preferences).toBe(preferences);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(fixture.systemListeners.size).toBe(0);
    expect(fixture.storageListeners.size).toBe(0);
    const strictModeResubscribe = store.subscribe(listener);
    expect(fixture.systemListeners.size).toBe(1);
    strictModeResubscribe();
    expect(fixture.systemListeners.size).toBe(0);
  });

  it("keeps independent choices in memory on write failure and can retry persistence", () => {
    const storage = memoryStorage();
    storage.setItem.mockImplementationOnce(() => { throw new Error("full"); });
    const fixture = environmentFixture(storage);
    const store = createAppearanceStore(fixture.environment);
    const unsubscribe = store.subscribe(vi.fn());
    expect(store.setPreferences({ themeId: "grove", density: "compact" })).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ preferences: { themeId: "grove", density: "compact", mode: "system" }, storageAvailable: false });
    fixture.system({ dark: true });
    expect(store.getSnapshot().resolved).toMatchObject({ themeId: "grove", density: "compact", mode: "dark" });
    unsubscribe();
    const resubscribe = store.subscribe(vi.fn());
    expect(store.getSnapshot().preferences.themeId).toBe("grove");
    expect(store.retryStorage()).toBe(true);
    expect(store.getSnapshot().storageAvailable).toBe(true);
    resubscribe();
  });

  it("synchronizes another tab without write-back and handles invalid or removed records", () => {
    const storage = memoryStorage();
    const fixture = environmentFixture(storage);
    const store = createAppearanceStore(fixture.environment);
    const unsubscribe = store.subscribe(vi.fn());
    fixture.storage(APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_APPEARANCE, themeId: "dusk", transparency: "opaque" }));
    expect(store.getSnapshot().preferences.themeId).toBe("dusk");
    expect(store.getSnapshot().resolved.transparency).toBe("opaque");
    expect(storage.setItem).not.toHaveBeenCalled();
    fixture.storage("unrelated-content", "secret");
    expect(store.getSnapshot().preferences.themeId).toBe("dusk");
    fixture.storage(APPEARANCE_STORAGE_KEY, "not-json");
    expect(store.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE);
    fixture.storage(null, null);
    expect(store.getSnapshot().preferences).toEqual(DEFAULT_APPEARANCE);
    expect(storage.setItem).not.toHaveBeenCalled();
    unsubscribe();
  });
});
