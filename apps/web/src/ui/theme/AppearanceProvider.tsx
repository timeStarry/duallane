import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createAppearanceStore, type AppearanceEnvironment, type AppearanceSnapshot } from "./store";
import type { AppearanceUpdate } from "./preferences";

export type AppearanceContextValue = AppearanceSnapshot & {
  setPreferences: (update: AppearanceUpdate) => boolean;
  retryStorage: () => boolean;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children, environment }: { children: ReactNode; environment?: AppearanceEnvironment }) {
  const [store] = useState(() => createAppearanceStore(environment));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const value = useMemo(() => ({ ...snapshot, setPreferences: store.setPreferences, retryStorage: store.retryStorage }), [snapshot, store]);
  // No appearance key or conditional subtree: switching appearance cannot remount the editor.
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const appearance = useContext(AppearanceContext);
  if (!appearance) throw new Error("useAppearance must be used within AppearanceProvider");
  return appearance;
}
