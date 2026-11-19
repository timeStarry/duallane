import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const PRODUCTION = "/home/timestarry/duallane";
const BACKUPS = `${PRODUCTION}/backups/production`;
const PROJECT = "duallane";
const OWNER = "timestarry";
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SERVICES = ["p2p", "workspace", "worker", "web"];
const ENV = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" };
const SIDECARS = ["", ".compose.json", ".external.json", ".volumes.json"];
const SNAPSHOT = /^duallane-[A-Za-z0-9-]+\.recovery\.go-compose\.snapshot\.json$/;
const ADOPTED = /^observed-go-baseline-[A-Za-z0-9-]+\/observed-go-baseline\.snapshot\.json$/;
const DOCKER_FORMAT = ["{{.Name}}", '{{index .Config.Labels "com.docker.compose.project"}}',
  '{{index .Config.Labels "com.docker.compose.service"}}', "{{.State.Running}}", "{{.State.Health.Status}}",
  '{{index .Config.Labels "org.opencontainers.image.revision"}}',
  '{{index .Config.Labels "org.opencontainers.image.version"}}', "{{.Image}}"].join("\t");

function requireOperator(condition) {
  if (!condition) throw new Error("go_operator_guard");
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function command(file, args) {
  return execFileSync(file, args, { encoding: "utf8", env: ENV, timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 }).trim();
}

function git(...args) {
  return command("runuser", ["-u", OWNER, "--", "git", "-C", PRODUCTION, ...args]);
}

function runningIdentity() {
  const images = {};
  let commit;
  let version;
  for (const service of SERVICES) {
    const name = `${PROJECT}-${service}-1`;
    const info = command("docker", ["inspect", "--format", DOCKER_FORMAT, name]);
    const [actualName, project, application, running, health, revision, semver, image] = info.split("\t");
    requireOperator(actualName === `/${name}` && project === PROJECT && application === service && running === "true" &&
      health === "healthy" && SHA.test(revision) && VERSION.test(semver) && /^sha256:[0-9a-f]{64}$/.test(image));
    commit ??= revision;
    version ??= semver;
    requireOperator(revision === commit && semver === version);
    images[service] = image;
  }
  return { commit, version, images };
}

function privateBytes(file) {
  const st = lstatSync(file);
  requireOperator(st.isFile() && st.uid === 0 && (st.mode & 0o777) === 0o600 && st.size > 0 && st.size <= 8 * 1024 * 1024 &&
    realpathSync(file) === file);
  return readFileSync(file);
}

function inspectSnapshot(file, running) {
  const relative = path.relative(BACKUPS, file);
  const observed = ADOPTED.test(relative);
  requireOperator(SNAPSHOT.test(relative) || observed);
  const bytes = privateBytes(file);
  const snapshot = JSON.parse(bytes);
  requireOperator(snapshot.format === "duallane.release-compose-snapshot" && snapshot.version === 1 &&
    snapshot.profile === "go-full" && snapshot.project === PROJECT && snapshot.commit === running.commit &&
    snapshot.semver === running.version && SERVICES.every(service => snapshot.imageIDs?.[service] === running.images[service]));
  const sidecars = observed ? [...SIDECARS, ".adoption.json"] : SIDECARS;
  const digests = sidecars.map(suffix => hash(suffix ? privateBytes(file + suffix) : bytes));
  return { status: "completed", healthy: true, commit: running.commit, version: running.version,
    snapshotSha256: hash(digests.join("\n")) };
}

function findSnapshot(running, pinned) {
  if (pinned !== undefined) {
    requireOperator(typeof pinned === "string" && path.isAbsolute(pinned) && path.normalize(pinned) === pinned);
    return { file: pinned, receipt: inspectSnapshot(pinned, running) };
  }
  const candidates = readdirSync(BACKUPS, { withFileTypes: true }).flatMap(entry => {
    if (entry.isFile() && SNAPSHOT.test(entry.name)) return [path.join(BACKUPS, entry.name)];
    if (entry.isDirectory() && /^observed-go-baseline-[A-Za-z0-9-]+$/.test(entry.name)) {
      return [path.join(BACKUPS, entry.name, "observed-go-baseline.snapshot.json")];
    }
    return [];
  }).sort().reverse();
  for (const file of candidates) {
    try { return { file, receipt: inspectSnapshot(file, running) }; }
    catch { /* Skip snapshots for other images and incomplete private artifacts. */ }
  }
  throw new Error("go_operator_baseline_unavailable");
}

function versionAt(file) {
  return JSON.parse(readFileSync(path.join(PRODUCTION, file), "utf8")).version;
}

function assertCheckout(target) {
  requireOperator(git("branch", "--show-current") === "main" && git("status", "--porcelain") === "");
  git("pull", "--ff-only", "origin", "main");
  requireOperator(git("rev-parse", "HEAD") === target.commit &&
    git("rev-parse", "refs/remotes/origin/main") === target.commit && git("status", "--porcelain") === "" &&
    versionAt("package.json") === target.version && versionAt("apps/web/package.json") === target.version);
}

function release(request) {
  requireOperator((request?.operation === "inspect" || request?.operation === "deploy") &&
    process.platform === "linux" && process.getuid() === 0 &&
    realpathSync(PRODUCTION) === PRODUCTION && realpathSync(BACKUPS) === BACKUPS);
  const previous = findSnapshot(runningIdentity(), request.previousSnapshot);
  if (request.operation === "inspect") return previous.receipt;

  const { target, baseline } = request;
  requireOperator(SHA.test(target?.commit) && VERSION.test(target?.version) &&
    DIGEST.test(baseline?.snapshotSha256) && isDeepStrictEqual(baseline, {
      commit: previous.receipt.commit, version: previous.receipt.version, snapshotSha256: previous.receipt.snapshotSha256,
    }));
  const journal = openSync(path.join(BACKUPS, `operator-release-${target.commit}-${randomUUID()}.log`), "wx", 0o600);
  try {
    assertCheckout(target);
    // Recheck the rollback authority after fetching and before handing off to
    // the existing deployment coordinator. Its production lock and rollback
    // verification remain authoritative during activation.
    const latest = inspectSnapshot(previous.file, runningIdentity());
    requireOperator(isDeepStrictEqual(latest, previous.receipt));
    try {
      execFileSync("/bin/bash", [`${PRODUCTION}/deploy/production/deploy.sh`, "--expected-commit", target.commit,
        "--release-profile", "go-full", "--go-upgrade", "--previous-release-snapshot", previous.file], {
        cwd: PRODUCTION, stdio: ["ignore", journal, journal], env: { ...ENV, DUALLANE_PRODUCTION_DIR: PRODUCTION,
          GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: PRODUCTION },
      });
      const active = findSnapshot(runningIdentity()).receipt;
      requireOperator(active.commit === target.commit && active.version === target.version);
      return active;
    } catch {
      return { status: "uncertain" };
    }
  } finally {
    closeSync(journal);
  }
}

try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    requireOperator(size <= 4096);
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks));
  process.stdout.write(JSON.stringify(release(request)) + "\n");
} catch {
  process.stdout.write('{"status":"blocked"}\n');
}
