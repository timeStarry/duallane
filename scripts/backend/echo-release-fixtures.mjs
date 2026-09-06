import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { createEchoReleaseService, listEchoReleaseGuides } from "../../apps/web/server/services/echo-releases.mjs";

const FIXTURE_SPACE = "spc_fixture";
const PUBLISHED_AT = "2026-09-06T12:34:56.789Z";
const CHECK_MODE = process.argv.slice(2).includes("--check");

class FixtureDatabase {
  constructor() {
    this.publications = new Map();
    this.deliveries = [];
    this.audits = [];
    this.locks = [];
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return {
      get: async (...args) => this.get(normalized, args),
      all: async (...args) => this.all(normalized, args),
      run: async (...args) => this.run(normalized, args)
    };
  }

  async transaction(callback) {
    return callback();
  }

  async lock(key) {
    this.locks.push(key);
  }

  get(sql, args) {
    if (sql.includes("SELECT u.id, u.github_login AS githubLogin, sm.role")) {
      const [actorId] = args;
      if (actorId === "usr_fixture_owner") {
        return { id: actorId, githubLogin: "fixture-owner", role: "owner" };
      }
      if (actorId === "usr_fixture_member") {
        return { id: actorId, githubLogin: "fixture-member", role: "member" };
      }
      return undefined;
    }
    if (sql.includes("SELECT id, version, title, published_at AS publishedAt")) {
      const [, version] = args;
      const publication = this.publications.get(version);
      return publication && {
        id: publication.id,
        version: publication.version,
        title: publication.title,
        publishedAt: publication.publishedAt
      };
    }
    if (sql.includes("SELECT COUNT(*) AS recipientCount")) {
      const [publicationId] = args;
      const deliveries = this.deliveries.filter((item) => item.publicationId === publicationId);
      return {
        recipientCount: deliveries.length,
        pendingCount: deliveries.filter((item) => item.status === "pending").length,
        sentCount: deliveries.filter((item) => item.status === "sent").length,
        failedCount: deliveries.filter((item) => item.status === "failed").length,
        skippedCount: deliveries.filter((item) => item.status === "skipped").length
      };
    }
    throw new Error(`unhandled fixture get query: ${sql}`);
  }

  all(sql, args) {
    if (sql.includes("SELECT sm.user_id AS userId")) {
      return ["usr_fixture_member", "usr_fixture_owner"].map((userId) => ({ userId }));
    }
    throw new Error(`unhandled fixture all query: ${sql}`);
  }

  run(sql, args) {
    if (sql.includes("INSERT INTO echo_release_publications")) {
      const [id, spaceId, version, title, guideHash, guideJson, publishedByUserId, publishedAt] = args;
      const publication = { id, spaceId, version, title, guideHash, guideJson, publishedByUserId, publishedAt };
      this.publications.set(version, publication);
      return { changes: 1 };
    }
    if (sql.includes("INSERT INTO echo_release_deliveries")) {
      const [id, spaceId, publicationId, recipientUserId, createdAt, updatedAt] = args;
      this.deliveries.push({ id, spaceId, publicationId, recipientUserId, status: "pending", createdAt, updatedAt });
      return { changes: 1 };
    }
    if (sql.includes("INSERT INTO audit_logs")) {
      const [id, spaceId, actorUserId, actorGithubLogin, action, targetType, targetId, result, reason, ipAddress, userAgent, requestId, createdAt] = args;
      this.audits.push({ id, spaceId, actorUserId, actorGithubLogin, action, targetType, targetId, result, reason, ipAddress, userAgent, requestId, createdAt });
      return { changes: 1 };
    }
    throw new Error(`unhandled fixture run query: ${sql}`);
  }
}

function deterministicIdFactory(prefix) {
  let sequence = 0;
  return () => `${prefix}-${String(++sequence).padStart(3, "0")}`;
}

