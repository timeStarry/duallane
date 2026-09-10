import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { workspaceAvatarObjectKey } from "../../apps/web/server/services/workspace-object-store.mjs";

// This oracle calls the retained Node producer. Go's real S3 reader tests
// consume the same synthetic fixture, so a Go-only key assumption cannot
// silently redefine the historical provider layout.
test("legacy avatar S3 fixtures match the actual Node key producer", async () => {
  const fixture = JSON.parse(await readFile(new URL(
    "../../apps/backend/internal/workspace/avatars/testdata/node-legacy-avatar-keys.json",
    import.meta.url
  ), "utf8"));
  assert.equal(fixture.source, "apps/web/server/services/workspace-object-store.mjs#workspaceAvatarObjectKey");
  assert.equal(fixture.cases.length, 2);
  for (const entry of fixture.cases) {
    assert.equal(workspaceAvatarObjectKey(entry), entry.s3Key, entry.name);
    assert.notEqual(entry.localKey, entry.s3Key, entry.name);
  }
});
