import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  applyGroupBotRequestsResponse,
  GroupBotRequests,
  shouldApplyGroupBotRequests,
} from "./GroupBotRequests";

describe("GroupBotRequests", () => {
  it("does not render or call the request API in preview mode", () => {
    expect(
      renderToStaticMarkup(
        <GroupBotRequests conversationId="conv-preview" previewMode />
      )
    ).toBe("");
  });

  it("rejects a deferred response when the group or request revision changed", () => {
    const response = {
      canManage: true,
      requests: [
        {
          botId: "bot-old",
          name: "旧群机器人",
          status: "pending" as const,
          allowContext: true,
          maxMessages: 24,
        },
      ],
      hasMore: false,
    };

    expect(shouldApplyGroupBotRequests("conv-old", "conv-new", 1, 2)).toBe(false);
    expect(applyGroupBotRequestsResponse(response, "conv-old", "conv-new", 1, 2)).toBeNull();
    expect(applyGroupBotRequestsResponse(response, "conv-new", "conv-new", 2, 2)).toMatchObject({
      conversationId: "conv-new",
      status: "ready",
      canManage: true,
    });
  });

  it("keeps only pending requests and preserves the requested context limit", () => {
    const state = applyGroupBotRequestsResponse(
      {
        canManage: true,
        requests: [
          {
            botId: "bot-pending",
            name: "协作机器人",
            status: "pending",
            allowContext: true,
            maxMessages: 32,
          },
          {
            botId: "bot-active",
            name: "已入群机器人",
            status: "active",
            allowContext: true,
            maxMessages: 50,
          },
        ],
        hasMore: false,
      },
      "conv-group",
      "conv-group",
      3,
      3
    );

    expect(state?.requests).toEqual([
      {
        botId: "bot-pending",
        name: "协作机器人",
        status: "pending",
        allowContext: true,
        maxMessages: 32,
      },
    ]);
  });
});
