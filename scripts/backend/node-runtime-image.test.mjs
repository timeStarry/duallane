import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Node runtime starts its existing entry point without downloading a package manager", async () => {
  const dockerfile = await readFile(new URL("../../Dockerfile.api", import.meta.url), "utf8");
  const web = JSON.parse(await readFile(new URL("../../apps/web/package.json", import.meta.url), "utf8"));
  assert.equal(web.scripts.start, "NODE_ENV=production node server/index.mjs");
  assert.match(dockerfile, /ENV NODE_ENV=production/);
  assert.match(dockerfile, /WORKDIR \/app\/apps\/web\s+CMD \["node", "server\/index\.mjs"\]/);
  // Retained migration/storage commands still invoke pnpm in Compose. Carry
  // the build's exact package-manager cache so these can also start offline.
  assert.equal((dockerfile.match(/^ENV COREPACK_HOME=\/opt\/corepack$/gm) ?? []).length, 2);
  assert.match(dockerfile, /COPY --from=deps \/opt\/corepack \/opt\/corepack/);
});
