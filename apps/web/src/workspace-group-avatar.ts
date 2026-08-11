export const WORKSPACE_GROUP_AVATAR_PRESETS = [
  "💬",
  "📌",
  "🚀",
  "🎉",
  "📚",
  "🎮",
  "🎨",
  "🧭",
  "🛠️",
  "❤️"
] as const;

export function normalizeWorkspaceGroupAvatarEmoji(value: string | null | undefined) {
  const candidate = value?.trim() ?? "";
  if (!candidate) return "";

  const graphemes = Array.from(
    new Intl.Segmenter("und", { granularity: "grapheme" }).segment(candidate),
    (item) => item.segment
  );
  if (graphemes.length !== 1 || Array.from(candidate).length > 16) return null;

  const isEmoji = /\p{Extended_Pictographic}/u.test(candidate) ||
    /^\p{Regional_Indicator}{2}$/u.test(candidate) ||
    /^[#*0-9]\uFE0F?\u20E3$/u.test(candidate);
  return isEmoji ? candidate : null;
}
