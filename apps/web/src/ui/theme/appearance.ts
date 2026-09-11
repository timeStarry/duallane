import type { AppearancePreferences } from "./preferences";
import { THEMES, type ColorMode, type SemanticColors } from "./tokens";

export type SystemAppearance = Readonly<{
  dark: boolean;
  reducedMotion: boolean;
  reducedTransparency: boolean;
  forcedColors: boolean;
  supportsTransparency: boolean;
}>;

export type ResolvedAppearance = Readonly<{
  themeId: AppearancePreferences["themeId"];
  mode: ColorMode;
  density: AppearancePreferences["density"];
  motion: "standard" | "reduced";
  transparency: "auto" | "opaque";
  colors: SemanticColors;
}>;

export const DEFAULT_SYSTEM_APPEARANCE: SystemAppearance = Object.freeze({
  dark: false,
  reducedMotion: false,
  reducedTransparency: false,
  forcedColors: false,
  supportsTransparency: false
});

export function resolveAppearance(preferences: AppearancePreferences, system: SystemAppearance): ResolvedAppearance {
  const mode = preferences.mode === "system" ? system.dark ? "dark" : "light" : preferences.mode;
  return Object.freeze({
    themeId: preferences.themeId,
    mode,
    density: preferences.density,
    motion: preferences.motion === "reduced" || system.reducedMotion ? "reduced" : "standard",
    transparency: preferences.transparency === "opaque" || system.reducedTransparency || system.forcedColors ||
      !system.supportsTransparency ? "opaque" : "auto",
    colors: THEMES[preferences.themeId][mode]
  });
}

function alpha(hex: string, opacity: number): string {
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `rgb(${rgb.join(" ")} / ${opacity})`;
}

/** Old names are aliases of the new semantic palette, never a fallback skin. */
export function appearanceCssVariables(appearance: ResolvedAppearance): Record<string, string> {
  const colors = appearance.colors;
  const shadowColor = appearance.mode === "dark" ? colors.bg : colors.text;
  const motion = appearance.motion === "reduced";
  return {
    ...Object.fromEntries(Object.entries(colors).map(([name, value]) => [`--${name}`, value])),
    "--ink": colors.text,
    "--panel": colors.surface,
    "--panel-2": colors.soft,
    "--surface-soft": colors.soft,
    "--surface-tint": colors["shared-soft"],
    "--accent-soft": colors["shared-soft"],
    "--panel-glass": appearance.transparency === "opaque" ? colors.surface : alpha(colors.surface, 0.9),
    "--hover-line": colors.control,
    "--grid-line": alpha(colors.line, 0),
    "--focus-ring": alpha(colors.focus, 0.25),
    "--status-dot": colors.muted,
    "--progress-track": colors.soft,
    "--message-self": colors["shared-soft"],
    "--transfer-active": colors["shared-soft"],
    "--transfer-complete": colors["success-soft"],
    "--transfer-rejected": colors["danger-soft"],
    "--success-fg": colors.success,
    "--success-bg": colors["success-soft"],
    "--success-icon-bg": colors["success-soft"],
    "--warning-fg": colors.warning,
    "--warning-bg": colors["warning-soft"],
    "--danger-fg": colors.danger,
    "--danger-bg": colors["danger-soft"],
    "--info-bg": colors["shared-soft"],
    "--direct-dark": colors.direct,
    "--relay": colors.shared,
    "--relay-dark": colors.shared,
    "--green": colors.success,
    "--yellow": colors.warning,
    "--red": colors.danger,
    "--shadow": `0 12px 40px ${alpha(shadowColor, appearance.mode === "dark" ? 0.35 : 0.1)}`,
    "--shadow-input": `0 1px 2px ${alpha(shadowColor, 0.04)}, 0 4px 14px ${alpha(shadowColor, 0.05)}`,
    "--shadow-overlay": `0 2px 8px ${alpha(shadowColor, 0.08)}, 0 16px 48px ${alpha(shadowColor, 0.16)}`,
    "--scrollbar-thumb": colors.control,
    "--scrollbar-thumb-hover": colors.muted,
    "--motion-fast": motion ? "0ms" : "120ms",
    "--motion-base": motion ? "0ms" : "180ms",
    "--motion-slow": motion ? "0ms" : "200ms",
    "--motion-ease": "cubic-bezier(0.2, 0.75, 0.25, 1)",
    "--material-blur": appearance.transparency === "opaque" ? "0px" : "16px",
    "--radius-tag": "6px",
    "--radius-control": "10px",
    "--radius-composer": "16px",
    "--radius-dialog": "20px",
    "--radius-entity": "11px",
    "--touch-target": "44px",
    "--density-row-padding": appearance.density === "compact" ? "8px" : "12px",
    "--density-section-gap": appearance.density === "compact" ? "16px" : "24px"
  };
}

export function applyAppearanceToDocument(
  document: Document,
  preferences: AppearancePreferences,
  appearance: ResolvedAppearance
): void {
  const root = document.documentElement;
  root.dataset.theme = appearance.mode;
  root.dataset.themeMode = preferences.mode;
  root.dataset.themeFamily = appearance.themeId;
  root.dataset.density = appearance.density;
  root.dataset.motion = appearance.motion;
  root.dataset.transparency = appearance.transparency;
  root.style.colorScheme = appearance.mode;
  for (const [name, value] of Object.entries(appearanceCssVariables(appearance))) root.style.setProperty(name, value);
}
