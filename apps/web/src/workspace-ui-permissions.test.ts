import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "App.tsx");
const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "styles.css");

function readSource() {
  return readFileSync(sourcePath, "utf8");
}

function readStyles() {
  return readFileSync(stylesPath, "utf8");
}

describe("workspace UI permission boundaries", () => {
  it("keeps the shared-space shell as rail, main surface, and context drawer", () => {
    const source = readSource();
    const renderStart = source.indexOf('{lane === "workspace-dev" && (');
    const renderEnd = source.indexOf("function parsePeerMessage", renderStart);
    expect(renderStart).toBeGreaterThan(-1);
    expect(renderEnd).toBeGreaterThan(renderStart);
    const workspaceRenderSource = source.slice(renderStart, renderEnd);

    expect(source).toContain('type WorkspaceMobilePane = "list" | "main" | "details";');
    expect(workspaceRenderSource).toContain('<div className={`workspace-product-shell mobile-pane-${workspaceMobilePane}${workspaceContextVisible ? "" : " context-hidden"}`}>');
    expect(source).toContain("const [workspaceContextCollapsed, setWorkspaceContextCollapsed] = useState(false);");
    expect(source).toContain("const workspaceContextVisible = workspaceContextAvailable && !workspaceContextCollapsed;");
    expect(workspaceRenderSource).toContain('<aside className="workspace-rail" aria-label="共享空间导航">');
    expect(workspaceRenderSource).toContain('<section className="workspace-main" aria-label="共享空间主视图">');
    expect(workspaceRenderSource).toContain("{workspaceContextVisible && (");
    expect(workspaceRenderSource).toContain('<aside className="workspace-context" aria-label={workspaceContextMode === "file" ? "文件详情" : "当前会话详情"}>');
    expect(workspaceRenderSource.indexOf('className="workspace-rail"')).toBeLessThan(workspaceRenderSource.indexOf('className="workspace-main"'));
    expect(workspaceRenderSource.indexOf('className="workspace-main"')).toBeLessThan(workspaceRenderSource.indexOf('className="workspace-context"'));
  });

  it("keeps mobile shared-space navigation to one primary pane at a time", () => {
    const styles = readStyles();
    const mobileStart = styles.indexOf("@media (max-width: 760px)");
    expect(mobileStart).toBeGreaterThan(-1);
    const mobileStyles = styles.slice(mobileStart);

    expect(mobileStyles).toContain(".workspace-product-shell {\n    width: 100%;");
    expect(mobileStyles).toContain("grid-template-columns: 1fr;");
    expect(mobileStyles).toContain(".workspace-product-shell.mobile-pane-list .workspace-main");
    expect(mobileStyles).toContain(".workspace-product-shell.mobile-pane-list .workspace-context");
    expect(mobileStyles).toContain(".workspace-product-shell.mobile-pane-main .workspace-rail");
    expect(mobileStyles).toContain(".workspace-product-shell.mobile-pane-main .workspace-context");
    expect(mobileStyles).toContain(".workspace-product-shell.mobile-pane-details .workspace-rail");
    expect(mobileStyles).toContain(".workspace-product-shell.mobile-pane-details .workspace-main");
    expect(mobileStyles).toContain("display: none;");
    expect(mobileStyles).toContain(".mobile-only {\n    display: inline-flex;");
    expect(mobileStyles).toContain(".workspace-shell {\n    width: 100%;");
    expect(mobileStyles).toContain(".theme-switch {\n    top: 12px;");
    expect(mobileStyles).toContain("grid-template-columns: repeat(3, 34px);");
    expect(mobileStyles).toContain(".theme-switch button {\n    width: 34px;");
    expect(mobileStyles).toContain("min-width: 34px;");
    expect(mobileStyles).toContain(".workspace-status {\n    width: 100%;");
    expect(mobileStyles).toContain(".workspace-status-summary {\n    width: 100%;\n    display: grid;");
    expect(mobileStyles).toContain("grid-template-columns: minmax(0, 1fr) auto 36px;");
    expect(mobileStyles).toContain(".workspace-status-meta {\n    display: none;");
    expect(mobileStyles).toContain(".workspace-create-actions .secondary {\n    width: 100%;");
    expect(mobileStyles).toContain("@media (max-width: 520px)");
    expect(mobileStyles).toContain("grid-template-columns: repeat(3, 32px);");
    expect(mobileStyles).toContain(".topbar {\n    padding-right: 112px;");
  });

  it("uses theme-aware surfaces for shared-space controls", () => {
    const styles = readStyles();

    expect(styles).not.toContain("background: #fff;");
    expect(styles).toContain(".conversation:hover,\n.conversation.active {");
    expect(styles).toContain("background: var(--surface);");
    expect(styles).toContain("background: var(--surface-tint);");
  });

  it("keeps workspace controls content-sized and delegates height to result regions", () => {
    const styles = readStyles();

    expect(styles).toMatch(/\.workspace-content-panel\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(styles).not.toMatch(/\.workspace-content-panel\s*\{[^}]*grid-template-rows:/s);
    expect(styles).toMatch(
      /\.workspace-content-panel > \.workspace-file-browser,[^}]*\.workspace-content-panel > \.workspace-member-grid,[^}]*\.workspace-content-panel > \.workspace-settings-section\s*\{[^}]*flex:\s*1 1 auto;/s
    );
    expect(styles).toMatch(
      /\.workspace-member-grid,[^}]*\.workspace-file-table,[^}]*\.workspace-invite-list,[^}]*\.workspace-role-list\s*\{[^}]*grid-auto-rows:\s*max-content;[^}]*align-content:\s*start;/s
    );
    expect(styles).toMatch(/\.workspace-info-grid\s*\{[^}]*grid-auto-rows:\s*max-content;[^}]*align-content:\s*start;/s);
    expect(styles).toMatch(/\.space-tabs\s*\{[^}]*grid-template-columns:\s*none;[^}]*grid-auto-flow:\s*column;/s);
    expect(styles).toMatch(
      /\.workspace-filter-tabs\[aria-label="成员角色筛选"\]\s*\{[^}]*grid-template-columns:\s*none;[^}]*grid-auto-flow:\s*column;/s
    );
  });

  it("keeps invite and role management behind privileged permission checks", () => {
    const source = readSource();

    expect(source).toContain('{ id: "invites" as const, label: "邀请", visible: workspaceBootstrap.permissions.canCreateMemberInvite }');
    expect(source).toContain('{ id: "roles" as const, label: "权限", visible: workspaceBootstrap.permissions.canCreatePrivilegedInvite }');
    expect(source).toContain('{workspaceSpaceTab === "invites" && workspaceBootstrap.permissions.canCreateMemberInvite && (');
    expect(source).toContain('{workspaceSpaceTab === "roles" && workspaceBootstrap.permissions.canCreatePrivilegedInvite && (');
    expect(source).toContain('workspaceSpaceTab === "invites" && !workspaceBootstrap?.permissions.canCreateMemberInvite');
    expect(source).toContain('workspaceSpaceTab === "roles" && !workspaceBootstrap?.permissions.canCreatePrivilegedInvite');
  });

  it("keeps conversation content requests behind the read permission capability", () => {
    const source = readSource();

    expect(source).toContain("canReadConversations: boolean;");
    expect(source).toContain("bootstrap.permissions.canReadConversations\n          ? workspaceJson<{ conversations: WorkspaceConversation[] }>");
    expect(source).toContain("async function refreshWorkspaceConversations");
    expect(source).toContain("if (!workspaceBootstrap?.permissions.canReadConversations) {");
    expect(source).toContain("setWorkspaceConversations([]);");
  });

  it("hydrates first-screen shared-space data from bootstrap before fallback requests", () => {
    const source = readSource();
    const typeStart = source.indexOf("type WorkspaceBootstrap = {");
    const typeEnd = source.indexOf("type WorkspaceInvite", typeStart);
    expect(typeStart).toBeGreaterThan(-1);
    expect(typeEnd).toBeGreaterThan(typeStart);
    const typeSource = source.slice(typeStart, typeEnd);
    expect(typeSource).toContain("members: WorkspaceUser[];");
    expect(typeSource).toContain("conversations?: WorkspaceConversation[];");
    expect(typeSource).toContain("files?: WorkspaceFile[];");

    const loadStart = source.indexOf("async function loadWorkspace");
    const loadEnd = source.indexOf("async function refreshWorkspaceBootstrap", loadStart);
    expect(loadStart).toBeGreaterThan(-1);
    expect(loadEnd).toBeGreaterThan(loadStart);
    const loadSource = source.slice(loadStart, loadEnd);
    expect(loadSource).toContain('const bootstrap = await workspaceJson<WorkspaceBootstrap>("/api/workspace/bootstrap")');
    expect(loadSource).toContain("bootstrap.conversations\n          ? Promise.resolve({ conversations: bootstrap.conversations })");
    expect(loadSource).toContain('workspaceJson<{ conversations: WorkspaceConversation[] }>("/api/workspace/conversations")');
    expect(loadSource).toContain("bootstrap.files\n          ? Promise.resolve({ files: bootstrap.files })");
    expect(loadSource).toContain('workspaceJson<{ files: WorkspaceFile[] }>("/api/workspace/files")');
    expect(loadSource).toContain("bootstrap.members\n          ? Promise.resolve({ members: bootstrap.members })");
    expect(loadSource).toContain('workspaceJson<{ members: WorkspaceUser[] }>("/api/workspace/members")');
    expect(loadSource).toContain("setWorkspaceBootstrap({ ...bootstrap, members: members.members })");
    expect(loadSource).toContain("setWorkspaceConversations(conversations.conversations)");
    expect(loadSource).toContain("setWorkspaceFiles(files.files)");
    expect(loadSource).toContain("setWorkspaceLibraryFiles(files.files)");
  });

  it("keeps realtime sync recovery permission-safe and refreshes member state", () => {
    const source = readSource();
    const syncRequiredStart = source.indexOf('if (envelope.type === "sync.required")');
    const syncRequiredEnd = source.indexOf("const events = normalizeWorkspaceRealtimeEvents", syncRequiredStart);
    expect(syncRequiredStart).toBeGreaterThan(-1);
    expect(syncRequiredEnd).toBeGreaterThan(syncRequiredStart);
    const syncRequiredSource = source.slice(syncRequiredStart, syncRequiredEnd);
    expect(syncRequiredSource).toContain("void syncWorkspaceRealtimeState(Number(envelope.currentSeq));");

    const realtimeSyncStart = source.indexOf("async function syncWorkspaceRealtimeState");
    const realtimeSyncEnd = source.indexOf("async function projectWorkspaceEvents", realtimeSyncStart);
    expect(realtimeSyncStart).toBeGreaterThan(-1);
    expect(realtimeSyncEnd).toBeGreaterThan(realtimeSyncStart);
    const realtimeSyncSource = source.slice(realtimeSyncStart, realtimeSyncEnd);
    expect(realtimeSyncSource).toContain("setWorkspaceRealtimeState(\"syncing\")");
    expect(realtimeSyncSource).toContain("refreshWorkspaceBootstrap()");
    expect(realtimeSyncSource).toContain("refreshWorkspaceConversations()");
    expect(realtimeSyncSource).toContain("refreshWorkspaceFiles()");
    expect(realtimeSyncSource).toContain("workspaceRealtimeSeqRef.current = Math.max(0, Number(currentSeqValue))");
    expect(realtimeSyncSource).toContain("setWorkspaceRealtimeState(\"connected\")");

    const bootstrapStart = source.indexOf("async function refreshWorkspaceBootstrap");
    const bootstrapEnd = source.indexOf("function clearWorkspaceClientState", bootstrapStart);
    expect(bootstrapStart).toBeGreaterThan(-1);
    expect(bootstrapEnd).toBeGreaterThan(bootstrapStart);
    const bootstrapSource = source.slice(bootstrapStart, bootstrapEnd);
    expect(bootstrapSource).toContain("setWorkspaceBootstrap(data)");
    expect(bootstrapSource).toContain("setWorkspaceDirectoryMembers(data.members)");

    const filesStart = source.indexOf("async function refreshWorkspaceFiles");
    const filesEnd = source.indexOf("async function projectWorkspaceEvents", filesStart);
    expect(filesStart).toBeGreaterThan(-1);
    expect(filesEnd).toBeGreaterThan(filesStart);
    const filesSource = source.slice(filesStart, filesEnd);
    expect(filesSource).toContain("if (!workspaceBootstrap?.permissions.canDownload) {");
    expect(filesSource).toContain("setWorkspaceLibraryFiles([]);");
  });

  it("uses WebSocket push and replay without fixed realtime polling", () => {
    const source = readSource();
    const realtimeStart = source.indexOf("const connectWorkspaceEvents = () => {");
    const realtimeEnd = source.indexOf("async function loadWorkspace", realtimeStart);
    expect(realtimeStart).toBeGreaterThan(-1);
    expect(realtimeEnd).toBeGreaterThan(realtimeStart);
    const realtimeSource = source.slice(realtimeStart, realtimeEnd);

    expect(realtimeSource).toContain('socket.addEventListener("open"');
    expect(realtimeSource).toContain("requestEvents()");
    expect(realtimeSource).toContain('if (envelope.hasMore)');
    expect(realtimeSource).toContain("window.setTimeout(requestEvents, 0)");
    expect(realtimeSource).not.toContain("setInterval(requestEvents");
    expect(realtimeSource).not.toContain("pollTimer");
  });

  it("clears shared-space state when realtime reports auth loss", () => {
    const source = readSource();
    const realtimeStart = source.indexOf("const connectWorkspaceEvents = () => {");
    const realtimeEnd = source.indexOf("async function loadWorkspace", realtimeStart);
    expect(realtimeStart).toBeGreaterThan(-1);
    expect(realtimeEnd).toBeGreaterThan(realtimeStart);
    const realtimeSource = source.slice(realtimeStart, realtimeEnd);

    expect(realtimeSource).toContain("if (envelope.error)");
    expect(realtimeSource).toContain("handleWorkspaceRealtimeError(envelope.error);");

    const errorHandlerStart = source.indexOf("function handleWorkspaceRealtimeError");
    const errorHandlerEnd = source.indexOf("async function logoutWorkspace", errorHandlerStart);
    expect(errorHandlerStart).toBeGreaterThan(-1);
    expect(errorHandlerEnd).toBeGreaterThan(errorHandlerStart);
    const errorHandlerSource = source.slice(errorHandlerStart, errorHandlerEnd);
    expect(errorHandlerSource).toContain('if (error?.code === "auth.required")');
    expect(errorHandlerSource).toContain("clearWorkspaceClientState();");
    expect(errorHandlerSource).toContain('setWorkspaceStatus("auth");');
    expect(errorHandlerSource).toContain("setWorkspaceError(error.message || \"登录后进入共享空间。\")");
    expect(errorHandlerSource).toContain('setWorkspaceRealtimeState("error")');
    expect(errorHandlerSource).toContain('showWorkspaceNotice("warning", error?.message || "实时同步异常")');
  });

  it("deduplicates realtime events, applies them in sequence order, and syncs on gaps", () => {
    const source = readSource();
    const realtimeStart = source.indexOf("const connectWorkspaceEvents = () => {");
    const realtimeEnd = source.indexOf("async function loadWorkspace", realtimeStart);
    expect(realtimeStart).toBeGreaterThan(-1);
    expect(realtimeEnd).toBeGreaterThan(realtimeStart);
    const realtimeSource = source.slice(realtimeStart, realtimeEnd);

    expect(source).toContain("const workspaceSeenEventIdsRef = useRef<Set<string>>(new Set());");
    expect(source).toContain("workspaceSeenEventIdsRef.current.clear();");
    expect(source).toContain("function normalizeWorkspaceRealtimeEvents(events: WorkspaceEvent[])");
    expect(source).toContain(".filter((event) => event.id && !workspaceSeenEventIdsRef.current.has(event.id))");
    expect(source).toContain(".sort((left, right) => left.seq - right.seq)");
    expect(source).toContain("function hasWorkspaceRealtimeGap(events: WorkspaceEvent[])");
    expect(source).toContain("if (event.seq !== expectedSeq + 1)");
    expect(source).toContain("function rememberWorkspaceRealtimeEvents(events: WorkspaceEvent[])");
    expect(source).toContain("workspaceSeenEventIdsRef.current.add(event.id)");
    expect(source).toContain("async function syncWorkspaceRealtimeState(currentSeqValue?: number)");
    expect(realtimeSource).toContain("const events = normalizeWorkspaceRealtimeEvents(getWorkspaceRealtimeEvents(envelope));");
    expect(realtimeSource).toContain("if (hasWorkspaceRealtimeGap(events))");
    expect(realtimeSource).toContain("void syncWorkspaceRealtimeState(Number(envelope.currentSeq));");
    expect(realtimeSource).toContain("rememberWorkspaceRealtimeEvents(events);");
  });

  it("refreshes current-user permissions after realtime role updates", () => {
    const source = readSource();
    const eventProjectorStart = source.indexOf("async function projectWorkspaceEvents");
    const eventProjectorEnd = source.indexOf("function getWorkspaceEventPayload", eventProjectorStart);
    expect(eventProjectorStart).toBeGreaterThan(-1);
    expect(eventProjectorEnd).toBeGreaterThan(eventProjectorStart);
    const eventProjectorSource = source.slice(eventProjectorStart, eventProjectorEnd);

    expect(eventProjectorSource).toContain('if (event.type === "workspace.member_joined" || event.type === "workspace.member_updated")');
    expect(eventProjectorSource).toContain('event.type === "workspace.member_updated" && payload.userId === workspaceBootstrap?.auth.currentUser.id');
    expect(eventProjectorSource).toContain("needsBootstrap = true;");
    expect(eventProjectorSource).toContain("if (needsBootstrap) tasks.push(refreshWorkspaceBootstrap());");

    const tabFallbackStart = source.indexOf("workspaceSpaceTab === \"invites\" && !workspaceBootstrap?.permissions.canCreateMemberInvite");
    const tabFallbackEnd = source.indexOf("}, [", tabFallbackStart);
    expect(tabFallbackStart).toBeGreaterThan(-1);
    expect(tabFallbackEnd).toBeGreaterThan(tabFallbackStart);
    const tabFallbackSource = source.slice(tabFallbackStart, tabFallbackEnd);
    expect(tabFallbackSource).toContain('workspaceSpaceTab === "roles" && !workspaceBootstrap?.permissions.canCreatePrivilegedInvite');
    expect(tabFallbackSource).toContain('setWorkspaceSpaceTab("overview")');
  });

  it("uses targeted active-message refetch when realtime message payload is partial", () => {
    const source = readSource();
    const refreshStart = source.indexOf("async function refreshWorkspaceConversationMessages");
    const refreshEnd = source.indexOf("function normalizeWorkspaceRealtimeEvents", refreshStart);
    expect(refreshStart).toBeGreaterThan(-1);
    expect(refreshEnd).toBeGreaterThan(refreshStart);
    const refreshSource = source.slice(refreshStart, refreshEnd);

    expect(refreshSource).toContain("if (!workspaceBootstrap?.permissions.canReadConversations || !conversationId)");
    expect(refreshSource).toContain('new URLSearchParams({ limit: "40" })');
    expect(refreshSource).toContain("`/api/workspace/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`");
    expect(refreshSource).toContain("conversation.id === conversationId");
    expect(refreshSource).toContain("latestMessages: data.messages");

    const eventProjectorStart = source.indexOf("async function projectWorkspaceEvents");
    const eventProjectorEnd = source.indexOf("function getWorkspaceEventPayload", eventProjectorStart);
    expect(eventProjectorStart).toBeGreaterThan(-1);
    expect(eventProjectorEnd).toBeGreaterThan(eventProjectorStart);
    const eventProjectorSource = source.slice(eventProjectorStart, eventProjectorEnd);

    expect(eventProjectorSource).toContain('if (event.type === "message.created")');
    expect(eventProjectorSource).toContain("upsertWorkspaceMessage(payload.message, payload.conversation)");
    expect(eventProjectorSource).toContain("payload.conversationId && payload.conversationId === workspaceSelectedConversationId");
    expect(eventProjectorSource).toContain("tasks.push(refreshWorkspaceConversationMessages(payload.conversationId));");
    expect(eventProjectorSource).toContain("needsConversations = true;");
  });

  it("does not expose operation-record role language in regular member surfaces", () => {
    const source = readSource();

    expect(source).not.toContain("记录查看");
    expect(source).toContain('{ id: "auditor" as const, label: "预留角色", visible: workspaceBootstrap.permissions.canCreatePrivilegedInvite }');
    expect(source).toContain('.filter((filter) => filter.id !== "auditor" || filter.visible)');
    expect(source).toContain('WORKSPACE_ROLE_OPTIONS.filter((role) => role !== "auditor" || workspaceBootstrap.permissions.canCreatePrivilegedInvite)');
  });

  it("uses message-retention language instead of operation-record language", () => {
    const source = readSource();
    const renderStart = source.indexOf('{lane === "workspace-dev" && (');
    const renderEnd = source.indexOf("function parsePeerMessage", renderStart);
    expect(renderStart).toBeGreaterThan(-1);
    expect(renderEnd).toBeGreaterThan(renderStart);
    const workspaceRenderSource = source.slice(renderStart, renderEnd);

    expect(workspaceRenderSource).toContain("消息保留");
    expect(workspaceRenderSource).not.toContain("历史记录");
    expect(workspaceRenderSource).not.toContain("<span>历史</span>");
  });

  it("opens the invite surface directly from privileged member directory actions", () => {
    const source = readSource();
    const start = source.indexOf('{workspaceBootstrap.permissions.canCreateMemberInvite && (');
    const end = source.indexOf('<label className="workspace-search">', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const inviteActionSource = source.slice(start, end);
    expect(inviteActionSource).toContain('setWorkspaceView("space")');
    expect(inviteActionSource).toContain('setWorkspaceSpaceTab("invites")');
    expect(inviteActionSource).toContain('setWorkspaceMobilePane("main")');
  });

  it("requires confirmation for every role change and shows selected group member count", () => {
    const source = readSource();
    const roleChangeStart = source.indexOf("async function updateWorkspaceMemberRole");
    const roleChangeEnd = source.indexOf("async function removeWorkspaceMember", roleChangeStart);
    expect(roleChangeStart).toBeGreaterThan(-1);
    expect(roleChangeEnd).toBeGreaterThan(roleChangeStart);

    const roleChangeSource = source.slice(roleChangeStart, roleChangeEnd);
    expect(roleChangeSource).toContain("const confirmation =");
    expect(roleChangeSource).toContain("window.confirm(confirmation)");
    expect(roleChangeSource).toContain('role === "owner"');
    expect(roleChangeSource).toContain('member.role === "owner"');

    expect(source).toContain("workspace-selection-count");
    expect(source).toContain("已选 {workspaceGroupMemberIds.length} 位");
  });

  it("requires at least one selected member before creating a group", () => {
    const source = readSource();
    const createGroupStart = source.indexOf("async function createWorkspaceGroup");
    const createGroupEnd = source.indexOf("async function addWorkspaceGroupMember", createGroupStart);
    expect(createGroupStart).toBeGreaterThan(-1);
    expect(createGroupEnd).toBeGreaterThan(createGroupStart);
    const createGroupSource = source.slice(createGroupStart, createGroupEnd);

    expect(createGroupSource).toContain("workspaceGroupMemberIds.length === 0");
    expect(createGroupSource).toContain("请选择至少一位群聊成员");

    const renderStart = source.indexOf("workspace-selection-count");
    const renderEnd = source.indexOf("</form>", renderStart);
    expect(renderStart).toBeGreaterThan(-1);
    expect(renderEnd).toBeGreaterThan(renderStart);
    const renderSource = source.slice(renderStart, renderEnd);
    expect(renderSource).toContain("disabled={workspaceGroupMemberIds.length === 0}");
  });

  it("requires confirmation for risky shared-space actions", () => {
    const source = readSource();
    const riskyActions = [
      "removeWorkspaceMember",
      "removeWorkspaceGroupMember",
      "leaveWorkspaceGroup",
      "revokeWorkspaceInvite",
      "removeWorkspaceFile"
    ];

    for (const action of riskyActions) {
      const start = source.indexOf(`async function ${action}`);
      const end = source.indexOf("\n  async function", start + 1);
      expect(start, `${action} should exist`).toBeGreaterThan(-1);
      const actionSource = source.slice(start, end > start ? end : undefined);
      expect(actionSource, `${action} should confirm before mutating`).toContain("window.confirm");
    }
  });

  it("keeps create-chat and create-group sheets keyboard accessible", () => {
    const source = readSource();
    const renderStart = source.indexOf('{workspaceCreateMode && (');
    const renderEnd = source.indexOf('{!workspaceCreateMode && workspaceView === "chat"', renderStart);
    expect(renderStart).toBeGreaterThan(-1);
    expect(renderEnd).toBeGreaterThan(renderStart);
    const createSheetSource = source.slice(renderStart, renderEnd);

    expect(source).toContain("const workspaceCreatePanelRef = useRef<HTMLDivElement | null>(null);");
    expect(source).toContain("const workspaceCreateSearchInputRef = useRef<HTMLInputElement | null>(null);");
    expect(source).toContain("workspaceCreateSearchInputRef.current?.focus()");
    expect(source).toContain('if (event.key === "Escape")');
    expect(source).toContain('if (event.key !== "Tab" || !workspaceCreatePanelRef.current)');
    expect(source).toContain("last.focus()");
    expect(source).toContain("first.focus()");
    expect(createSheetSource).toContain('role="dialog"');
    expect(createSheetSource).toContain('aria-modal="true"');
    expect(createSheetSource).toContain("ref={workspaceCreatePanelRef}");
    expect(createSheetSource).toContain("onKeyDown={handleWorkspaceCreatePanelKeyDown}");
    expect(createSheetSource).toContain("ref={workspaceCreateSearchInputRef}");
    expect(createSheetSource).toContain("onClick={closeWorkspaceCreate}");
  });

  it("uses a multiline chat composer with keyboard send behavior", () => {
    const source = readSource();
    const chatPanelStart = source.indexOf("function ChatPanel");
    const chatPanelEnd = source.indexOf("function MentionPicker", chatPanelStart);
    expect(chatPanelStart).toBeGreaterThan(-1);
    expect(chatPanelEnd).toBeGreaterThan(chatPanelStart);
    const chatPanelSource = source.slice(chatPanelStart, chatPanelEnd);

    expect(chatPanelSource).toContain("const composerFormRef = useRef<HTMLFormElement | null>(null);");
    expect(chatPanelSource).toContain("const handleDraftKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {");
    expect(chatPanelSource).toContain('event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey');
    expect(chatPanelSource).toContain("composerFormRef.current?.requestSubmit()");
    expect(chatPanelSource).toContain('<form ref={composerFormRef}');
    expect(chatPanelSource).toContain("<textarea");
    expect(chatPanelSource).toContain("rows={1}");
    expect(chatPanelSource).toContain("onKeyDown={handleDraftKeyDown}");

    const styles = readStyles();
    expect(styles).toContain(".composer textarea {");
    expect(styles).toContain("max-height: 128px;");
    expect(styles).toContain("resize: none;");
  });

  it("falls back to server plainText when structured message blocks are unknown", () => {
    const source = readSource();
    const structuredStart = source.indexOf("function WorkspaceStructuredMessage");
    const structuredEnd = source.indexOf("function ChatPanel", structuredStart);
    expect(structuredStart).toBeGreaterThan(-1);
    expect(structuredEnd).toBeGreaterThan(structuredStart);
    const structuredSource = source.slice(structuredStart, structuredEnd);

    expect(structuredSource).toContain("const hasUnknownBlock = blocks.some((block) => !isKnownWorkspaceMessageBlock(block));");
    expect(structuredSource).toContain("blocks.length === 0 || hasUnknownBlock");
    expect(structuredSource).toContain("return <MessageBody body={message.body} />;");
    expect(structuredSource).toContain("function isKnownWorkspaceMessageBlock");
    expect(structuredSource).toContain('block.type === "attachment"');
    expect(structuredSource).not.toContain("return null;");
  });

  it("renders workspace system messages with system author semantics", () => {
    const source = readSource();
    const messageMapStart = source.indexOf("const serverMessages = rawMessages.map((message) => {");
    const messageMapEnd = source.indexOf("const localMessages = workspaceLocalMessages", messageMapStart);
    expect(messageMapStart).toBeGreaterThan(-1);
    expect(messageMapEnd).toBeGreaterThan(messageMapStart);
    const messageMapSource = source.slice(messageMapStart, messageMapEnd);

    expect(messageMapSource).toContain('message.kind === "system" || message.authorKind === "system"');
    expect(messageMapSource).toContain('? "系统"');
    expect(messageMapSource).toContain("author,");

    const chatPanelStart = source.indexOf("function ChatPanel");
    const chatPanelEnd = source.indexOf("function MentionPicker", chatPanelStart);
    const chatPanelSource = source.slice(chatPanelStart, chatPanelEnd);
    expect(chatPanelSource).toContain('message.author === "系统" ? "message system"');
    expect(chatPanelSource).toContain('message.author !== "系统" && !message.localState');
  });

  it("keeps chat drafts and reply targets scoped to each conversation", () => {
    const source = readSource();

    expect(source).toContain("const [workspaceDraftByConversation, setWorkspaceDraftByConversation] = useState<Record<string, string>>({});");
    expect(source).toContain("const [workspaceReplyToMessageIdByConversation, setWorkspaceReplyToMessageIdByConversation] = useState<Record<string, string>>({});");
    expect(source).toContain("const workspaceDraft = workspaceSelectedConversationId ? workspaceDraftByConversation[workspaceSelectedConversationId] ?? \"\" : \"\";");
    expect(source).toContain("? workspaceReplyToMessageIdByConversation[workspaceSelectedConversationId] ?? \"\"");
    expect(source).toContain("function setWorkspaceConversationDraft(conversationId: string, draft: string)");
    expect(source).toContain("function setWorkspaceConversationReplyToMessageId(conversationId: string, messageId: string)");
    expect(source).toContain("onDraft={(draft) => setWorkspaceConversationDraft(workspaceSelectedConversation.id, draft)}");
    expect(source).toContain("onReply={(messageId) => setWorkspaceConversationReplyToMessageId(workspaceSelectedConversation.id, messageId)}");
    expect(source).toContain("onCancelReply={() => setWorkspaceConversationReplyToMessageId(workspaceSelectedConversation.id, \"\")}");
    expect(source).toContain("setWorkspaceDraftByConversation({});");
    expect(source).toContain("setWorkspaceReplyToMessageIdByConversation({});");

    const conversationSwitchStart = source.indexOf('if (workspaceSelectedConversation?.type === "group")');
    const conversationSwitchEnd = source.indexOf("}, [workspaceContextTab, workspaceSelectedConversation?.id", conversationSwitchStart);
    expect(conversationSwitchStart).toBeGreaterThan(-1);
    expect(conversationSwitchEnd).toBeGreaterThan(conversationSwitchStart);
    const conversationSwitchSource = source.slice(conversationSwitchStart, conversationSwitchEnd);
    expect(conversationSwitchSource).not.toContain("setWorkspaceDraftByConversation");
    expect(conversationSwitchSource).not.toContain("setWorkspaceReplyToMessageIdByConversation");
  });

  it("uses server-projected member labels and direct-chat capabilities", () => {
    const source = readSource();
    const typeStart = source.indexOf("type WorkspaceUser = {");
    const typeEnd = source.indexOf("type WorkspacePermissions", typeStart);
    expect(typeStart).toBeGreaterThan(-1);
    expect(typeEnd).toBeGreaterThan(typeStart);
    const typeSource = source.slice(typeStart, typeEnd);
    expect(typeSource).toContain("roleLabel?: string;");
    expect(typeSource).toContain("canStartDirectConversation?: boolean;");

    expect(source).toContain("function workspaceMemberRoleLabel");
    expect(source).toContain("return member.roleLabel || workspaceRoleLabel(member.role);");

    const selectableStart = source.indexOf("const workspaceSelectableMembers = useMemo");
    const selectableEnd = source.indexOf("const workspaceAddableMembers = useMemo", selectableStart);
    expect(selectableStart).toBeGreaterThan(-1);
    expect(selectableEnd).toBeGreaterThan(selectableStart);
    const selectableSource = source.slice(selectableStart, selectableEnd);
    expect(selectableSource).toContain("member.capabilities?.canStartDirectConversation !== false");
    expect(selectableSource).toContain("workspaceMemberRoleLabel(member)");

    const addableStart = selectableEnd;
    const addableEnd = source.indexOf("const workspaceContextMemberQueryText", addableStart);
    expect(addableEnd).toBeGreaterThan(addableStart);
    const addableSource = source.slice(addableStart, addableEnd);
    expect(addableSource).toContain("member.capabilities?.canStartDirectConversation !== false");
    expect(addableSource).toContain("!workspaceSelectedConversation?.members.some((item) => item.id === member.id)");

    const renderStart = source.indexOf("workspaceFilteredMembers.map((member) => (");
    const renderEnd = source.indexOf("{!workspaceCreateMode && workspaceView === \"space\"", renderStart);
    expect(renderStart).toBeGreaterThan(-1);
    expect(renderEnd).toBeGreaterThan(renderStart);
    const renderSource = source.slice(renderStart, renderEnd);
    expect(renderSource).toContain("workspaceMemberRoleLabel(member)");
    expect(renderSource).toContain("member.capabilities?.canStartDirectConversation !== false");
  });

  it("keeps read and notification state on the conversation view model", () => {
    const source = readSource();
    const typeStart = source.indexOf("type WorkspaceConversation = {");
    const typeEnd = source.indexOf("type WorkspaceEvent =", typeStart);
    expect(typeStart).toBeGreaterThan(-1);
    expect(typeEnd).toBeGreaterThan(typeStart);
    const typeSource = source.slice(typeStart, typeEnd);
    expect(typeSource).toContain("unreadCount?: number;");
    expect(typeSource).toContain("lastReadMessageId?: string | null;");
    expect(typeSource).toContain("lastReadAt?: string | null;");
    expect(typeSource).toContain("lastReadSeq?: number | null;");
    expect(typeSource).toContain('notificationLevel?: "all" | "mentions" | "muted";');
  });

  it("keeps conversation notification settings scoped to the selected conversation", () => {
    const source = readSource();
    const settingsStart = source.indexOf('{workspaceContextTab === "settings" && (');
    const settingsEnd = source.indexOf("</aside>", settingsStart);
    expect(settingsStart).toBeGreaterThan(-1);
    expect(settingsEnd).toBeGreaterThan(settingsStart);
    const settingsSource = source.slice(settingsStart, settingsEnd);

    expect(source).toContain('type WorkspaceNotificationLevel = "all" | "mentions" | "muted";');
    expect(source).toContain("function workspaceNotificationLevelLabel");
    expect(source).toContain("function workspaceNotificationLevelDescription");
    expect(source).toContain("async function updateWorkspaceConversationNotification");
    expect(source).toContain('`/api/workspace/conversations/${encodeURIComponent(workspaceSelectedConversation.id)}/notification`');
    expect(source).toContain("body: JSON.stringify({ level })");
    expect(source).toContain('if (event.type === "conversation.notification_updated")');
    expect(settingsSource).toContain("会话提醒");
    expect(settingsSource).toContain('aria-label="会话提醒设置"');
    expect(settingsSource).toContain('(["all", "mentions", "muted"] as WorkspaceNotificationLevel[]).map((level)');
    expect(settingsSource).toContain("workspaceNotificationLevelLabel(level)");
    expect(settingsSource).toContain("workspaceNotificationLevelDescription(workspaceSelectedConversation.notificationLevel)");
  });

  it("keeps direct conversation display helpers in the client model", () => {
    const source = readSource();
    const typeStart = source.indexOf("type WorkspaceConversation = {");
    const typeEnd = source.indexOf("type WorkspaceEvent =", typeStart);
    expect(typeStart).toBeGreaterThan(-1);
    expect(typeEnd).toBeGreaterThan(typeStart);
    const typeSource = source.slice(typeStart, typeEnd);
    expect(typeSource).toContain("displayTitle?: string;");
    expect(typeSource).toContain("otherMember?: WorkspaceUser | null;");

    const helperStart = source.indexOf("function workspaceConversationTitle");
    const helperEnd = source.indexOf("function workspaceConversationMemberCount", helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helperSource = source.slice(helperStart, helperEnd);
    expect(helperSource.indexOf("if (conversation.displayTitle)")).toBeLessThan(helperSource.indexOf('if (conversation.type === "direct")'));
  });

  it("clears local chat state when realtime removes the current user from a conversation", () => {
    const source = readSource();
    const functionStart = source.indexOf("function removeWorkspaceConversationMember");
    const functionEnd = source.indexOf("function upsertWorkspaceMessage", functionStart);
    expect(functionStart).toBeGreaterThan(-1);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = source.slice(functionStart, functionEnd);

    expect(functionSource).toContain("const removedCurrentUser = userId === currentUserId;");
    expect(functionSource).toContain(".filter((conversation) => conversation.id !== conversationId || !removedCurrentUser)");
    expect(functionSource).toContain("setWorkspaceDraftByConversation((drafts) => {");
    expect(functionSource).toContain("setWorkspaceReplyToMessageIdByConversation((replyTargets) => {");
    expect(functionSource).toContain("setWorkspaceLocalMessages((messages) => messages.filter((message) => message.conversationId !== conversationId));");
    expect(functionSource).toContain("setWorkspaceFiles((files) => files.filter((file) => file.conversationId !== conversationId));");
    expect(functionSource).toContain("setWorkspaceLibraryFiles((files) => files.filter((file) => file.conversationId !== conversationId));");
    expect(functionSource).toContain("setWorkspaceSelectedConversationId(\"\");");
    expect(functionSource).toContain("setWorkspaceContextMode(\"conversation\");");
    expect(functionSource).toContain("setWorkspaceContextTab(\"overview\");");
    expect(functionSource).toContain("setWorkspaceMobilePane(\"list\");");
    expect(functionSource).toContain("你已不在此群聊中。");
  });

  it("keeps group administration controls behind group-management permission checks", () => {
    const source = readSource();

    expect(source).toContain('{workspaceBootstrap.permissions.canCreateGroup && (');
    expect(source).toContain("const workspaceCanManageSelectedGroup = Boolean(");
    expect(source).toContain('workspaceSelectedConversation.capabilities?.canManageMembers');
    expect(source).toContain('if (!workspaceSelectedConversation || !workspaceCanManageSelectedGroup) {');
    expect(source).toContain('workspaceSelectedConversation.type === "group" && workspaceCanManageSelectedGroup');
    expect(source).toContain('workspaceCanManageSelectedGroup &&\n                                    member.id !== workspaceBootstrap.auth.currentUser.id');
    expect(source).toContain('{workspaceCanManageSelectedGroup ? (');
  });

  it("keeps direct-chat details focused on overview and files only", () => {
    const source = readSource();
    const visibleTabsStart = source.indexOf("const workspaceVisibleContextTabs = useMemo");
    const visibleTabsEnd = source.indexOf("const workspaceFilteredConversations = useMemo", visibleTabsStart);
    expect(visibleTabsStart).toBeGreaterThan(-1);
    expect(visibleTabsEnd).toBeGreaterThan(visibleTabsStart);
    const visibleTabsSource = source.slice(visibleTabsStart, visibleTabsEnd);

    expect(visibleTabsSource).toContain('{ id: "overview" as const, label: "概览", visible: true }');
    expect(visibleTabsSource).toContain('{ id: "files" as const, label: "文件", visible: true }');
    expect(visibleTabsSource).toContain('{ id: "members" as const, label: "成员", visible: workspaceSelectedConversation?.type === "group" }');
    expect(visibleTabsSource).toContain('{ id: "settings" as const, label: "设置", visible: workspaceSelectedConversation?.type === "group" }');
    expect(source).toContain('if (workspaceContextTab === "members" || workspaceContextTab === "settings")');
    expect(source).toContain('setWorkspaceContextTab("overview")');
    expect(source).toContain("workspaceVisibleContextTabs.map((tab) => (");
  });

  it("projects pending and failed attachment realtime events into file state", () => {
    const source = readSource();
    const eventProjectorStart = source.indexOf('if (event.type === "attachment.created" || event.type === "attachment.available" || event.type === "attachment.failed")');
    const eventProjectorEnd = source.indexOf('if (event.type === "attachment.removed")', eventProjectorStart);
    expect(eventProjectorStart).toBeGreaterThan(-1);
    expect(eventProjectorEnd).toBeGreaterThan(eventProjectorStart);
    const attachmentEventSource = source.slice(eventProjectorStart, eventProjectorEnd);
    expect(attachmentEventSource).toContain("upsertWorkspaceFile(payload.attachment)");

    const functionStart = source.indexOf("function upsertWorkspaceFile");
    const functionEnd = source.indexOf("function openWorkspaceAttachmentFile", functionStart);
    expect(functionStart).toBeGreaterThan(-1);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = source.slice(functionStart, functionEnd);
    expect(functionSource).not.toContain('workspaceFile.status !== "available"');
    expect(functionSource).toContain('workspaceFile.status === "available"');
    expect(functionSource).toContain("upsertById(");
  });

  it("keeps file-library selection connected to the file detail drawer", () => {
    const source = readSource();
    const selectedFileStart = source.indexOf("const workspaceSelectedFile = useMemo");
    const selectedFileEnd = source.indexOf("const workspaceSelectedFileConversation = useMemo", selectedFileStart);
    expect(selectedFileStart).toBeGreaterThan(-1);
    expect(selectedFileEnd).toBeGreaterThan(selectedFileStart);
    const selectedFileSource = source.slice(selectedFileStart, selectedFileEnd);

    expect(selectedFileSource).toContain("workspaceFiles.find((file) => file.id === workspaceSelectedFileId)");
    expect(selectedFileSource).toContain("workspaceLibraryFiles.find((file) => file.id === workspaceSelectedFileId)");
    expect(selectedFileSource).toContain("[workspaceFiles, workspaceLibraryFiles, workspaceSelectedFileId]");

    const selectedFileCleanupStart = source.indexOf("if (\n      workspaceSelectedFileId &&");
    const selectedFileCleanupEnd = source.indexOf("}, [workspaceFiles, workspaceLibraryFiles, workspaceSelectedFileId]);", selectedFileCleanupStart);
    expect(selectedFileCleanupStart).toBeGreaterThan(-1);
    expect(selectedFileCleanupEnd).toBeGreaterThan(selectedFileCleanupStart);
    const selectedFileCleanupSource = source.slice(selectedFileCleanupStart, selectedFileCleanupEnd);
    expect(selectedFileCleanupSource).toContain("!workspaceFiles.some((file) => file.id === workspaceSelectedFileId)");
    expect(selectedFileCleanupSource).toContain("!workspaceLibraryFiles.some((file) => file.id === workspaceSelectedFileId)");
  });

  it("releases reserved upload quota when the client upload flow fails", () => {
    const source = readSource();
    const submitStart = source.indexOf("async function submitWorkspaceFileUpload");
    const submitEnd = source.indexOf("async function releaseWorkspaceUploadReservation", submitStart);
    expect(submitStart).toBeGreaterThan(-1);
    expect(submitEnd).toBeGreaterThan(submitStart);
    const submitSource = source.slice(submitStart, submitEnd);

    expect(submitSource).toContain('let reservedUploadId = ""');
    expect(submitSource).toContain('reservedUploadId = reserve.id');
    expect(submitSource).toContain("if (reservedUploadId && !uploadCompleted) {");
    expect(submitSource).toContain("await releaseWorkspaceUploadReservation(reservedUploadId");
    expect(submitSource).toContain("throw error");

    const releaseStart = submitEnd;
    const releaseEnd = source.indexOf("function setWorkspaceFileLocalState", releaseStart);
    expect(releaseEnd).toBeGreaterThan(releaseStart);
    const releaseSource = source.slice(releaseStart, releaseEnd);
    expect(releaseSource).toContain('`/api/workspace/files/uploads/${encodeURIComponent(uploadId)}/fail`');
    expect(releaseSource).toContain('method: "POST"');
    expect(releaseSource).toContain("await refreshWorkspaceBootstrap()");
  });

  it("keeps chat file uploads as retryable message cards after content upload succeeds", () => {
    const source = readSource();
    const localTypeStart = source.indexOf("type WorkspaceLocalMessage = {");
    const localTypeEnd = source.indexOf("};", localTypeStart);
    expect(localTypeStart).toBeGreaterThan(-1);
    expect(localTypeEnd).toBeGreaterThan(localTypeStart);
    const localTypeSource = source.slice(localTypeStart, localTypeEnd);
    expect(localTypeSource).toContain("attachments?: WorkspaceAttachment[];");

    const localMessagesStart = source.indexOf("const localMessages = workspaceLocalMessages");
    const localMessagesEnd = source.indexOf("return [...serverMessages, ...localMessages]", localMessagesStart);
    expect(localMessagesStart).toBeGreaterThan(-1);
    expect(localMessagesEnd).toBeGreaterThan(localMessagesStart);
    const localMessagesSource = source.slice(localMessagesStart, localMessagesEnd);
    expect(localMessagesSource).toContain("attachments: message.attachments ?? []");

    const submitStart = source.indexOf("async function submitWorkspaceFileUpload");
    const submitEnd = source.indexOf("async function releaseWorkspaceUploadReservation", submitStart);
    expect(submitStart).toBeGreaterThan(-1);
    expect(submitEnd).toBeGreaterThan(submitStart);
    const submitSource = source.slice(submitStart, submitEnd);

    expect(submitSource).toContain("let uploadCompleted = false");
    expect(submitSource).toContain("uploadCompleted = true");
    expect(submitSource).toContain("attachments: [completed.attachment]");
    expect(submitSource).toContain('state: "sending"');
    expect(submitSource).toContain('const message = error instanceof Error ? error.message : "文件已上传，消息发送失败"');
    expect(submitSource).toContain('state: "failed"');
    expect(submitSource).toContain("showWorkspaceNotice(\"warning\", message)");
    expect(submitSource).toContain("return;");
    expect(submitSource).toContain("if (reservedUploadId && !uploadCompleted) {");
    expect(submitSource).toContain("await releaseWorkspaceUploadReservation(reservedUploadId");
    expect(submitSource.indexOf("uploadCompleted = true")).toBeLessThan(submitSource.indexOf("await submitWorkspaceMessage"));
  });

  it("refreshes quota after a reserved download fails before the browser save starts", () => {
    const source = readSource();
    const downloadStart = source.indexOf("async function reserveWorkspaceDownload");
    const downloadEnd = source.indexOf("async function removeWorkspaceFile", downloadStart);
    expect(downloadStart).toBeGreaterThan(-1);
    expect(downloadEnd).toBeGreaterThan(downloadStart);
    const downloadSource = source.slice(downloadStart, downloadEnd);

    expect(downloadSource).toContain("let downloadReserved = false");
    expect(downloadSource).toContain("downloadReserved = true");
    expect(downloadSource).toContain("if (downloadReserved) {");
    expect(downloadSource).toContain("await refreshWorkspaceBootstrap()");
    expect(downloadSource.indexOf("downloadReserved = true")).toBeLessThan(downloadSource.indexOf("const response = await workspaceFetch"));
  });

  it("gates file downloads with the download permission capability", () => {
    const source = readSource();
    const downloadStart = source.indexOf("async function reserveWorkspaceDownload");
    const downloadEnd = source.indexOf("async function removeWorkspaceFile", downloadStart);
    expect(downloadStart).toBeGreaterThan(-1);
    expect(downloadEnd).toBeGreaterThan(downloadStart);
    const downloadSource = source.slice(downloadStart, downloadEnd);

    expect(downloadSource).toContain("!workspaceBootstrap?.permissions.canDownload");
    expect(downloadSource).toContain("你当前不能下载文件。");

    const renderStart = source.indexOf('disabled={\n                                  !workspaceBootstrap.permissions.canDownload');
    const renderEnd = source.indexOf("onClick={() => void reserveWorkspaceDownload(workspaceSelectedFile)}", renderStart);
    expect(renderStart).toBeGreaterThan(-1);
    expect(renderEnd).toBeGreaterThan(renderStart);
    const renderSource = source.slice(renderStart, renderEnd);
    expect(renderSource).toContain("!workspaceBootstrap.permissions.canDownload");
    expect(renderSource).toContain("workspaceSelectedFile.status !== \"available\"");
  });

  it("prefers server-projected file capabilities for remove actions", () => {
    const source = readSource();
    const helperStart = source.indexOf("function canRemoveWorkspaceFile");
    const helperEnd = source.indexOf("function buildWorkspaceMessageBlocks", helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helperSource = source.slice(helperStart, helperEnd);

    expect(helperSource).toContain('typeof file.capabilities?.canRemove === "boolean"');
    expect(helperSource).toContain("return file.capabilities.canRemove;");
    expect(helperSource).toContain('currentUser.role === "owner"');
  });

  it("uses server-created invite links when showing new invites", () => {
    const source = readSource();
    const typeStart = source.indexOf("type WorkspaceInvite = {");
    const typeEnd = source.indexOf("type WorkspaceContentBlock", typeStart);
    expect(typeStart).toBeGreaterThan(-1);
    expect(typeEnd).toBeGreaterThan(typeStart);
    const typeSource = source.slice(typeStart, typeEnd);
    expect(typeSource).toContain("inviteUrl?: string;");

    const createStart = source.indexOf("async function createWorkspaceInvite");
    const createEnd = source.indexOf("async function revokeWorkspaceInvite", createStart);
    expect(createStart).toBeGreaterThan(-1);
    expect(createEnd).toBeGreaterThan(createStart);
    const createSource = source.slice(createStart, createEnd);
    expect(createSource).toContain("data.invite.inviteUrl ||");
    expect(createSource).toContain("getWorkspaceEntryUrl(data.invite.code || \"\")");

    const copyStart = source.indexOf("async function copyWorkspaceInviteLink");
    const copyEnd = source.indexOf("async function revokeWorkspaceInvite", copyStart);
    expect(copyStart).toBeGreaterThan(-1);
    expect(copyEnd).toBeGreaterThan(copyStart);
    const copySource = source.slice(copyStart, copyEnd);
    expect(copySource).toContain("await copyText(value)");
    expect(copySource).toContain("邀请链接已复制。");
    expect(copySource).toContain("复制失败，请手动选择邀请链接。");
    expect(source).toContain("onClick={() => void copyWorkspaceInviteLink(workspaceInviteCode)}");
  });

  it("keeps file-library rows directly downloadable with quota and permission guards", () => {
    const source = readSource();
    const listStart = source.indexOf("workspaceFilteredFiles.map((file) => {");
    const listEnd = source.indexOf("{!workspaceCreateMode && workspaceView === \"members\"", listStart);
    expect(listStart).toBeGreaterThan(-1);
    expect(listEnd).toBeGreaterThan(listStart);
    const fileListSource = source.slice(listStart, listEnd);

    expect(fileListSource).toContain('const quotaWarning = getWorkspaceTransferQuotaWarning(file.byteSize, "download", workspaceBootstrap.policy);');
    expect(fileListSource).toContain("!workspaceBootstrap.permissions.canDownload");
    expect(fileListSource).toContain("Boolean(quotaWarning)");
    expect(fileListSource).toContain('file.status !== "available"');
    expect(fileListSource).toContain("Boolean(file.localUpload)");
    expect(fileListSource).toContain('className="workspace-file-row-main"');
    expect(fileListSource).toContain('className="icon-button workspace-file-download"');
    expect(fileListSource).toContain("onClick={() => void reserveWorkspaceDownload(file)}");

    const styles = readStyles();
    expect(styles).toContain(".workspace-file-row-main");
    expect(styles).toContain(".workspace-file-download");
  });

  it("keeps regular-member space information useful without exposing internals", () => {
    const source = readSource();
    const styles = readStyles();
    const spaceStart = source.indexOf('{!workspaceCreateMode && workspaceView === "space" && (');
    const spaceEnd = source.indexOf('{workspaceSpaceTab === "invites"', spaceStart);
    expect(spaceStart).toBeGreaterThan(-1);
    expect(spaceEnd).toBeGreaterThan(spaceStart);
    const spaceSource = source.slice(spaceStart, spaceEnd);

    expect(spaceSource).toContain("<h2>空间信息</h2>");
    expect(spaceSource).toContain("今日传输额度");
    expect(spaceSource).toContain("消息保留");
    expect(spaceSource).toContain("共享空间保存消息和文件，方便成员稍后查看。");
    expect(spaceSource).not.toContain("audit_logs");
    expect(spaceSource).not.toContain("transfer_ledger");
    expect(styles).toContain(".workspace-space-note");
  });

  it("does not bind platform internals into the shared-space UI source", () => {
    const source = readSource();
    const renderStart = source.indexOf('{lane === "workspace-dev" && (');
    const renderEnd = source.indexOf("function parsePeerMessage", renderStart);
    expect(renderStart).toBeGreaterThan(-1);
    expect(renderEnd).toBeGreaterThan(renderStart);
    const workspaceRenderSource = source.slice(renderStart, renderEnd);

    expect(source).not.toContain("requestId");
    expect(source).not.toContain("storageKey");
    expect(source).not.toContain("githubOAuthReady");
    expect(source).not.toContain("transfer_ledger");
    expect(source).not.toContain("audit_logs");
    expect(source).not.toContain("ipAddress");
    expect(source).not.toContain("userAgent");
    expect(workspaceRenderSource).not.toContain(".seq");
    expect(workspaceRenderSource).not.toContain("payloadJson");
    expect(workspaceRenderSource).not.toContain("JSON.stringify");
  });
});
