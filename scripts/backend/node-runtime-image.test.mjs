import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = async (name) => (await readFile(path.join(root, name), "utf8")).replaceAll("\r\n", "\n");

test("Node online code and image are retired while canonical SQL and browser tooling remain", async () => {
  for (const entry of await readdir(path.join(root, "apps/web/server"), { withFileTypes: true })) {
    if (entry.name === "migrations") continue;
    // apply_patch can leave empty directories in an existing worktree; a clean
    // checkout does not track those. Neither may contain old runtime files.
    assert.ok(entry.isDirectory());
    assert.deepEqual(await readdir(path.join(root, "apps/web/server", entry.name)), []);
  }
  await assert.rejects(access(path.join(root, "Dockerfile.api")), { code: "ENOENT" });
  const web = JSON.parse(await read("apps/web/package.json"));
  assert.equal(web.scripts.start, undefined);
  assert.equal(web.scripts["db:migrate"], undefined);
  for (const dependency of ["fastify", "@fastify/cookie", "@fastify/static", "@fastify/websocket", "nodemailer", "sharp", "pg", "@aws-sdk/client-s3"]) {
    assert.equal(web.dependencies[dependency], undefined, dependency);
  }
  assert.ok(web.dependencies.vite && web.dependencies.react && web.dependencies.unified);
  const sql = await readdir(path.join(root, "apps/web/server/migrations"));
  assert.equal(sql.filter(name => name.endsWith(".sql")).length, 34);
  assert.ok(sql.includes("034_workspace_chat_auto_hide.sql"));
  await access(path.join(root, "packages/agent-sdk/package.json"));
});

test("the only retained Node image has no listener or automatic operator action", async () => {
  const dockerfile = await read("tools/node-compat/Dockerfile");
  assert.match(dockerfile, /^USER 65532:65532$/m);
  assert.match(dockerfile, /^CMD \["node", "--help"\]$/m);
  assert.doesNotMatch(dockerfile, /^EXPOSE |server\/|^ENTRYPOINT /m);
  assert.doesNotMatch(dockerfile.split("AS runtime")[1], /corepack|pnpm/);
  const compose = await read("docker-compose.yml");
  assert.doesNotMatch(compose, /^  api:|Dockerfile\.api|server\/index\.mjs/m);
});

test("Web image includes the shared Vite routing configuration without development runners", async () => {
  const dockerfile = await read("deploy/candidate/Dockerfile.web");
  const ignore = await read("deploy/candidate/Dockerfile.web.dockerignore");
  const config = "scripts/dev/go-dev-config.mjs";
  assert.ok(dockerfile.includes(`COPY ${config} ${config}`));
  assert.ok(dockerfile.indexOf(`COPY ${config} ${config}`) < dockerfile.indexOf("RUN pnpm --filter @duallane/web build"));
  assert.ok(ignore.split("\n").includes(`!${config}`));
  assert.doesNotMatch(ignore, /^!scripts\/\*\*|^!scripts\/dev\/\*\*|^!scripts\/dev\/go-dev\.mjs$/m);
});

test("production rejects retired entry paths before touching Docker", () => {
  for (const args of [[], ["--release-profile", "node-default"], ["--bootstrap", "--go-upgrade"], ["--prepare-go-permissions", "--go-upgrade"]]) {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c",
      'docker() { echo unexpected-docker; return 97; }; export -f docker; bash deploy/production/deploy.sh "$@"', "retirement-test", ...args],
    { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Node runtime retired/);
    assert.doesNotMatch(result.stdout, /unexpected-docker/);
  }
});

test("legacy API lookup still finds orphan owners and fails closed on daemon lookup errors", async () => {
  const identity = "a".repeat(64);
  for (const mode of ["present", "absent", "failure"]) {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", [
      'source deploy/production/release-helper.sh',
      'COMPOSE_PROJECT_NAME=duallane-retirement-test',
      'compose() { [[ "$*" == "config --services" ]] || return 98; printf "p2p\\nworkspace\\nworker\\nweb\\npostgres\\nmigrate\\n"; }',
      'docker() { [[ "$*" == "ps -a --no-trunc --filter label=com.docker.compose.project=duallane-retirement-test --filter label=com.docker.compose.service=api --format {{.ID}}" ]] || return 99;',
      mode === "failure" ? 'return 96; }' : mode === "present" ? `printf '%s\\n' '${identity}'; }` : 'return 0; }',
      'release_current_service_ids api'
    ].join("\n")], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, mode === "failure" ? 96 : 0);
    assert.equal(result.stdout.trim(), mode === "present" ? identity : "");
  }
});
