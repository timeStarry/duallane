import tokens from "./tokens.json" with { type: "json" };

export type ThemeMode = "light" | "dark";
export type ThemePreference = ThemeMode | "system";
export type AccentId = keyof typeof tokens.accents;

export const DESIGN_TOKENS = tokens;
export const ACCENT_IDS = Object.keys(tokens.accents) as AccentId[];

export function isAccentId(value: unknown): value is AccentId {
  return typeof value === "string" && value in tokens.accents;
}
