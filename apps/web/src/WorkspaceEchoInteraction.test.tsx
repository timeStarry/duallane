import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ECHO_BOT_USER_ID,
  WorkspaceEchoInteraction,
  echoWorkflowStartInvocationId,
  getEchoWorkflowStepDescriptor,
  recognizeWorkspaceEchoCommand,
  reusableWorkspaceEchoCommandRequest
} from "./WorkspaceEchoInteraction";

describe("Workspace Echo command recognition", () => {
  it("recognizes registered commands only in the canonical Echo direct conversation", () => {
    expect(recognizeWorkspaceEchoCommand({
      conversationType: "direct",
      echoIsParticipant: true,
      source: "  /NeEd  ",
      blocks: [{ type: "text", text: "  /NeEd  " }]
    })).toEqual({ commandName: "need", source: "/NeEd", mentionedBotIds: [] });

    expect(recognizeWorkspaceEchoCommand({
      conversationType: "direct",
      echoIsParticipant: false,
      source: "/need",
      blocks: [{ type: "text", text: "/need" }]
    })).toBeNull();

    expect(recognizeWorkspaceEchoCommand({
      conversationType: "direct",
      echoIsParticipant: true,
      source: "/release 0.15.1",
      blocks: [{ type: "text", text: "/release 0.15.1" }]
    })).toMatchObject({ commandName: "release", source: "/release 0.15.1" });
  });

  it("leaves unknown slash text and ordinary slash messages untouched", () => {
    for (const source of ["/unknown", "//help", "今天用 /help 看过文档", "/123"]) {
      expect(recognizeWorkspaceEchoCommand({
        conversationType: "direct",
        echoIsParticipant: true,
        source,
        blocks: [{ type: "text", text: source }]
      })).toBeNull();
    }
    expect(recognizeWorkspaceEchoCommand({
      conversationType: "direct",
      echoIsParticipant: true,
      source: "/help later",
      blocks: [{ type: "text", text: "/help later" }]
    })?.commandName).toBe("help");
  });

  it("requires and removes the canonical Echo mention in a group command context", () => {
    expect(recognizeWorkspaceEchoCommand({
      conversationType: "group",
      echoIsParticipant: true,
      source: "@回声 /list implemented",
      blocks: [
        { type: "mention", userId: ECHO_BOT_USER_ID, label: "回声" },
        { type: "text", text: " /list implemented" }
      ]
    })).toEqual({
      commandName: "list",
      source: "/list implemented",
      mentionedBotIds: [ECHO_BOT_USER_ID]
    });

    expect(recognizeWorkspaceEchoCommand({
      conversationType: "group",
      echoIsParticipant: true,
      source: "/list",
      blocks: [{ type: "text", text: "/list" }]
    })).toBeNull();
  });
});

describe("Workspace Echo workflow UI contract", () => {
  it("derives a stable workflow-start invocation id for command replay", () => {
    expect(echoWorkflowStartInvocationId("echo-command-123"))
      .toBe("echo-command-123:workflow");
  });

  it("reuses only an unaccepted request with the same draft signature", () => {
    const request = {
      commandName: "need",
      source: "/need",
      mentionedBotIds: [],
      conversationId: "con_echo",
      botUserId: ECHO_BOT_USER_ID,
      clientInvocationId: "echo-command-123",
      draftSignature: "same-draft"
    };
    expect(reusableWorkspaceEchoCommandRequest({ request }, "same-draft")).toBe(request);
    expect(reusableWorkspaceEchoCommandRequest({ request, accepted: true }, "same-draft")).toBeNull();
    expect(reusableWorkspaceEchoCommandRequest({ request }, "changed-draft")).toBeNull();
  });

  it("maps requirement and publication revisions to maintained form steps", () => {
    expect(getEchoWorkflowStepDescriptor({
      type: "echo.requirement",
      state: { step: "scenario", fields: {} }
    })).toMatchObject({ field: "scenario", title: "使用场景", multiline: true });
    expect(getEchoWorkflowStepDescriptor({
      type: "echo.publish",
      state: { step: "options", fields: {} }
    })).toMatchObject({ field: "options", title: "选项与规则", multiline: true });
    expect(getEchoWorkflowStepDescriptor({
      type: "echo.requirement",
      state: { step: "complete", fields: {} }
    })).toMatchObject({ title: "确认提交" });
  });

  it("renders a non-blocking live status while the command is in flight", () => {
    const html = renderToStaticMarkup(
      <WorkspaceEchoInteraction
        slot={{
          request: {
            commandName: "help",
            source: "/help",
            mentionedBotIds: [],
            conversationId: "con_echo",
            botUserId: ECHO_BOT_USER_ID,
            clientInvocationId: "echo-command-123",
            draftSignature: "[]"
          }
        }}
        onCommandAccepted={() => undefined}
        onWorkflowIdChange={() => undefined}
        onDismiss={() => undefined}
        onRestoreFocus={() => undefined}
      />
    );
    expect(html).toContain('aria-label="回声交互"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("正在执行命令");
    expect(html).toContain("正在处理 /help");
  });
});
