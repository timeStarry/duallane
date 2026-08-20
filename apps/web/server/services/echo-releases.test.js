import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./test-database.mjs";
import { createEchoDeliveryService } from "./echo-delivery.mjs";
import {
  ECHO_RELEASE_CARD_DEFINITION,
  createEchoReleaseService,
  listEchoReleaseGuides,
  validateReleaseCardPayload
} from "./echo-releases.mjs";

const fixtures = [];
const timestamp = "2026-08-20T08:00:00.000Z";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-echo-releases-"));
  const db = openTestDatabase(directory);
  for (const [id, role, removedAt] of [
    ["usr_release_member", "member", null],
    ["usr_release_removed", "member", timestamp]
  ]) {
    db.prepare(`
      INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'human', ?, NULL)
    `).run(id, `${id}-github`, id, `${id}@example.com`, id, timestamp);
    db.prepare(`
      INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
      VALUES ('spc_default', ?, ?, ?, ?)
    `).run(id, role, timestamp, removedAt);
  }
  const releases = createEchoReleaseService({ db, now: () => new Date(timestamp) });
  fixtures.push({ db, directory });
  return { db, releases };
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    item.db.close();
    await rm(item.directory, { recursive: true, force: true });
  }
});

describe("Echo release publication", () => {
  it("snapshots a registered guide for every active human and replays without duplicate deliveries", async () => {
    const { db, releases } = await fixture();
    const first = await releases.publish({
      actorId: "usr_owner",
      version: "v0.15.1",
      request: { requestId: "req-release-first" }
    });
    const second = await releases.publish({
      actorId: "usr_owner",
      version: "0.15.1",
      request: { requestId: "req-release-second" }
    });

    expect(first).toMatchObject({ version: "0.15.1", recipientCount: 2, pendingCount: 2, replayed: false });
    expect(second).toMatchObject({ id: first.id, recipientCount: 2, replayed: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_release_publications").get().count).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_release_deliveries").get().count).toBe(2);
    const stored = db.prepare("SELECT guide_hash AS guideHash, guide_json AS guideJson FROM echo_release_publications").get();
    expect(stored.guideHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.guideJson).toContain("个人设置 -> 我的表情");
    const audits = db.prepare("SELECT result, reason FROM audit_logs WHERE action = 'echo.release.publish' ORDER BY created_at, id").all();
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ result: "success", reason: "published" }),
      expect.objectContaining({ result: "success", reason: "replayed" })
    ]));
    expect(JSON.stringify(audits)).not.toContain("个人设置");
  });

  it("rejects non-owners and versions without a detailed usage guide", async () => {
    const { db, releases } = await fixture();
    await expect(releases.publish({ actorId: "usr_release_member", version: "0.15.1" }))
      .rejects.toMatchObject({ code: "echo.release_permission_denied", statusCode: 403 });
    await expect(releases.publish({ actorId: "usr_owner", version: "9.9.9" }))
      .rejects.toMatchObject({ code: "echo.release_guide_not_found", statusCode: 404 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_release_publications").get().count).toBe(0);
    expect(db.prepare("SELECT reason FROM audit_logs WHERE action = 'echo.release.publish' ORDER BY created_at, id").all())
      .toEqual(expect.arrayContaining([
        { reason: "permission.denied" },
        { reason: "echo.release_guide_not_found" }
      ]));
  });

  it("projects only the immutable published snapshot to an intended recipient", async () => {
    const { releases } = await fixture();
    await releases.publish({ actorId: "usr_owner", version: "0.15.1" });
    const projection = await releases.projectCard({ actorId: "usr_release_member", version: "0.15.1" });
    expect(projection.block).toMatchObject({ cardType: "echo.release", schemaVersion: 1 });
    expect(projection.payload).toMatchObject({
      version: "0.15.1",
      publishedAt: timestamp,
      sections: expect.arrayContaining([
        expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({ location: expect.stringContaining("个人设置") })
          ])
        })
      ])
    });
    expect(ECHO_RELEASE_CARD_DEFINITION.validatePayload(projection.payload)).toEqual(projection.payload);
  });

  it("requires every detailed change to include a user-facing location", () => {
    for (const guide of listEchoReleaseGuides()) {
      for (const section of guide.sections) {
        expect(section.items.every((item) => item.title && item.description && item.location)).toBe(true);
      }
    }
    expect(() => validateReleaseCardPayload({
      version: "1.0.0",
      releasedAt: "2026-08-20",
      title: "版本",
      summary: "说明",
      publishedAt: timestamp,
      sections: [{ title: "功能", items: [{ title: "条目", description: "内容", location: "" }] }]
    })).toThrowError(expect.objectContaining({ code: "echo.release_guide_invalid" }));
  });

  it("delivers one idempotent release card into each member's private Echo conversation", async () => {
    const { db, releases } = await fixture();
    await releases.publish({ actorId: "usr_owner", version: "0.15.1" });
    const delivery = createEchoDeliveryService({
      db,
      releaseService: releases,
      now: () => new Date(timestamp),
      retryDelaysMs: [0]
    });

    const first = await delivery.syncRelease({ version: "0.15.1" });
    const second = await delivery.syncRelease({ version: "v0.15.1" });
    expect(first).toMatchObject({ type: "release", version: "0.15.1", sent: 2, failed: 0 });
    expect(second).toMatchObject({ sent: 2, failed: 0 });
    expect(second.results.every((item) => item.replayed)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE author_id = 'usr_system_echo'").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_cards WHERE card_type = 'echo.release'").get().count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM echo_release_deliveries WHERE status = 'sent'").get().count).toBe(2);
    const payload = db.prepare("SELECT payload_json AS payloadJson FROM workspace_cards WHERE card_type = 'echo.release' LIMIT 1").get().payloadJson;
    expect(payload).toContain("location");
    expect(payload).toContain("个人设置");
  });
});
