import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(repoRoot, ".github/tests/frozen-node-artifacts.json");
const expectedArtifactPaths = Object.freeze([
  "apps/backend/api/node-routes.json",
  "apps/backend/internal/workspace/avatars/testdata/node-legacy-avatar-keys.json",
  "apps/backend/internal/workspace/botgateway/testdata/node-feishu-fallback.json",
  "apps/backend/internal/workspace/botgateway/testdata/node-idempotency.json",
  "apps/backend/internal/workspace/botgateway/testdata/node-message-dto.json",
  "apps/backend/internal/workspace/echo/automation/testdata/node-parser-boundaries.json",
  "apps/backend/internal/workspace/echo/automation/testdata/node-runtime.json",
  "apps/backend/internal/workspace/echo/carddefinitions/testdata/node-definitions.json",
  "apps/backend/internal/workspace/echo/releases/testdata/node-release-fixtures.json",
  "apps/backend/internal/workspace/echo/requirements/testdata/node-idempotency.json",
  "apps/backend/internal/workspace/echo/solicitations/testdata/node-idempotency.json",
  "apps/backend/internal/workspace/messages/testdata/markdown-summary.json",
  "apps/backend/internal/workspace/topics/testdata/cards-node.json",
  "apps/backend/internal/workspace/topics/testdata/parser-node.json",
  "apps/backend/internal/workspacecontract/testdata/node-bot-contract.json",
  "apps/backend/internal/workspacecontract/testdata/node-core.json",
  "apps/backend/internal/workspacecontract/testdata/node-emotes.json",
  "apps/backend/internal/workspacecontract/testdata/node-files.json",
  "apps/backend/internal/workspacecontract/testdata/node-invites.json",
  "apps/backend/internal/workspacecontract/testdata/node-notifications-null-schema.json",
  "apps/backend/internal/workspacecontract/testdata/node-notifications.json",
  "apps/backend/internal/workspace/feishucards/testdata/feishu-card-action-golden.json",
  "apps/backend/internal/workspace/feishucards/testdata/feishu-card-golden.json",
  "scripts/backend/bot-feishu-contract-golden.json",
  "scripts/backend/testdata/bot-websocket-goldens.json",
  "scripts/backend/testdata/p2p/http.json",
  "scripts/backend/testdata/p2p/websocket.json",
  "scripts/backend/testdata/workspace-notifications-null.json"
]);

async function readManifest() {
  const text = await readFile(manifestPath, "utf8");
  return JSON.parse(text);
}

test("frozen Node artifacts retain immutable provenance and current file hashes", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.artifactKind, "frozen-node-provenance");
  assert.equal(manifest.lastRegenerableSourceCommit, "8d346a04317d0d3396293caca14ca1c65c7b5163");
  assert.equal(manifest.regeneration, "disabled");
  assert.equal(manifest.hashAlgorithm, "sha256");
  assert.equal(manifest.hashEncoding, "UTF-8");
  assert.equal(manifest.lineEndings, "LF");
  assert.equal(manifest.hashSource, "git blob at lastRegenerableSourceCommit after UTF-8 LF normalization");
  assert.ok(Array.isArray(manifest.artifacts));
  assert.equal(manifest.artifacts.length, expectedArtifactPaths.length);
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.path).sort(),
    [...expectedArtifactPaths].sort(),
    "frozen artifact set changed; update provenance deliberately rather than omitting an artifact"
  );

  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    assert.equal(typeof artifact.path, "string");
    assert.match(artifact.path, /^[A-Za-z0-9._/-]+\.json$/);
    assert.equal(path.posix.normalize(artifact.path), artifact.path);
    assert.equal(path.win32.normalize(artifact.path.replaceAll("/", "\\")).replaceAll("\\", "/"), artifact.path);
    assert.equal(path.isAbsolute(artifact.path), false);
    assert.equal(typeof artifact.provenance, "string");
    assert.match(artifact.provenance, /^Node /, "frozen provenance must identify the retired Node authority");
    assert.doesNotMatch(artifact.provenance, /\bGo\b|regenerat(?:ed|ion)/i, "Go output must not be presented as a Node golden");
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(seen.has(artifact.path), false, `duplicate frozen artifact path: ${artifact.path}`);
    seen.add(artifact.path);

    const absolutePath = path.resolve(repoRoot, artifact.path);
    assert.equal(absolutePath.startsWith(`${repoRoot}${path.sep}`), true, `artifact escaped repository: ${artifact.path}`);
    const contents = await readFile(absolutePath);
    const normalizedContents = Buffer.from(contents.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
    const sha256 = createHash("sha256").update(normalizedContents).digest("hex");
    assert.equal(sha256, artifact.sha256, `frozen artifact changed: ${artifact.path}`);
  }
});
