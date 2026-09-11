import {
  APPEARANCE_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
  loadAppearancePreferences,
  normalizeAppearancePreferences,
  parseAppearancePreferences,
  sameAppearancePreferences,
  saveAppearancePreferences,
  type AppearancePreferences,
  type AppearanceStorage,
  type AppearanceUpdate
} from "./preferences";
import {
  applyAppearanceToDocument,
  DEFAULT_SYSTEM_APPEARANCE,
  resolveAppearance,
  type ResolvedAppearance,
  type SystemAppearance
} from "./appearance";

export type AppearanceSnapshot = Readonly<{
  preferences: AppearancePreferences;
  resolved: ResolvedAppearance;
  storageAvailable: boolean;
}>;

export type AppearanceEnvironment = {
  storage: AppearanceStorage | null;
  readSystem: () => SystemAppearance;
  onSystemChange: (listener: () => void) => () => void;
  onStorageChange: (listener: (key: string | null, value: string | null) => void) => () => void;
  apply: (preferences: AppearancePreferences, resolved: ResolvedAppearance) => void;
};

const noSubscription = () => () => undefined;

export function browserAppearanceEnvironment(browser: Window | undefined = typeof window === "undefined" ? undefined : window): AppearanceEnvironment {
  if (!browser) return {
    storage: null,
    readSystem: () => DEFAULT_SYSTEM_APPEARANCE,
    onSystemChange: noSubscription,
    onStorageChange: noSubscription,
    apply: () => undefined
  };
  let storage: Storage | null = null;
  try { storage = browser.localStorage; } catch { /* Private or restricted contexts can deny the getter itself. */ }
  const media = (query: string): MediaQueryList | null => {
    try { return browser.matchMedia?.(query) ?? null; } catch { return null; }
  };
  const dark = media("(prefers-color-scheme: dark)");
  const motion = media("(prefers-reduced-motion: reduce)");
  const transparency = media("(prefers-reduced-transparency: reduce)");
  const forcedColors = media("(forced-colors: active)");
  const css = (browser as Window & { CSS?: { supports: (property: string, value: string) => boolean } }).CSS;
  let supportsTransparency = false;
  try {
    supportsTransparency = Boolean(css?.supports("backdrop-filter", "blur(1px)") || css?.supports("-webkit-backdrop-filter", "blur(1px)"));
  } catch { /* Missing support uses a solid semantic surface. */ }
  return {
    storage,
    readSystem: () => ({
      dark: dark?.matches ?? false,
      reducedMotion: motion?.matches ?? false,
      reducedTransparency: transparency?.matches ?? false,
      forcedColors: forcedColors?.matches ?? false,
      supportsTransparency
    }),
    onSystemChange: (listener) => {
      const cleanups = [dark, motion, transparency, forcedColors].flatMap((query) => {
        if (!query) return [];
        if (query.addEventListener) {
          query.addEventListener("change", listener);
          return [() => query.removeEventListener("change", listener)];
        }
        query.addListener(listener);
        return [() => query.removeListener(listener)];
      });
      return () => cleanups.forEach((cleanup) => cleanup());
    },
    onStorageChange: (listener) => {
      const handle = (event: StorageEvent) => {
        if (event.storageArea && event.storageArea !== storage) return;
        listener(event.key, event.newValue);
      };
      browser.addEventListener("storage", handle);
      return () => browser.removeEventListener("storage", handle);
    },
    apply: (preferences, resolved) => applyAppearanceToDocument(browser.document, preferences, resolved)
  };
}

/** Call before createRoot to apply the resolved palette before the application's first render. */
export function initializeAppearance(environment = browserAppearanceEnvironment()): AppearanceSnapshot {
  const stored = loadAppearancePreferences(environment.storage);
  const resolved = resolveAppearance(stored.preferences, environment.readSystem());
  environment.apply(stored.preferences, resolved);
  return Object.freeze({ ...stored, resolved });
}

export function createAppearanceStore(environment = browserAppearanceEnvironment()) {
  const stored = loadAppearancePreferences(environment.storage);
  let snapshot: AppearanceSnapshot = Object.freeze({
    ...stored,
    resolved: resolveAppearance(stored.preferences, environment.readSystem())
  });
  const listeners = new Set<() => void>();
  let cleanup: (() => void) | undefined;

  function publish(preferences: AppearancePreferences, storageAvailable = snapshot.storageAvailable) {
    const resolved = resolveAppearance(preferences, environment.readSystem());
    const unchanged = sameAppearancePreferences(snapshot.preferences, preferences) &&
      snapshot.resolved.mode === resolved.mode && snapshot.resolved.motion === resolved.motion &&
      snapshot.resolved.transparency === resolved.transparency && snapshot.storageAvailable === storageAvailable;
    environment.apply(preferences, resolved);
    if (unchanged) return;
    snapshot = Object.freeze({ preferences, resolved, storageAvailable });
    listeners.forEach((listener) => listener());
  }

  function onStorageChange(key: string | null, value: string | null) {
    if (key === APPEARANCE_STORAGE_KEY || key === null) {
      // No write-back: storage events must never bounce between tabs.
      publish(parseAppearancePreferences(value), Boolean(environment.storage));
    } else if (key === LEGACY_THEME_STORAGE_KEY) {
      try {
        if (environment.storage?.getItem(APPEARANCE_STORAGE_KEY) === null) {
          const next = loadAppearancePreferences(environment.storage);
          publish(next.preferences, next.storageAvailable);
        }
      } catch { /* Keep the usable in-memory choice if storage becomes inaccessible. */ }
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        const stopSystem = environment.onSystemChange(() => publish(snapshot.preferences));
        const stopStorage = environment.onStorageChange(onStorageChange);
        cleanup = () => { stopSystem(); stopStorage(); };
        // Catch system changes between initialization and subscription, including Strict Mode setup.
        publish(snapshot.preferences);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { cleanup?.(); cleanup = undefined; }
      };
    },
    setPreferences(update: AppearanceUpdate) {
      const patch = typeof update === "function" ? update(snapshot.preferences) : update;
      const next = normalizeAppearancePreferences({ ...snapshot.preferences, ...patch, version: 1 });
      const saved = saveAppearancePreferences(environment.storage, next);
      publish(next, saved);
      return saved;
    },
    retryStorage() {
      const saved = saveAppearancePreferences(environment.storage, snapshot.preferences);
      publish(snapshot.preferences, saved);
      return saved;
    }
  };
}
