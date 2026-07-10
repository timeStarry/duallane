import { describe, expect, it } from "vitest";
import { getWorkspaceEntryUrl, getWorkspaceLoginUrl, parseEntryRoute } from "./workspace-url";

describe("workspace entry url helpers", () => {
  it("preserves invite codes from shared-space entry links", () => {
    expect(parseEntryRoute("?lane=workspace&invite=INVITE-123")).toEqual({
      lane: "workspace",
      inviteCode: "INVITE-123",
      roomId: ""
    });
  });

  it("passes invite codes to GitHub login without exposing a public invite form", () => {
    expect(getWorkspaceLoginUrl("INVITE-123")).toBe("/api/auth/github/start?invite=INVITE-123");
    expect(getWorkspaceLoginUrl("")).toBe("/api/auth/github/start");
  });

  it("generates shared-space invite links for the public entry page", () => {
    expect(getWorkspaceEntryUrl("INVITE-123")).toBe("/?lane=workspace&invite=INVITE-123");
    expect(getWorkspaceEntryUrl("")).toBe("/?lane=workspace");
  });

  it("does not forward browser-only invite fragments to workspace login", () => {
    expect(parseEntryRoute("?lane=workspace&invite=INVITE-123#k=private-secret")).toEqual({
      lane: "workspace",
      inviteCode: "INVITE-123",
      roomId: ""
    });
    expect(getWorkspaceLoginUrl("INVITE-123#k=private-secret")).toBe("/api/auth/github/start?invite=INVITE-123");
    expect(getWorkspaceEntryUrl("INVITE-123#k=private-secret")).toBe("/?lane=workspace&invite=INVITE-123");
  });

  it("keeps p2p room parsing separate from shared-space invites", () => {
    expect(parseEntryRoute("?lane=p2p&room=room-1&invite=ignored")).toEqual({
      lane: "p2p",
      inviteCode: "ignored",
      roomId: "room-1"
    });
  });
});