async function publishCatalog() {
  const db = new FixtureDatabase();
  const service = createEchoReleaseService({
    db,
    spaceId: FIXTURE_SPACE,
    now: () => new Date(PUBLISHED_AT),
    idFactory: deterministicIdFactory("node-catalog")
  });
  const guides = listEchoReleaseGuides();
  const publications = [];
  for (const guide of guides) {
    const summary = await service.publish({
      actorId: "usr_fixture_owner",
      version: `V${guide.version}`,
      request: { auditId: `audit-${guide.version}`, requestId: `request-${guide.version}` }
    });
    const stored = db.publications.get(guide.version);
    publications.push({
      version: guide.version,
      guide,
      guideJSON: stored.guideJson,
      guideHash: stored.guideHash,
      publicationID: stored.id,
      deliveryIDs: db.deliveries.filter((item) => item.publicationId === stored.id).map((item) => item.id),
      lockKey: db.locks.at(-1),
      summary,
      getPublication: await service.getPublication(guide.version)
    });
  }
  return publications;
}

async function probeSyntheticGuide() {
  const db = new FixtureDatabase();
  const guide = {
    version: "V1.2.3",
    releasedAt: "\uFEFF2026-09-06\uFEFF",
    title: "\uFEFFHTML <>& \u2028\u2029 \\ literal \uFEFF",
    summary: "Emoji 😀, tab\tline\ncarriage\r, and \\backslash",
    sections: [{
      title: "section \u2028",
      items: [{
        title: "item \u2029",
        description: "description <tag> & \u2028\u2029",
        location: "path\\with\\literal\\backslash"
      }]
    }]
  };
  const service = createEchoReleaseService({
    db,
    spaceId: FIXTURE_SPACE,
    guides: [guide],
    now: () => new Date(PUBLISHED_AT),
    idFactory: deterministicIdFactory("node-edge")
  });
  const summary = await service.publish({
    actorId: "usr_fixture_owner",
    version: "V1.2.3",
    request: { auditId: "audit-edge", requestId: "request-edge" }
  });
  const stored = db.publications.get("1.2.3");
  const errors = {};
  for (const [name, actorId] of [["missingActor", "usr_fixture_missing"], ["nonOwner", "usr_fixture_member"]]) {
    try {
      await service.publish({ actorId, version: "1.2.3", request: { auditId: `audit-${name}` } });
    } catch (error) {
      errors[name] = { code: error.code, message: error.message, statusCode: error.statusCode };
    }
  }
  return {
    version: "1.2.3",
    guide: JSON.parse(stored.guideJson),
    guideJSON: stored.guideJson,
    guideHash: stored.guideHash,
    publicationID: stored.id,
    deliveryIDs: db.deliveries.map((item) => item.id),
    lockKey: db.locks[0],
    summary,
    errors,
    utf16AndCodePointProbe: {
      emojiCodePoints: Array.from("😀").length,
      emojiUTF16Length: "😀".length,
      bomTrimmed: "\uFEFFvalue\uFEFF".trim() === "value"
    }
  };
}

const fixture = {
  generatedBy: "apps/web/server/services/echo-releases.mjs",
  spaceID: FIXTURE_SPACE,
  publishedAt: PUBLISHED_AT,
  catalog: await publishCatalog(),
  synthetic: await probeSyntheticGuide()
};

if (!CHECK_MODE) {
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
} else {
  const checkedInPath = fileURLToPath(new URL("../../apps/backend/internal/workspace/echo/releases/testdata/node-release-fixtures.json", import.meta.url));
  let checkedIn;
  let checkedInCatalogCount = 0;
  let matches = false;
  try {
    checkedIn = JSON.parse(await readFile(checkedInPath, "utf8"));
    checkedInCatalogCount = Array.isArray(checkedIn.catalog) ? checkedIn.catalog.length : 0;
    matches = isDeepStrictEqual(checkedIn, fixture);
  } catch {
    matches = false;
  }
  process.stdout.write(`echo-release-fixtures --check: ${matches ? "PASS" : "FAIL"} catalog=${fixture.catalog.length} checkedInCatalog=${checkedInCatalogCount} synthetic=${fixture.synthetic ? 1 : 0}\n`);
  if (!matches) {
    process.exitCode = 1;
  }
}
