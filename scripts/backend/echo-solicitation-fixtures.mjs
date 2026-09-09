// Exercise the active Node solicitation service against a synthetic SQLite
// database. The assertions intentionally read the hashes written by the
// service; hand-built JSON.stringify values alone are not sufficient evidence
// that normalization and persistence agree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openTestDatabase } from "../../apps/web/server/services/test-database.mjs";
import { createEchoSolicitationService } from "../../apps/web/server/services/echo-solicitations.mjs";

const SPACE_ID = "spc_default";
const OWNER_ID = "usr_owner";
const MEMBER_ID = "usr_solicitation_member";
const AUDITOR_ID = "usr_solicitation_auditor";
const NOW = new Date("2026-09-06T12:00:00.000Z");

// These values are generated with Node's JSON.stringify and kept as contract
// goldens. They cover literal <, >, &, U+2028, U+2029 and null deadline data.
const EXPECTED_HASHES = Object.freeze({
  create: "b8f137559c3fc75af5bb9b8c37f1d7504ef9f6ec624472643f6072e9c9b26c0c",
  publish: "d4163fb1539d0459eb8e75ac4e3ee1ec2e006b87672fe9a7860947351de42470",
  vote: "8d5df2170e7f3ea7549a215609fa9bf93f3b15c858abadc895d29356ab66afdf",
  close: "8b2095d38020383342f4134438a96e57e8c5a26c93f88c3a12dcfc55c5cd50a6",
  createWithdrawn: "eeae0a7665d9ff9791dd842a1892917b58c0bdc99f88d4c052a85b20820b13e4",
  withdraw: "11ddb2ef0484812b0771a49d7664227070e152efcc9e2bfeb65d39874ae0208a"
});

const EXPECTED_OBSERVATIONS = Object.freeze([
  { name: "permission-create", code: "echo.solicitation_not_found" },
  { name: "nullable-draft", deadline: null, publishedAt: null, closedAt: null, withdrawnAt: null, resultVisibility: "aggregate", deliveryPolicy: "all_active_members" },
  { name: "create-hash", matches: true },
  { name: "permission-publish", code: "echo.solicitation_not_found" },
  { name: "publish-hash", matches: true },
  { name: "permission-auditor-vote", code: "echo.solicitation_not_found" },
  { name: "validation-vote-selection", code: "echo.selection_invalid" },
  { name: "validation-vote-revision", code: "echo.expected_revision_invalid" },
  { name: "vote-hash", matches: true },
  { name: "vote-replay", sameResult: true },
  { name: "close-hash", matches: true },
  { name: "nullable-closed", deadline: null, publishedAt: true, closedAt: true, withdrawnAt: null },
  { name: "validation-create-zero", code: "echo.selection_invalid" },
  { name: "create-withdrawn-hash", matches: true },
  { name: "withdraw-hash", matches: true },
  { name: "nullable-withdrawn", publishedAt: null, closedAt: null, withdrawnAt: true },
  { name: "vote-row-count", count: 1 },
  { name: "vote-idempotency-count", count: 1 },
  { name: "audit-counts", counts: {
    createSuccess: 2,
    createRejected: 2,
    publishSuccess: 1,
    publishRejected: 1,
    voteSuccess: 1,
    voteRejected: 3,
    closeSuccess: 1,
    withdrawSuccess: 1
  }},
  { name: "workspace-event-delta", count: 0 }
]);

function nodeHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function addHuman(db, id, githubLogin, role) {
  const timestamp = NOW.toISOString();
  db.prepare(`
    INSERT INTO users (id, github_id, github_login, email, display_name, avatar_url, kind, created_at, last_login_at)
    VALUES (?, NULL, ?, NULL, ?, NULL, 'human', ?, NULL)
  `).run(id, githubLogin, githubLogin, timestamp);
  db.prepare(`
    INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
    VALUES (?, ?, ?, ?, NULL)
  `).run(SPACE_ID, id, role, timestamp);
}

function idempotencyHash(db, actorId, operation, key) {
  const row = db.prepare(`
    SELECT request_hash AS hash
    FROM echo_solicitation_idempotency
    WHERE space_id = ? AND actor_user_id = ? AND operation = ? AND idempotency_key = ?
  `).get(SPACE_ID, actorId, operation, key);
  assert.ok(row, `missing persisted ${operation} hash for ${key}`);
  return row.hash;
}

