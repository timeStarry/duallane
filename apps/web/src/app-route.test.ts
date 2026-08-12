import { describe, expect, it } from "vitest";
import { getAppRouteUrl, normalizeWorkspaceReturnTo, parseAppRoute, workspaceRoute } from "./app-route";

describe("application routes", () => {
  it("parses every durable public route", () => {
    expect(parseAppRoute("/", "", "").route).toEqual({ kind: "entry" });
    expect(parseAppRoute("/about", "", "").route).toEqual({ kind: "about" });
    expect(parseAppRoute("/direct/room-1", "", "#k=browser-secret").route).toMatchObject({ kind: "direct", roomId: "room-1" });
    expect(parseAppRoute("/workspace/chat/conversation-1").route).toMatchObject({ view: "chat", conversationId: "conversation-1" });
    expect(parseAppRoute("/workspace/files/file-1").route).toMatchObject({ view: "files", fileId: "file-1" });
    expect(parseAppRoute("/workspace/members/user-1").route).toMatchObject({ view: "members", memberId: "user-1" });
    expect(parseAppRoute("/workspace/account").route).toMatchObject({ view: "account" });
    expect(parseAppRoute("/workspace/account/emotes").route).toMatchObject({ view: "account", accountSection: "emotes" });
    expect(parseAppRoute("/workspace/emotes/shared/share-1").route).toMatchObject({
      view: "account",
      sharedEmoteCollectionId: "share-1"
    });
    expect(parseAppRoute("/workspace/new/group").route).toMatchObject({ view: "new", createMode: "group" });
    expect(parseAppRoute("/workspace/space/permissions").route).toMatchObject({ view: "space", spaceTab: "roles" });
    expect(parseAppRoute("/workspace/space/email").route).toMatchObject({ view: "space", spaceTab: "email" });
  });

  it("canonicalizes legacy routes without moving the P2P secret into the query", () => {
    expect(parseAppRoute("/", "?lane=workspace&invite=INVITE-1", "")).toMatchObject({
      canonicalUrl: "/workspace?invite=INVITE-1",
      needsCanonicalReplace: true
    });
    expect(parseAppRoute("/", "?lane=p2p&room=room-1", "#k=browser-secret")).toMatchObject({
      canonicalUrl: "/direct/room-1#k=browser-secret",
      needsCanonicalReplace: true
    });
    expect(parseAppRoute("/direct", "", "#k=orphaned-secret")).toMatchObject({
      canonicalUrl: "/direct",
      needsCanonicalReplace: true
    });
  });

  it("builds canonical workspace URLs", () => {
    expect(getAppRouteUrl(workspaceRoute())).toBe("/workspace");
    expect(getAppRouteUrl(workspaceRoute({ conversationId: "conversation 1" }))).toBe("/workspace/chat/conversation%201");
    expect(getAppRouteUrl(workspaceRoute({ view: "space", spaceTab: "roles" }))).toBe("/workspace/space/permissions");
    expect(getAppRouteUrl(workspaceRoute({ view: "files", fileId: "file-1" }))).toBe("/workspace/files/file-1");
    expect(getAppRouteUrl(workspaceRoute({ view: "account", accountSection: "emotes" }))).toBe("/workspace/account/emotes");
    expect(getAppRouteUrl(workspaceRoute({ view: "account", sharedEmoteCollectionId: "share-1" }))).toBe("/workspace/emotes/shared/share-1");
  });

  it("rejects unsafe OAuth return paths", () => {
    expect(normalizeWorkspaceReturnTo("/workspace/space/email")).toBe("/workspace/space/email");
    expect(normalizeWorkspaceReturnTo("/workspace?invite=INVITE-1")).toBe("/workspace?invite=INVITE-1");
    expect(normalizeWorkspaceReturnTo("https://example.com/workspace")).toBe("");
    expect(normalizeWorkspaceReturnTo("//example.com/workspace")).toBe("");
    expect(normalizeWorkspaceReturnTo("workspace/space/email")).toBe("");
    expect(normalizeWorkspaceReturnTo("/workspace\\@example.com")).toBe("");
    expect(normalizeWorkspaceReturnTo("/workspace/%5c@example.com")).toBe("");
    expect(normalizeWorkspaceReturnTo("/about")).toBe("");
  });
});
