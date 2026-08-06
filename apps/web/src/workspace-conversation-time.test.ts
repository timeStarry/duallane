import { describe, expect, it } from "vitest";
import { formatWorkspaceConversationTime } from "./workspace-conversation-time";

function localDate(year: number, month: number, day: number, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute);
}

describe("formatWorkspaceConversationTime", () => {
  const now = localDate(2026, 8, 6, 18, 0);

  it("shows a clock time for conversations active today", () => {
    expect(formatWorkspaceConversationTime(localDate(2026, 8, 6, 9, 5).toISOString(), now)).toBe("09:05");
  });

  it("uses friendly labels for yesterday and the day before", () => {
    expect(formatWorkspaceConversationTime(localDate(2026, 8, 5).toISOString(), now)).toBe("昨天");
    expect(formatWorkspaceConversationTime(localDate(2026, 8, 4).toISOString(), now)).toBe("前天");
  });

  it("shows a date for older conversations and includes the year when needed", () => {
    expect(formatWorkspaceConversationTime(localDate(2026, 7, 31).toISOString(), now)).toBe("7月31日");
    expect(formatWorkspaceConversationTime(localDate(2025, 12, 31).toISOString(), now)).toBe("2025年12月31日");
  });

  it("returns an empty label for invalid timestamps", () => {
    expect(formatWorkspaceConversationTime("not-a-date", now)).toBe("");
  });
});