function expectCode(action, expectedCode) {
  return action().then(
    () => { throw new Error(`expected ${expectedCode}, operation succeeded`); },
    (error) => {
      assert.equal(error?.code, expectedCode, `expected ${expectedCode}, got ${error?.code}`);
      return error.code;
    }
  );
}

function selectedCreatePayload({ actorId, title, description, question, options, choiceMode = "single", minSelections = 1, maxSelections = 1 }) {
  return {
    spaceId: SPACE_ID,
    actorId,
    title,
    description,
    question,
    options,
    choiceMode,
    minSelections,
    maxSelections,
    allowVoteChange: true,
    resultVisibility: "aggregate",
    deliveryPolicy: "all_active_members",
    deadline: null
  };
}

export async function characterizeSolicitations() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "duallane-echo-solicitation-contract-"));
  let db;
  try {
    db = openTestDatabase(directory);
    addHuman(db, MEMBER_ID, "solicitation-member", "member");
    addHuman(db, AUDITOR_ID, "solicitation-auditor", "auditor");

    let id = 0;
    const service = createEchoSolicitationService({
      db,
      spaceId: SPACE_ID,
      now: () => NOW,
      idFactory: () => `fixture-${++id}`
    });
    const observations = [];
    const beforeEvents = db.prepare("SELECT COUNT(*) AS count FROM workspace_events WHERE space_id = ?").get(SPACE_ID).count;

    observations.push({
      name: "permission-create",
      code: await expectCode(
        () => service.create({
          actorId: AUDITOR_ID,
          title: "Auditor cannot create",
          description: "Synthetic description",
          question: "Q",
          options: ["A", "B"],
          idempotencyKey: "permission-create"
        }),
        "echo.solicitation_not_found"
      )
    });

    const firstInput = {
      actorId: OWNER_ID,
      // Nullish description/detail and policy values exercise the active
      // Node normalization path instead of only testing a hand-made payload.
      title: "  Node <&\u2028X  ",
      description: null,
      detail: "  Desc>&\u2029Z  ",
      question: "  Q  ",
      options: [" A<& ", "B"],
      choiceMode: null,
      minSelections: undefined,
      maxSelections: undefined,
      allowVoteChange: undefined,
      resultVisibility: null,
      deliveryPolicy: null,
      deadline: null,
      idempotencyKey: "node-create-1"
    };
    const first = await service.create(firstInput);
    assert.equal(first.publicId, "SOL-2026-0001");
    assert.equal(first.deadline, null);
    assert.equal(first.resultVisibility, "aggregate");
    assert.equal(first.deliveryPolicy, "all_active_members");
    const firstRow = db.prepare(`
      SELECT deadline, published_at AS publishedAt, closed_at AS closedAt,
        withdrawn_at AS withdrawnAt, result_visibility AS resultVisibility,
        delivery_policy AS deliveryPolicy
      FROM echo_solicitations WHERE space_id = ? AND public_id = ?
    `).get(SPACE_ID, first.publicId);
    observations.push({ name: "nullable-draft", deadline: firstRow.deadline, publishedAt: firstRow.publishedAt, closedAt: firstRow.closedAt, withdrawnAt: firstRow.withdrawnAt, resultVisibility: firstRow.resultVisibility, deliveryPolicy: firstRow.deliveryPolicy });

    const firstCreatePayload = selectedCreatePayload({
      actorId: OWNER_ID,
      title: "Node <&\u2028X",
      description: "Desc>&\u2029Z",
      question: "Q",
      options: ["A<&", "B"]
    });
    const firstCreateHash = idempotencyHash(db, OWNER_ID, "create", "node-create-1");
    const firstExpectedHash = nodeHash(firstCreatePayload);
    assert.equal(firstExpectedHash, EXPECTED_HASHES.create);
    assert.equal(firstCreateHash, firstExpectedHash);
    observations.push({ name: "create-hash", matches: firstCreateHash === firstExpectedHash });

    observations.push({
      name: "permission-publish",
      code: await expectCode(
        () => service.publish({ actorId: MEMBER_ID, publicId: first.publicId, expectedRevision: 1, idempotencyKey: "permission-publish" }),
        "echo.solicitation_not_found"
      )
    });

    const open = await service.publish({ actorId: OWNER_ID, publicId: first.publicId, expectedRevision: 1, idempotencyKey: "node-publish-1" });
    assert.equal(open.status, "open");
    assert.equal(open.revision, 2);
    const publishHash = idempotencyHash(db, OWNER_ID, "publish", "node-publish-1");
    const publishExpectedHash = nodeHash({ spaceId: SPACE_ID, publicId: first.publicId, operation: "publish", targetStatus: "open" });
    assert.equal(publishExpectedHash, EXPECTED_HASHES.publish);
    assert.equal(publishHash, publishExpectedHash);
    observations.push({ name: "publish-hash", matches: publishHash === publishExpectedHash });

    observations.push({
      name: "permission-auditor-vote",
      code: await expectCode(
        () => service.vote({ actorId: AUDITOR_ID, publicId: first.publicId, optionIds: [first.options[0].id], expectedRevision: 2, idempotencyKey: "permission-auditor-vote" }),
        "echo.solicitation_not_found"
      )
    });

    observations.push({
      name: "validation-vote-selection",
      code: await expectCode(
        () => service.vote({ actorId: MEMBER_ID, publicId: first.publicId, optionIds: first.options.map((option) => option.id), expectedRevision: 2, idempotencyKey: "invalid-selection" }),
        "echo.selection_invalid"
      )
    });
    observations.push({
      name: "validation-vote-revision",
      code: await expectCode(
        () => service.vote({ actorId: MEMBER_ID, publicId: first.publicId, optionIds: [first.options[0].id], expectedRevision: 0, idempotencyKey: "invalid-revision" }),
        "echo.expected_revision_invalid"
      )
    });

    const voteInput = { actorId: MEMBER_ID, publicId: first.publicId, optionIds: [first.options[0].id], expectedRevision: 2, idempotencyKey: "node-vote-1" };
    const voted = await service.vote(voteInput);
    const voteReplay = await service.vote(voteInput);
    assert.deepEqual(voteReplay, voted);
    const voteHash = idempotencyHash(db, MEMBER_ID, "vote", "node-vote-1");
    const voteExpectedHash = nodeHash({ spaceId: SPACE_ID, publicId: first.publicId, optionIds: [first.options[0].id], expectedRevision: 2 });
    assert.equal(voteExpectedHash, EXPECTED_HASHES.vote);
    assert.equal(voteHash, voteExpectedHash);
    observations.push({ name: "vote-hash", matches: voteHash === voteExpectedHash });
    observations.push({ name: "vote-replay", sameResult: true });

    const close = await service.close({ actorId: OWNER_ID, publicId: first.publicId, expectedRevision: 3, idempotencyKey: "node-close-1" });
    assert.equal(close.status, "closed");
    assert.equal(close.revision, 4);
    const closeHash = idempotencyHash(db, OWNER_ID, "close", "node-close-1");
    const closeExpectedHash = nodeHash({ spaceId: SPACE_ID, publicId: first.publicId, operation: "close", targetStatus: "closed" });
    assert.equal(closeExpectedHash, EXPECTED_HASHES.close);
    assert.equal(closeHash, closeExpectedHash);
    observations.push({ name: "close-hash", matches: closeHash === closeExpectedHash });
    const closedRow = db.prepare(`
      SELECT deadline, published_at AS publishedAt, closed_at AS closedAt, withdrawn_at AS withdrawnAt
      FROM echo_solicitations WHERE space_id = ? AND public_id = ?
    `).get(SPACE_ID, first.publicId);
    observations.push({ name: "nullable-closed", deadline: closedRow.deadline, publishedAt: Boolean(closedRow.publishedAt), closedAt: Boolean(closedRow.closedAt), withdrawnAt: closedRow.withdrawnAt });

    const invalidCreate = {
      actorId: OWNER_ID,
      title: "Invalid zero",
      description: "Synthetic description",
      question: "Q",
      options: ["A", "B"],
      minSelections: 0,
      idempotencyKey: "invalid-create-zero"
    };
    observations.push({
      name: "validation-create-zero",
      code: await expectCode(() => service.create(invalidCreate), "echo.selection_invalid")
    });

    const second = await service.create({
      actorId: OWNER_ID,
      title: "Withdraw me",
      description: "Synthetic description",
      question: "Q",
      options: ["A", "B"],
      deadline: null,
      idempotencyKey: "node-create-2"
    });
    const secondCreateHash = idempotencyHash(db, OWNER_ID, "create", "node-create-2");
    const secondCreatePayload = selectedCreatePayload({
      actorId: OWNER_ID,
      title: "Withdraw me",
      description: "Synthetic description",
      question: "Q",
      options: ["A", "B"]
    });
    const secondExpectedHash = nodeHash(secondCreatePayload);
    assert.equal(secondExpectedHash, EXPECTED_HASHES.createWithdrawn);
    assert.equal(secondCreateHash, secondExpectedHash);
    observations.push({ name: "create-withdrawn-hash", matches: secondCreateHash === secondExpectedHash });

    const withdrawn = await service.withdraw({ actorId: OWNER_ID, publicId: second.publicId, expectedRevision: 1, idempotencyKey: "node-withdraw-1" });
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(withdrawn.revision, 2);
    const withdrawHash = idempotencyHash(db, OWNER_ID, "withdraw", "node-withdraw-1");
    const withdrawExpectedHash = nodeHash({ spaceId: SPACE_ID, publicId: second.publicId, operation: "withdraw", targetStatus: "withdrawn" });
    assert.equal(withdrawExpectedHash, EXPECTED_HASHES.withdraw);
    assert.equal(withdrawHash, withdrawExpectedHash);
    observations.push({ name: "withdraw-hash", matches: withdrawHash === withdrawExpectedHash });
    const withdrawnRow = db.prepare(`
      SELECT published_at AS publishedAt, closed_at AS closedAt, withdrawn_at AS withdrawnAt
      FROM echo_solicitations WHERE space_id = ? AND public_id = ?
    `).get(SPACE_ID, second.publicId);
    observations.push({ name: "nullable-withdrawn", publishedAt: withdrawnRow.publishedAt, closedAt: withdrawnRow.closedAt, withdrawnAt: Boolean(withdrawnRow.withdrawnAt) });

    const voteCount = db.prepare(`SELECT COUNT(*) AS count FROM echo_solicitation_votes WHERE solicitation_id = ?`).get(first.id).count;
    const voteIdempotencyCount = db.prepare(`
      SELECT COUNT(*) AS count FROM echo_solicitation_idempotency
      WHERE space_id = ? AND actor_user_id = ? AND operation = 'vote' AND idempotency_key = 'node-vote-1'
    `).get(SPACE_ID, MEMBER_ID).count;
    observations.push({ name: "vote-row-count", count: voteCount });
    observations.push({ name: "vote-idempotency-count", count: voteIdempotencyCount });

    const auditRows = db.prepare(`
      SELECT action, result, COUNT(*) AS count
      FROM audit_logs
      WHERE space_id = ? AND action LIKE 'echo.solicitation.%'
      GROUP BY action, result
    `).all(SPACE_ID);
    const auditCounts = Object.fromEntries(auditRows.map((row) => [`${row.action}:${row.result}`, Number(row.count)]));
    observations.push({
      name: "audit-counts",
      counts: {
        createSuccess: auditCounts["echo.solicitation.create:success"] ?? 0,
        createRejected: auditCounts["echo.solicitation.create:rejected"] ?? 0,
        publishSuccess: auditCounts["echo.solicitation.publish:success"] ?? 0,
        publishRejected: auditCounts["echo.solicitation.publish:rejected"] ?? 0,
        voteSuccess: auditCounts["echo.solicitation.vote:success"] ?? 0,
        voteRejected: auditCounts["echo.solicitation.vote:rejected"] ?? 0,
        closeSuccess: auditCounts["echo.solicitation.close:success"] ?? 0,
        withdrawSuccess: auditCounts["echo.solicitation.withdraw:success"] ?? 0
      }
    });

    const afterEvents = db.prepare("SELECT COUNT(*) AS count FROM workspace_events WHERE space_id = ?").get(SPACE_ID).count;
    observations.push({ name: "workspace-event-delta", count: Number(afterEvents) - Number(beforeEvents) });
    return observations;
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const result = await characterizeSolicitations();
if (process.argv.includes("--check")) {
  assert.deepEqual(result, EXPECTED_OBSERVATIONS);
  process.stdout.write(`Echo Node solicitation persisted-contract fixtures passed: ${result.length}\n`);
} else {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
