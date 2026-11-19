import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDevelopment } from "./development.mjs";
import { prepareOtaArtifact } from "./development-ota.mjs";

const TICKET = Object.freeze({
  id: "DL-TEST-UNREAD", text: "Fix unread clearing before open and keep pack stickers out of Favorites.",
  context: "One explicitly cited note",
  createdAt: "2026-11-19T03:00:00.000Z",
  source: { spaceId: "space-fixture", conversationId: "conv-fixture", messageId: "msg-fixture", actorId: "usr-fixture" },
});
const FIXTURE = String.raw`
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
let raw = "";
for await (const bytes of process.stdin) raw += bytes;
const request = JSON.parse(raw);
const stage = request.protocol.split(".").at(-1);
const mode = process.argv[2] ?? "normal";
assert.equal(request.version, 1);
assert.match(request.ticketId, /^DL-/);
const secretNames = ["GH_TOKEN", "DUALLANE_DEV_GITHUB_TOKEN", "DUALLANE_BOT_TOKEN", "DUALLANE_TASK_BROKER_KEY", "SSH_AUTH_SOCK", "PROD_SECRET"];
for (const name of secretNames) assert.equal(process.env[name], undefined);
assert(!existsSync(".git"));
if (mode === "timeout") await new Promise((resolve) => setTimeout(resolve, 60_000));
if (mode === "invalid-json") { console.log("not JSON"); process.exit(0); }
const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
};
const versionBump = (file) => {
  const data = JSON.parse(readFileSync(file, "utf8"));
  put(file, JSON.stringify({ ...data, version: "1.2.4" }) + "\n");
};
const example = (repo) => repo === "main" ? "apps/web/src/unread.ts" : "src/favorites.ts";
if (stage === "evaluate") {
  assert(!Object.hasOwn(request, "source"));
  assert.equal(request.context, "One explicitly cited note");
  assert.equal(request.budgetMinutes, 60);
  console.log(JSON.stringify({
    decision: "accept", reason: "The false unread and favorite state is reproducible.",
    repositories: mode === "unknown-repo" ? ["dangerous-repo"] : ["mobile", "main"],
    estimatedMinutes: mode === "over-budget" ? 240 : 25,
    acceptance: ["Unread changes only after opening", "Pack membership stays separate from favorites"],
  }));
} else if (stage === "develop") {
  assert.equal(request.context, "One explicitly cited note");
  assert.match(request.base, /^[0-9a-f]{40}$/);
  put(example(request.repository), "export const fixed = true;\n");
  if (request.repository === "main") {
    versionBump("package.json");
    versionBump("apps/web/package.json");
    put(".env.example", readFileSync(".env.example", "utf8").replace("1.2.3", "1.2.4"));
  }
  if (mode === "protected") put(".github/workflows/ci.yml", "name: Fake CI\n");
  if (mode === "package-script") put("package.json", JSON.stringify({ name: "fixture", version: "1.2.4", scripts: { test: "echo false-positive" } }));
  if (mode === "native" && request.repository === "mobile") put("android/app/src/main/Test.kt", "// Development fixture\n");
  console.log(JSON.stringify({ summary: "Repair workspace state" }));
} else if (stage === "verify") {
  assert(!Object.hasOwn(request, "context"));
  assert.match(request.head, /^[0-9a-f]{40}$/);
  assert.match(request.tree, /^[0-9a-f]{40}$/);
  assert.match(process.cwd(), /[/\\]verify$/);
  assert.equal(readFileSync(example(request.repository), "utf8"), "export const fixed = true;\n");
  if (mode === "dirty-verify") put(example(request.repository), "export const fixed = false;\n");
  if (request.releaseKind === "ota") {
    put("android/app/src/main/assets/www/index.html", "<!doctype html><title>OTA fixture</title>\n");
    put("android/app/src/main/assets/www/assets/index.js", "export const fixed=true;\n");
  }
  console.log(JSON.stringify({ passed: true, evidence: ["Scoped workspace behavior passed"] }));
}
`;

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(t) {
  const temporaryParent = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryParent, "duallane-development-"));
  t.after(async () => {
    const target = await realpath(root);
    assert.equal(dirname(target), temporaryParent);
    assert.match(basename(target), /^duallane-development-/u);
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  const model = join(root, "fixture-stage.mjs");
  await writeFile(model, FIXTURE);
  const main = join(root, "source-main");
  const mobile = join(root, "source-mobile");
  async function repo(path, type) {
    await mkdir(path);
    git(path, "init", "-q", "--initial-branch=main");
    git(path, "config", "user.name", "DualLane Test Fixture");
    git(path, "config", "user.email", "duallane-fixture@example.invalid");
    const metadata = JSON.stringify({ name: "fixture", version: type === "main" ? "1.2.3" : "1.1.0" });
    await writeFile(join(path, "package.json"), metadata);
    if (type === "main") {
      await mkdir(join(path, "apps", "web", "src"), { recursive: true });
      await writeFile(join(path, "apps", "web", "package.json"), metadata);
      await writeFile(join(path, "apps", "web", "src", "unread.ts"), "export const fixed = false;\n");
      await writeFile(join(path, ".env.example"), "DUALLANE_APP_VERSION=1.2.3\n");
    } else {
      await mkdir(join(path, "src"));
      await writeFile(join(path, "src", "favorites.ts"), "export const fixed = false;\n");
      await writeFile(join(path, ".gitignore"), "android/app/src/main/assets/www/\n");
    }
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", "Initialize fixture");
    return git(path, "rev-parse", "HEAD");
  }
  const [mainBase, mobileBase] = await Promise.all([repo(main, "main"), repo(mobile, "mobile")]);
  const command = (mode, timeoutMs = 20_000) => ({ file: process.execPath, args: [model, mode ?? "normal"], timeoutMs });
  const config = {
    workDirectory: join(root, "work"), artifactDirectory: join(root, "artifacts"), budgetMinutes: 60,
    commands: { evaluate: command(), develop: command(), verify: command() },
    ota: { version: "1.1.2", minNativeVersionCode: 10051 },
  };
  const env = { ...process.env };
  for (const key of ["GH_TOKEN", "DUALLANE_DEV_GITHUB_TOKEN", "DUALLANE_BOT_TOKEN", "DUALLANE_TASK_BROKER_KEY", "SSH_AUTH_SOCK", "PROD_SECRET"]) {
    env[key] = "test-only-credential-never-passed";
  }
  return { main, mobile, mainBase, mobileBase, root, command, config, env,
    build: (settings = {}) => createDevelopment({
      config: { ...config, ...settings, commands: { ...config.commands, ...settings.commands } },
      env, localRemotes: { main, mobile },
    }),
  };
}

test("pilot builds both reviewed commit trees and a pinned OTA without updating either remote", async (t) => {
  const f = await fixture(t);
  const adapter = f.build();
  const evaluation = await adapter.evaluate(TICKET);
  assert.equal(evaluation.decision, "accept");
  assert.deepEqual(evaluation.repositories, ["main", "mobile"]);
  const candidate = await adapter.develop(TICKET, evaluation);
  assert.deepEqual(candidate.goWeb, { version: "1.2.4" });
  assert.equal(candidate.native, false);
  assert.equal(candidate.ota.version, "1.1.2");
  assert.equal(candidate.ota.minNativeVersionCode, 10051);
  assert.deepEqual(candidate.ota.files.map((file) => file.path), ["assets/index.js", "index.html"]);
  const packaged = await readFile(join(f.config.artifactDirectory, `${candidate.ota.sha256}.zip`));
  assert.equal(createHash("sha256").update(packaged).digest("hex"), candidate.ota.sha256);
  assert.equal(packaged.readUInt32LE(0), 0x04034b50);
  assert.equal(candidate.evidence.length, 2);
  const [job] = (await readdir(f.config.workDirectory)).filter((dir) => dir.includes("-work-"));
  for (const change of candidate.changes) {
    assert.equal(change.number, null);
    const repo = change.repo === "main" ? f.main : f.mobile;
    const base = change.repo === "main" ? f.mainBase : f.mobileBase;
    assert.equal(change.base, base);
    assert.equal(git(repo, "rev-parse", "refs/heads/main"), base);
    assert.equal(git(repo, "branch", "--list", "codex/*"), "");
    const gitDirectory = join(f.config.workDirectory, job, change.repo, "develop-git");
    assert.equal(git(f.root, `--git-dir=${gitDirectory}`, "rev-parse", "refs/heads/codex/dl-test-unread^{tree}"), change.tree);
  }
});

test("evaluation refuses budget overflow and unknown repositories without delegating to development", async (t) => {
  const f = await fixture(t);
  const adapter = f.build({ commands: { evaluate: f.command("over-budget") } });
  const decision = await adapter.evaluate(TICKET);
  assert.equal(decision.decision, "decline");
  assert.match(decision.reason, /240.*60/);
  await assert.rejects(adapter.develop(TICKET, decision), { code: "development.ticket_not_accepted" });
  const unknown = f.build({ commands: { evaluate: f.command("unknown-repo") } });
  await assert.rejects(unknown.evaluate(TICKET), { code: "development.invalid_evaluation" });
});

test("the development stage cannot change CI or replace a manifest validation command", async (t) => {
  const f = await fixture(t);
  const evaluation = await f.build().evaluate(TICKET);
  const protectedPaths = f.build({ commands: { develop: f.command("protected") } });
  await assert.rejects(protectedPaths.develop(TICKET, evaluation), { code: "development.protected_path" });
  const manifest = f.build({ commands: { develop: f.command("package-script") } });
  await assert.rejects(manifest.develop(TICKET, evaluation), { code: "development.protected_package_change" });
});

test("verification fails if the independent command changes the committed snapshot", async (t) => {
  const f = await fixture(t);
  const adapter = f.build({ commands: { verify: f.command("dirty-verify") } });
  const evaluation = await adapter.evaluate(TICKET);
  await assert.rejects(adapter.develop(TICKET, evaluation), { code: "development.verification_failed" });
});

test("native Android work produces a manual candidate and no OTA artifact", async (t) => {
  const f = await fixture(t);
  const adapter = f.build({ commands: { develop: f.command("native") } });
  const evaluation = { ...(await adapter.evaluate(TICKET)), repositories: ["mobile"] };
  const candidate = await adapter.develop(TICKET, evaluation);
  assert.equal(candidate.native, true);
  assert.equal(candidate.ota, null);
  assert.equal(candidate.changes[0].number, null);
});

test("commands are time-bounded and malformed output is reported without echoing it", async (t) => {
  const f = await fixture(t);
  const timeout = f.build({ commands: { evaluate: f.command("timeout", 250) } });
  await assert.rejects(timeout.evaluate(TICKET), { code: "development.evaluate_timeout" });
  const invalid = f.build({ commands: { evaluate: f.command("invalid-json") } });
  await assert.rejects(invalid.evaluate(TICKET), { code: "development.evaluate_invalid_result" });
  await assert.rejects(invalid.evaluate({ ...TICKET, text: "https://example.invalid/r#k=private" }), { code: "development.invalid_text" });
});

test("OTA artifact bytes are deterministic and invalid entries never reach the artifact store", async (t) => {
  const f = await fixture(t);
  const built = resolve(f.root, "built");
  await mkdir(built);
  await writeFile(join(built, "index.html"), "<!doctype html><title>OTA fixture</title>\n");
  const [a, b] = await Promise.all([
    prepareOtaArtifact(built, f.config.artifactDirectory),
    prepareOtaArtifact(built, f.config.artifactDirectory),
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(await readdir(f.config.artifactDirectory), [`${a.sha256}.zip`]);
  await writeFile(join(built, "secret.env"), "synthetic-only");
  await assert.rejects(prepareOtaArtifact(built, f.config.artifactDirectory), { code: "development.ota_invalid_entry" });
});

const wslConfig = process.env.DUALLANE_RELEASE_TEST_WSL_CONFIG;
test("WSL verifier runs both build paths with no host mounts or external network", { skip: !wslConfig, timeout: 180_000 }, async (t) => {
  const f = await fixture(t);
  const distro = process.env.DUALLANE_RELEASE_TEST_WSL_DISTRO || "Ubuntu-24.04";
  const executable = fileURLToPath(new URL("./development-wsl-verify.mjs", import.meta.url));
  const mountPath = execFileSync("wsl.exe", ["-d", distro, "--exec", "wslpath", "-a", executable.replaceAll("\\", "/")], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const runtime = process.env.DUALLANE_RELEASE_TEST_WSL_NODE || "/opt/duallane-pr21-tools/node22/bin/node";
  const inspect = String.raw`
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
assert.equal(process.cwd(), "/checkout");
assert.equal(process.env.HOME, "/home/verify");
assert(!existsSync("/mnt"));
assert(!existsSync("/mnt/c"));
assert(!existsSync("/run"));
assert.deepEqual(readdirSync("/home"), ["verify"]);
assert.throws(() => readFileSync("../sibling-canary.txt"), { code: "ENOENT" });
assert.deepEqual(readdirSync("/cache").sort(), ["go-mod", "pnpm"]);
assert.equal(process.env.DUALLANE_BOT_TOKEN, undefined);
assert.equal(process.env.GOPROXY, "off");
assert.equal((await lookup("localhost", { family: 4 })).address, "127.0.0.1");
await assert.rejects(lookup("example.invalid"), { code: "ENOTFOUND" });
const mounts = new Map(readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map((line) => {
  const fields = line.split(" ");
  return [fields[4], fields[5].split(",")];
}));
assert(mounts.get("/checkout").includes("rw"));
for (const mount of ["/cache/go-mod", "/cache/pnpm", "/tools/node", "/tools/go", "/tools/pnpm", "/usr"]) {
  assert(mounts.get(mount).includes("ro"));
}
assert.deepEqual([...readFileSync("/proc/net/dev", "utf8").matchAll(/^\s*([^ :]+):/gm)].map((match) => match[1]), ["lo"]);
mkdirSync("android/app/src/main/assets/www", { recursive: true });
writeFileSync("android/app/src/main/assets/www/index.html", "verified fixture\n");
`;
  async function run(repository) {
    const checkout = join(f.root, "wsl", repository, "verify");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(dirname(checkout), "sibling-canary.txt"), "synthetic private file outside the candidate\n");
    const scripts = Object.fromEntries(["check", "build:web", "test", "lint", "build"].map((name) => [name, "node inspect.mjs"]));
    await writeFile(join(checkout, "package.json"), JSON.stringify({
      name: "verified-fixture", version: "1.0.0", private: true, packageManager: "pnpm@10.30.3", scripts,
    }));
    await writeFile(join(checkout, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
    await writeFile(join(checkout, "inspect.mjs"), inspect);
    if (repository === "main") {
      const backend = join(checkout, "apps", "backend");
      const command = join(backend, "cmd", "fixture");
      await mkdir(command, { recursive: true });
      await writeFile(join(backend, "go.mod"), "module example.invalid/fixture\n\ngo 1.26.0\n");
      await writeFile(join(command, "main.go"), "package main\n\nfunc main() {}\n");
    }
    const payload = { protocol: "duallane.release-agent.verify", version: 1, ticketId: TICKET.id, repository,
      base: f.mainBase, head: f.mainBase, tree: f.mainBase, releaseKind: repository === "main" ? "go-web" : "ota" };
    const output = await new Promise((resolveRun, reject) => {
      const child = execFile("wsl.exe", ["-d", distro, "--exec", runtime, mountPath, wslConfig], {
        cwd: checkout, env: { ...process.env, DUALLANE_BOT_TOKEN: "synthetic-must-not-cross" }, timeout: 160_000,
      }, (error, stdout) => error ? reject(error) : resolveRun(stdout));
      child.stdin.end(JSON.stringify(payload));
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.passed, true, JSON.stringify(parsed));
    assert.match(await readFile(join(checkout, "android", "app", "src", "main", "assets", "www", "index.html"), "utf8"), /verified fixture/u);
  }
  await run("mobile");
  await run("main");
});
