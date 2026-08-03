import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "App.tsx");

describe("workspace login entry copy", () => {
  it("keeps the public shared-space login entry focused on GitHub login only", () => {
    const source = readFileSync(sourcePath, "utf8");
    const start = source.indexOf('{workspaceStatus !== "ready" || !workspaceBootstrap ? (');
    const end = source.indexOf("<WorkspaceShell", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const loginEntrySource = source.slice(start, end);
    expect(loginEntrySource).toContain("使用 GitHub 登录");
    expect(loginEntrySource).toContain("共享空间会保存聊天和文件");
    expect(loginEntrySource).toContain("进入权限由服务端校验");
    const authActionStart = loginEntrySource.indexOf('{(workspaceStatus === "idle" || workspaceStatus === "auth") && (');
    const authActionEnd = loginEntrySource.indexOf('{workspaceStatus === "error"', authActionStart);
    expect(authActionStart).toBeGreaterThan(-1);
    expect(authActionEnd).toBeGreaterThan(authActionStart);
    const authActionSource = loginEntrySource.slice(authActionStart, authActionEnd);
    expect(authActionSource).toContain("使用 GitHub 登录");
    expect(authActionSource).not.toContain("重新加载");
    expect(loginEntrySource).not.toContain("邀请");
    expect(loginEntrySource).not.toContain("邀请码");
    expect(loginEntrySource).not.toContain("invite");
    expect(loginEntrySource).not.toContain("端到端");
    expect(loginEntrySource).not.toContain("浏览器直连");
    expect(loginEntrySource).not.toContain("服务器不保存");
    expect(loginEntrySource).not.toContain("只在浏览器");
  });

  it("creates invite links that land on the shared-space entry before GitHub login", () => {
    const source = readFileSync(sourcePath, "utf8");
    const start = source.indexOf("async function createWorkspaceInvite");
    const end = source.indexOf("async function revokeWorkspaceInvite", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const createInviteSource = source.slice(start, end);
    expect(createInviteSource).toContain("getWorkspaceEntryUrl(data.invite.code || \"\")");
    expect(createInviteSource).not.toContain("getWorkspaceLoginUrl(data.invite.code || \"\")");
  });

  it("uses shared-space product language instead of internal workspace relay copy", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("选择沟通方式");
    expect(source).not.toContain("开始加密对话");
    expect(source).not.toContain("仅使用服务器做信令协调");
    expect(source).not.toContain("工作区中转");
    expect(source).not.toContain("审计留存");
    expect(source).not.toContain("共享空间中转");
    expect(source).not.toContain("共享空间中转文件");
    expect(source).not.toContain("改用共享空间中转");
    expect(source).toContain("改用共享空间上传");
    expect(source).toContain("上传到共享空间");
  });

  it("maps disabled shared-space errors by stable code instead of stale copy", () => {
    const source = readFileSync(sourcePath, "utf8");
    const start = source.indexOf("async function loadWorkspace");
    const end = source.indexOf("async function refreshWorkspaceMembers", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const loadWorkspaceSource = source.slice(start, end);
    expect(loadWorkspaceSource).toContain('const code = error instanceof WorkspaceClientError ? error.code : ""');
    expect(loadWorkspaceSource).toContain('setWorkspaceError(code === "auth.required" ? "" : message)');
    expect(loadWorkspaceSource).toContain('code === "workspace.disabled"');
    expect(loadWorkspaceSource).toContain('code.startsWith("auth.")');
    expect(loadWorkspaceSource).not.toContain('message.includes("开发中")');
    expect(loadWorkspaceSource).not.toContain('message.includes("登录")');
  });
});
