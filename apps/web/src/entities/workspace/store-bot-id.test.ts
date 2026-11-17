import { describe, expect, it } from "vitest";
import { parseBootstrapPayload } from "./store";

describe("workspace member Bot IDs", () => {
  it("keeps authorized custom Bot IDs while failing closed for other members", () => {
    const parsed = parseBootstrapPayload({
      auth: {
        enabled: true,
        currentUser: { id: "user-owner", displayName: "Owner", role: "owner" },
      },
      members: [
        {
          id: "bot-user-custom",
          displayName: "Custom Bot",
          kind: "bot",
          role: "bot",
          botId: "  bot-config-custom  ",
        },
        {
          id: "bot-user-system",
          displayName: "System Bot",
          kind: "bot",
          role: "bot",
        },
        {
          id: "user-member",
          displayName: "Member",
          kind: "human",
          role: "member",
          botId: "must-not-be-treated-as-a-bot",
        },
      ],
      conversations: [],
    });

    expect(parsed.members["bot-user-custom"]?.botId).toBe("bot-config-custom");
    expect(parsed.members["bot-user-system"]?.botId).toBeUndefined();
    expect(parsed.members["user-member"]?.botId).toBeUndefined();
  });
});
