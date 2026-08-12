import { describe, expect, it } from "vitest";
import { groupHiddenWorkspaceMessages } from "./workspace-hidden-messages";

describe("groupHiddenWorkspaceMessages", () => {
  it("merges only adjacent hidden messages while preserving source positions", () => {
    const messages = [
      { id: "one" },
      { id: "two", hiddenByCurrentUser: true },
      { id: "three", hiddenByCurrentUser: true },
      { id: "four" },
      { id: "five", hiddenByCurrentUser: true }
    ];

    expect(groupHiddenWorkspaceMessages(messages)).toEqual([
      { kind: "message", message: messages[0], sourceIndex: 0 },
      { kind: "hidden", messages: [messages[1], messages[2]], sourceIndex: 1 },
      { kind: "message", message: messages[3], sourceIndex: 3 },
      { kind: "hidden", messages: [messages[4]], sourceIndex: 4 }
    ]);
  });
});
