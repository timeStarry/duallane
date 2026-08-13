import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import { createWorkspaceSession } from "./workspace.mjs";
import {
  BOT_CONVERSATION_POLICIES,
  BOT_DEFAULT_SCOPES,
  BOT_SCOPE_ALLOWLIST,
  BOT_STATUS,
  BOT_VISIBILITY_POLICIES,
  WorkspaceAgentBotError,
  canBotAuthenticate,
  canBotParticipateInConversation,
  createWorkspaceAgentBotService,
  getDefaultBotPolicy,
  hashBotToken,
  isBotToken,
  isReservedBotName,
  maskBotToken,
  validateBotScopes
} from "./workspace-agent-bots.mjs";

const SPACE_ID = "spc_default";

describe("workspace custom Agent Bot security foundation", () => {
  const fixtures = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(async ({ db, directory }) => {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it("creates a private direct-only Bot with a server-owned bot user", async () => {
    const { service, db } = await fixture();
    const bot = await service.createBot("usr_owner", { spaceId: SPACE_ID, name: "Release Helper" });
    expect(bot).toMatchObject({
      kind: "bot",
      name: "Release Helper",
      mode: "external_agent",
      status: BOT_STATUS.ACTIVE,
      visibilityPolicy: BOT_VISIBILITY_POLICIES.PRIVATE,
      conversationPolicy: BOT_CONVERSATION_POLICIES.DIRECT_ONLY,
      authenticationAllowed: false,
      canJoinGroups: false
    });
    expect(bot.botUserId).toMatch(/^usr_bot_/u);
    const storedUser = db.prepare("SELECT kind, github_login AS githubLogin, email, last_login_at AS lastLoginAt FROM users WHERE id = ?").get(bot.botUserId);
    expect(storedUser).toMatchObject({ kind: "bot", email: null, lastLoginAt: null });
    expect(storedUser.githubLogin).toMatch(/^__duallane_bot_bot_/u);
    expect(db.prepare("SELECT role, removed_at AS removedAt FROM space_members WHERE space_id = ? AND user_id = ?").get(SPACE_ID, bot.botUserId))
      .toEqual({ role: "member", removedAt: null });
    await expect(createWorkspaceSession(db, bot.botUserId)).rejects.toMatchObject({ code: "auth.identity_forbidden" });
    expect(db.prepare("SELECT owner_user_id AS ownerUserId FROM workspace_agent_bots WHERE id = ?").get(bot.id)).toEqual({ ownerUserId: "usr_owner" });
  });

  it("enforces one owned Bot per space and isolates other owners", async () => {
    const { service, db } = await fixture();
    await expect(service.createBot("usr_owner", { spaceId: SPACE_ID, name: "First" })).resolves.toMatchObject({ name: "First" });
    await expect(service.createBot("usr_owner", { spaceId: SPACE_ID, name: "Second" })).rejects.toMatchObject({ code: "bot.already_exists" });

    const other = "usr_member_bot_owner";
    await db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
      VALUES (?, NULL, ?, NULL, ?, NULL, 'human', ?, NULL)
    `).run(other, "other-owner", "Other Owner", new Date().toISOString());
    await db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at) VALUES (?, ?, 'member', ?, NULL)
    `).run(SPACE_ID, other, new Date().toISOString());
    await expect(service.createBot(other, { spaceId: SPACE_ID, name: "Other Bot" })).resolves.toMatchObject({ name: "Other Bot" });
    const first = await service.getOwnedBot("usr_owner", SPACE_ID);
    await expect(service.listTokens(other, first.id, SPACE_ID)).rejects.toMatchObject({ code: "permission.denied" });
  });

  it("rejects reserved identity names after Unicode/case normalization", async () => {
    const { service, db } = await fixture();
    for (const name of ["信标", "回声", "beacon", "Ｅｃｈｏ", "duallane", "usr_system_echo", "__DUALLANE_BEACON__"]) {
      expect(isReservedBotName(name)).toBe(true);
      await expect(service.createBot("usr_owner", { spaceId: SPACE_ID, name })).rejects.toMatchObject({ code: "bot.reserved_name" });
      // Each rejected attempt leaves no Bot user or persisted provider data.
      await expect(service.getOwnedBot("usr_owner", SPACE_ID)).rejects.toMatchObject({ code: "bot.not_found" });
    }
    const audits = db.prepare("SELECT action, reason FROM audit_logs WHERE action = 'bot.create'").all();
    expect(audits.every((row) => row.action === "bot.create" && row.reason === "bot.reserved_name")).toBe(true);
  });

  it("validates exact scopes and keeps conservative defaults", () => {
    expect(getDefaultBotPolicy()).toEqual({
      mode: "external_agent",
      visibilityPolicy: "private",
      conversationPolicy: "direct-only",
      triggerPolicy: "mention-or-command"
    });
    expect(validateBotScopes()).toEqual([...BOT_DEFAULT_SCOPES]);
    expect(validateBotScopes([...BOT_SCOPE_ALLOWLIST].reverse())).toEqual([...BOT_SCOPE_ALLOWLIST]);
    for (const scopes of [[], ["messages:send", "messages:send"], ["owner"], ["session:issue"], ["unknown:scope"]]) {
      expect(() => validateBotScopes(scopes)).toThrowError(WorkspaceAgentBotError);
      expect(() => validateBotScopes(scopes)).toThrowError(/Bot Scope 无效/u);
    }
  });

  it("issues a one-time token, persists only its SHA-256 hash, masks future projections, and authenticates by binding", async () => {
    const { service, db } = await fixture();
    const bot = await service.createBot("usr_owner", { spaceId: SPACE_ID, name: "Gateway" });
    const issued = await service.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    expect(isBotToken(issued.token)).toBe(true);
    expect(issued.token).toMatch(/^dl_bot_/u);
    expect(issued.token).not.toBe(maskBotToken());
    const row = db.prepare("SELECT token_hash AS tokenHash, scopes_json AS scopesJson FROM workspace_agent_bot_tokens WHERE id = ?").get(issued.id);
    expect(row.tokenHash).toBe(hashBotToken(issued.token));
    expect(row.tokenHash).not.toContain(issued.token);
    expect(row.scopesJson).not.toContain("owner");
    expect((await service.listTokens("usr_owner", bot.id, SPACE_ID))[0].token).toBe(maskBotToken());
    await expect(service.authenticateToken(issued.token, { spaceId: SPACE_ID })).resolves.toMatchObject({ botId: bot.id, userId: bot.botUserId, scopes: BOT_DEFAULT_SCOPES });
    await expect(service.authenticateToken(issued.token, { spaceId: "spc_other" })).rejects.toMatchObject({ code: "bot.invalid_token", statusCode: 401 });
    await expect(service.authenticateToken(maskBotToken(), { spaceId: SPACE_ID })).rejects.toMatchObject({ code: "bot.invalid_token" });
  });

  it("supports expiry and revocation, and revokes all tokens during two-stage deletion", async () => {
    let current = new Date("2026-08-13T00:00:00.000Z");
    const { db } = await fixture();
    const service = createWorkspaceAgentBotService({ db, now: () => new Date(current) });
    const bot = await service.createBot("usr_owner", { spaceId: SPACE_ID, name: "Lifecycle" });
    const token = await service.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID, expiresAt: new Date(current.getTime() + 60_000).toISOString() });
    current = new Date(current.getTime() + 61_000);
    await expect(service.authenticateToken(token.token)).rejects.toMatchObject({ code: "bot.invalid_token" });
    const fresh = await service.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    await expect(service.revokeToken("usr_owner", bot.id, fresh.id, SPACE_ID)).resolves.toMatchObject({ token: maskBotToken() });
    await expect(service.authenticateToken(fresh.token)).rejects.toMatchObject({ code: "bot.invalid_token" });
    expect((await service.pauseBot("usr_owner", bot.id, SPACE_ID)).status).toBe(BOT_STATUS.PAUSED);
    await expect(service.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID })).rejects.toMatchObject({ code: "bot.not_active" });
    expect((await service.resumeBot("usr_owner", bot.id, SPACE_ID)).status).toBe(BOT_STATUS.ACTIVE);
    expect((await service.beginDeleteBot("usr_owner", bot.id, SPACE_ID)).status).toBe(BOT_STATUS.DELETING);
    expect((await service.finalizeDeleteBot("usr_owner", bot.id, SPACE_ID)).status).toBe(BOT_STATUS.DELETED);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_agent_bot_tokens WHERE bot_id = ? AND revoked_at IS NULL").get(bot.id).count).toBe(0);
    expect(db.prepare("SELECT removed_at AS removedAt FROM space_members WHERE space_id = ? AND user_id = ?").get(SPACE_ID, bot.botUserId).removedAt).not.toBeNull();
    const replacement = await service.createBot("usr_owner", { spaceId: SPACE_ID, name: "Lifecycle replacement" });
    expect(replacement.id).not.toBe(bot.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_agent_bots WHERE space_id = ? AND owner_user_id = ? AND status <> 'deleted'").get(SPACE_ID, "usr_owner").count).toBe(1);
    await expect(service.finalizeDeleteBot("usr_owner", bot.id, SPACE_ID)).resolves.toMatchObject({ status: BOT_STATUS.DELETED });
  });

  it("checks active status after the lifecycle lock and never inserts a token for a Bot paused in the race window", async () => {
    const { service, db } = await fixture();
    const bot = await service.createBot("usr_owner", { spaceId: SPACE_ID, name: "Race-safe token" });
    const originalLock = db.lock;
    let lifecycleLockSeen = false;
    db.lock = async (key) => {
      if (!lifecycleLockSeen && String(key).includes(`:lifecycle:${SPACE_ID}:${bot.id}`)) {
        lifecycleLockSeen = true;
        // Simulate a concurrent pause winning immediately before the token
        // transaction reads the Bot. The mutation is in the same SQLite test
        // transaction and is rolled back when issuance rejects.
        db.prepare(`
          UPDATE workspace_agent_bots SET status = ? WHERE id = ?
        `).run(BOT_STATUS.PAUSED, bot.id);
      }
      return originalLock?.(key);
    };

    await expect(service.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID }))
      .rejects.toMatchObject({ code: "bot.not_active" });
    expect(lifecycleLockSeen).toBe(true);
    expect(db.prepare("SELECT status FROM workspace_agent_bots WHERE id = ?").get(bot.id).status)
      .toBe(BOT_STATUS.ACTIVE);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_agent_bot_tokens WHERE bot_id = ?").get(bot.id).count)
      .toBe(0);
    db.lock = originalLock;
  });

  it("uses the same lifecycle lock for pause and delete transitions and rejects a stale transition", async () => {
    const { service, db } = await fixture();
    const bot = await service.createBot("usr_owner", { spaceId: SPACE_ID, name: "Race-safe lifecycle" });
    const originalLock = db.lock;
    const lockKeys = [];
    db.lock = async (key) => {
      lockKeys.push(String(key));
      return originalLock?.(key);
    };

    await expect(service.pauseBot("usr_owner", bot.id, SPACE_ID)).resolves.toMatchObject({ status: BOT_STATUS.PAUSED });
    await expect(service.beginDeleteBot("usr_owner", bot.id, SPACE_ID)).resolves.toMatchObject({ status: BOT_STATUS.DELETING });
    expect(lockKeys.filter((key) => key === `workspace-agent-bot:lifecycle:${SPACE_ID}:${bot.id}`)).toHaveLength(2);

    db.lock = async (key) => {
      if (String(key) === `workspace-agent-bot:lifecycle:${SPACE_ID}:${bot.id}`) {
        db.prepare("UPDATE workspace_agent_bots SET status = ? WHERE id = ?").run(BOT_STATUS.DELETED, bot.id);
      }
      return originalLock?.(key);
    };
    await expect(service.resumeBot("usr_owner", bot.id, SPACE_ID)).rejects.toMatchObject({ code: "bot.invalid_transition" });
    expect(db.prepare("SELECT status FROM workspace_agent_bots WHERE id = ?").get(bot.id).status)
      .toBe(BOT_STATUS.DELETING);
    db.lock = originalLock;
  });

  it("audits owner-facing rejection paths without recording request payloads", async () => {
    const { service, db } = await fixture();
    await service.createBot("usr_owner", { spaceId: SPACE_ID, name: "Audit rejection" });
    await expect(service.createBot("usr_owner", { spaceId: SPACE_ID, name: "duplicate" })).rejects.toMatchObject({ code: "bot.already_exists" });
    await expect(service.issueToken("usr_owner", "missing-bot", { spaceId: SPACE_ID, scopes: ["messages:send", "secret-scope"] })).rejects.toMatchObject({ code: "permission.denied" });
    const rows = db.prepare("SELECT action, target_type AS targetType, target_id AS targetId, result, reason FROM audit_logs WHERE action LIKE 'bot.%' AND result = 'rejected' ORDER BY created_at").all();
    expect(rows.map((row) => [row.action, row.reason])).toEqual(expect.arrayContaining([
      ["bot.create", "bot.already_exists"],
      ["bot.token.issue", "permission.denied"]
    ]));
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("secret-scope");
    expect(serialized).not.toContain("duplicate");
  });

  it("keeps bot authentication separate from ordinary Workspace sessions and applies participation policy", () => {
    expect(canBotAuthenticate("human")).toBe(true);
    expect(canBotAuthenticate("bot")).toBe(false);
    expect(canBotAuthenticate("system")).toBe(false);
    const bot = {
      mode: "external_agent",
      status: "active",
      ownerUserId: "usr_owner",
      visibilityPolicy: "private",
      conversationPolicy: "direct-only"
    };
    expect(canBotParticipateInConversation(bot, { conversationType: "direct", actorUserId: "usr_owner", isExplicitTrigger: true })).toBe(true);
    expect(canBotParticipateInConversation(bot, { conversationType: "direct", actorUserId: "usr_other", isExplicitTrigger: true })).toBe(false);
    expect(canBotParticipateInConversation(bot, { conversationType: "direct", actorUserId: "usr_owner", isExplicitTrigger: false })).toBe(false);
    expect(canBotParticipateInConversation({ ...bot, visibilityPolicy: "space_members", conversationPolicy: "group-capable" }, { conversationType: "group", actorUserId: "usr_other", isMember: true, isExplicitTrigger: true })).toBe(true);
  });

  it("writes only metadata to audit rows", async () => {
    const { service, db } = await fixture();
    const bot = await service.createBot("usr_owner", { spaceId: SPACE_ID, name: "Audit-safe" });
    const token = await service.issueToken("usr_owner", bot.id, { spaceId: SPACE_ID });
    await service.revokeToken("usr_owner", bot.id, token.id, SPACE_ID);
    const rows = db.prepare("SELECT action, target_type AS targetType, target_id AS targetId, reason FROM audit_logs WHERE actor_user_id = ? AND action LIKE 'bot.%' ORDER BY created_at").all("usr_owner");
    expect(rows.map((row) => row.action)).toEqual(["bot.create", "bot.token.issue", "bot.token.revoke"]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token.token);
    expect(serialized).not.toContain("Audit-safe");
    expect(serialized).not.toContain("content");
  });

  async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "duallane-agent-bot-test-"));
    const db = openTestDatabase(directory);
    fixtures.push({ db, directory });
    return { db, service: createWorkspaceAgentBotService({ db }) };
  }
});
