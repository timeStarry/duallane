import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_SPACE_ID } from "./db.mjs";
import { writeAudit } from "./audit.mjs";

export const ECHO_RELEASE_CARD_TYPE = "echo.release";
export const ECHO_RELEASE_CARD_SCHEMA_VERSION = 1;

const VERSION_PATTERN = /^(?:v)?(\d+\.\d+\.\d+)$/i;
const RELEASE_GUIDES = loadReleaseGuides();

export class EchoReleaseError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "EchoReleaseError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const ECHO_RELEASE_CARD_DEFINITION = Object.freeze({
  cardType: ECHO_RELEASE_CARD_TYPE,
  schemaVersion: ECHO_RELEASE_CARD_SCHEMA_VERSION,
  validatePayload: validateReleaseCardPayload,
  actions: Object.freeze({})
});

export function listEchoReleaseGuides() {
  return RELEASE_GUIDES.map(cloneGuide);
}

export function createEchoReleaseService({
  db,
  spaceId = DEFAULT_SPACE_ID,
  now = () => new Date(),
  guides = RELEASE_GUIDES,
  idFactory = randomUUID
}) {
  if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") {
    throw new TypeError("Echo releases require a database adapter");
  }
  const guideMap = new Map(guides.map((guide) => {
    const normalized = normalizeGuide(guide);
    return [normalized.version, normalized];
  }));

  return Object.freeze({
    publish: async (input = {}) => {
      const version = normalizeVersion(input.version);
      const actor = await requireActiveHuman(db, spaceId, input.actorId);
      if (actor.role !== "owner") {
        await audit(db, input.request, actor, spaceId, version, "rejected", "permission.denied");
        throw new EchoReleaseError("echo.release_permission_denied", "只有空间主人可以发布版本更新", 403);
      }
      const guide = guideMap.get(version);
      if (!guide) {
        await audit(db, input.request, actor, spaceId, version, "rejected", "echo.release_guide_not_found");
        throw new EchoReleaseError("echo.release_guide_not_found", "该版本没有可发布的使用指南", 404);
      }

      return db.transaction(async () => {
        await db.lock?.(`duallane:echo-release:${spaceId}:${version}`);
        const existing = await readPublication(db, spaceId, version);
        if (existing) {
          const summary = await publicationSummary(db, existing, true);
          await audit(db, input.request, actor, spaceId, version, "success", "replayed");
          return summary;
        }

        const publicationId = `echo_release_${idFactory()}`;
        const timestamp = toIso(now());
        const guideJson = JSON.stringify(guide);
        const guideHash = createHash("sha256").update(guideJson).digest("hex");
        await db.prepare(`
          INSERT INTO echo_release_publications (
            id, space_id, version, title, guide_hash, guide_json,
            published_by_user_id, published_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(publicationId, spaceId, version, guide.title, guideHash, guideJson, actor.id, timestamp);

        const recipients = await db.prepare(`
          SELECT sm.user_id AS userId
          FROM space_members sm
          INNER JOIN users u ON u.id = sm.user_id
          WHERE sm.space_id = ? AND sm.removed_at IS NULL AND u.kind = 'human'
          ORDER BY sm.user_id ASC
        `).all(spaceId);
        for (const recipient of recipients) {
          await db.prepare(`
            INSERT INTO echo_release_deliveries (
              id, space_id, publication_id, recipient_user_id, status,
              attempt_count, last_error_code, delivered_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
            ON CONFLICT (publication_id, recipient_user_id) DO NOTHING
          `).run(`echo_release_delivery_${idFactory()}`, spaceId, publicationId, recipient.userId, timestamp, timestamp);
        }
        await audit(db, input.request, actor, spaceId, version, "success", "published");
        return publicationSummary(db, {
          id: publicationId,
          version,
          title: guide.title,
          publishedAt: timestamp
        }, false);
      });
    },

    projectCard: async (input = {}) => {
      const version = normalizeVersion(input.version);
      const actor = await requireActiveHuman(db, spaceId, input.actorId);
      const publication = await db.prepare(`
        SELECT p.id, p.version, p.title, p.guide_json AS guideJson,
          p.published_at AS publishedAt
        FROM echo_release_publications p
        INNER JOIN echo_release_deliveries d ON d.publication_id = p.id
          AND d.recipient_user_id = ? AND d.space_id = p.space_id
        WHERE p.space_id = ? AND p.version = ?
      `).get(actor.id, spaceId, version);
      if (!publication) {
        throw new EchoReleaseError("echo.release_not_found", "版本更新不存在或不可访问", 404);
      }
      const guide = normalizeGuide(parseJson(publication.guideJson));
      return {
        block: {
          type: "card",
          cardId: `echo_release_${version.replaceAll(".", "_")}`,
          cardType: ECHO_RELEASE_CARD_TYPE,
          schemaVersion: ECHO_RELEASE_CARD_SCHEMA_VERSION,
          fallbackText: `DualLane v${version} 更新：${guide.title}`
        },
        payload: validateReleaseCardPayload({
          version: guide.version,
          releasedAt: guide.releasedAt,
          title: guide.title,
          summary: guide.summary,
          sections: guide.sections,
          publishedAt: publication.publishedAt
        })
      };
    },

    getPublication: async (version) => {
      const row = await readPublication(db, spaceId, normalizeVersion(version));
      return row ? publicationSummary(db, row, false) : null;
    }
  });
}

export function validateReleaseCardPayload(payload) {
  const guide = normalizeGuide(payload);
  const publishedAt = normalizeTimestamp(payload.publishedAt, "publishedAt");
  return { ...guide, publishedAt };
}

function loadReleaseGuides() {
  const value = JSON.parse(readFileSync(new URL("../../shared/echo-release-guides.json", import.meta.url), "utf8"));
  if (!Array.isArray(value) || value.length === 0) throw new Error("Echo release guide catalog is empty");
  const guides = value.map(normalizeGuide);
  if (new Set(guides.map((guide) => guide.version)).size !== guides.length) {
    throw new Error("Echo release guide versions must be unique");
  }
  return Object.freeze(guides.map((guide) => Object.freeze(guide)));
}

function normalizeGuide(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EchoReleaseError("echo.release_guide_invalid", "版本使用指南无效", 422);
  }
  const version = normalizeVersion(value.version);
  const releasedAt = normalizeDate(value.releasedAt);
  const title = normalizeText(value.title, "title", 120);
  const summary = normalizeText(value.summary, "summary", 500);
  if (!Array.isArray(value.sections) || value.sections.length < 1 || value.sections.length > 8) {
    throw new EchoReleaseError("echo.release_guide_invalid", "版本使用指南分组无效", 422);
  }
  const sections = value.sections.map((section) => {
    const sectionTitle = normalizeText(section?.title, "section.title", 80);
    if (!Array.isArray(section?.items) || section.items.length < 1 || section.items.length > 12) {
      throw new EchoReleaseError("echo.release_guide_invalid", "版本使用指南条目无效", 422);
    }
    return {
      title: sectionTitle,
      items: section.items.map((item) => ({
        title: normalizeText(item?.title, "item.title", 120),
        description: normalizeText(item?.description, "item.description", 800),
        location: normalizeText(item?.location, "item.location", 500)
      }))
    };
  });
  return { version, releasedAt, title, summary, sections };
}

async function requireActiveHuman(db, spaceId, actorId) {
  if (typeof actorId !== "string" || !actorId.trim()) {
    throw new EchoReleaseError("echo.release_permission_denied", "无权访问版本更新", 403);
  }
  const actor = await db.prepare(`
    SELECT u.id, u.github_login AS githubLogin, sm.role
    FROM users u
    INNER JOIN space_members sm ON sm.user_id = u.id
    WHERE u.id = ? AND u.kind = 'human' AND sm.space_id = ? AND sm.removed_at IS NULL
  `).get(actorId.trim(), spaceId);
  if (!actor) throw new EchoReleaseError("echo.release_permission_denied", "无权访问版本更新", 403);
  return actor;
}

async function readPublication(db, spaceId, version) {
  return db.prepare(`
    SELECT id, version, title, published_at AS publishedAt
    FROM echo_release_publications
    WHERE space_id = ? AND version = ?
  `).get(spaceId, version);
}

async function publicationSummary(db, publication, replayed) {
  const counts = await db.prepare(`
    SELECT COUNT(*) AS recipientCount,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skippedCount
    FROM echo_release_deliveries
    WHERE publication_id = ?
  `).get(publication.id);
  return {
    id: publication.id,
    version: publication.version,
    title: publication.title,
    publishedAt: publication.publishedAt,
    recipientCount: Number(counts?.recipientCount) || 0,
    pendingCount: Number(counts?.pendingCount) || 0,
    sentCount: Number(counts?.sentCount) || 0,
    failedCount: Number(counts?.failedCount) || 0,
    skippedCount: Number(counts?.skippedCount) || 0,
    replayed: Boolean(replayed)
  };
}

async function audit(db, request, actor, spaceId, version, result, reason) {
  await writeAudit(db, {
    id: request?.auditId,
    spaceId,
    actorUserId: actor?.id ?? null,
    actorGithubLogin: actor?.githubLogin ?? null,
    action: "echo.release.publish",
    targetType: "echo.release",
    targetId: version,
    result,
    reason,
    ipAddress: request?.ipAddress,
    userAgent: request?.userAgent,
    requestId: request?.requestId
  });
}

function normalizeVersion(value) {
  const match = typeof value === "string" ? value.trim().match(VERSION_PATTERN) : null;
  if (!match) throw new EchoReleaseError("echo.release_version_invalid", "需要有效的版本号，例如 0.15.1", 422);
  return match[1];
}

function normalizeDate(value) {
  const text = normalizeText(value, "releasedAt", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00.000Z`))) {
    throw new EchoReleaseError("echo.release_guide_invalid", "版本发布日期无效", 422);
  }
  return text;
}

function normalizeTimestamp(value, field) {
  const text = normalizeText(value, field, 40);
  if (Number.isNaN(Date.parse(text))) throw new EchoReleaseError("echo.release_guide_invalid", "版本发布时间无效", 422);
  return new Date(text).toISOString();
}

function normalizeText(value, field, maxCodePoints) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || Array.from(text).length > maxCodePoints || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(text)) {
    throw new EchoReleaseError("echo.release_guide_invalid", `版本使用指南字段 ${field} 无效`, 422);
  }
  return text;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new EchoReleaseError("echo.release_guide_invalid", "版本使用指南快照损坏", 500);
  }
}

function cloneGuide(guide) {
  return JSON.parse(JSON.stringify(guide));
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new EchoReleaseError("echo.release_time_invalid", "版本发布时间无效", 500);
  return date.toISOString();
}
