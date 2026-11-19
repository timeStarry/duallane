import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, unlink } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { safeText } from "./channel.mjs";
import { gitSha, repositoryNames as REPOSITORIES, stableVersion } from "./config.mjs";
import {
  developmentError as fail, isolatedEnvironment, runDevelopmentProcess, runDevelopmentStage,
  validateDevelopmentCommand,
} from "./development-command.mjs";
import { prepareOtaArtifact } from "./development-ota.mjs";

const STAGES = ["evaluate", "develop", "verify"];
const DECISIONS = new Set(["accept", "decline", "needs_info", "duplicate"]);
const SECRET = /(?:#|%23)k(?:=|%3d)|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bgh[pousr]_[a-z\d_]{20,}|\bgithub_pat_[a-z\d_]{20,}|\bsk-(?:proj-)?[a-z\d_-]{24,}/iu;

function shortText(value, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum ||
      /(?![\n\r\t])[\p{Cc}\p{Cf}]/u.test(value) || SECRET.test(value)) {
    throw fail("development.invalid_text");
  }
  return value.trim();
}

function sourceTicket(ticket) {
  if (typeof ticket?.id !== "string" || !/^DL-[A-Z0-9-]{1,48}$/iu.test(ticket.id)) throw fail("development.invalid_ticket");
  const context = safeText(ticket.context, 2000);
  return { id: ticket.id, text: shortText(ticket.text, 8000), context: context ? shortText(context, 2000) : null };
}

function normalizeEvaluation(result, budgetMinutes) {
  if (!DECISIONS.has(result?.decision)) throw fail("development.invalid_evaluation");
  const reason = shortText(result.reason, 480);
  if (result.decision !== "accept") return { decision: result.decision, reason };
  const { repositories, estimatedMinutes, acceptance } = result;
  if (!Number.isSafeInteger(estimatedMinutes) || estimatedMinutes < 1 || !Array.isArray(repositories) ||
      !repositories.length || repositories.length > 2 || new Set(repositories).size !== repositories.length ||
      !repositories.every((repo) => Object.hasOwn(REPOSITORIES, repo)) || !Array.isArray(acceptance) ||
      !acceptance.length || acceptance.length > 8) throw fail("development.invalid_evaluation");
  if (estimatedMinutes > budgetMinutes) {
    return { decision: "decline", reason: `本次需求估计需要 ${estimatedMinutes} 分钟，超出单工单 ${budgetMinutes} 分钟的预算。` };
  }
  return { decision: "accept", reason, repositories: [...repositories].sort(), estimatedMinutes,
    acceptance: acceptance.map((criterion) => shortText(criterion, 350)) };
}

async function executable(name, configured, env) {
  const candidates = configured ? [configured] : (env.Path || env.PATH || "").split(delimiter)
    .filter(isAbsolute).map((directory) => join(directory, process.platform === "win32" ? `${name}.exe` : name));
  for (const path of candidates) {
    if (typeof path !== "string" || !isAbsolute(path)) continue;
    try {
      await access(path, constants.X_OK);
      if ((await lstat(path)).isFile()) return path;
    } catch { /* A configured executable can be unavailable on this host. */ }
  }
  throw fail(`development.${name}_unavailable`);
}

function versionParts(value) {
  if (!stableVersion(value)) throw fail("development.invalid_release_version");
  return value.split(".").map(Number);
}

function newerVersion(newVersion, oldVersion) {
  const [major, minor, patch] = versionParts(newVersion);
  const [oldMajor, oldMinor, oldPatch] = versionParts(oldVersion);
  return major > oldMajor || (major === oldMajor && (minor > oldMinor || (minor === oldMinor && patch > oldPatch)));
}

function changedPaths(raw) {
  const fields = raw.split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0) throw fail("development.invalid_git_diff");
  const paths = [];
  for (let index = 0; index < fields.length; index += 2) {
    const [, afterMode] = fields[index].split(" ");
    const path = fields[index + 1];
    if (!["000000", "100644", "100755"].includes(afterMode) || /[\p{Cc}\p{Cf}\\:]/u.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === "..")) throw fail("development.invalid_changed_path");
    const lower = path.toLowerCase();
    if (/^(?:\.github\/|deploy\/|tools\/release-agent\/|packages\/agent-sdk\/|scripts\/backend\/|apps\/web\/(?:public\/emotes\/|server\/migrations\/)|apps\/backend\/internal\/(?:platform\/migrations\/|workspace\/(?:auth|botgateway|bots)\/))/.test(lower) ||
        /^(?:dockerfile(\.|$)|docker-compose[.-]|\.npmrc$)/.test(lower) ||
        /(?:^|\/)(?:\.git[^/]*|agents\.md|skill\.md|pnpm-(?:lock|workspace)\.yaml|go\.mod|go\.sum)(?:\/|$)/.test(lower) ||
        (lower !== ".env.example" && /(?:^|\/)\.env[^/]*(?:\/|$)/.test(lower))) {
      throw fail("development.protected_path");
    }
    paths.push(path);
  }
  if (!paths.length || paths.length > 80) throw fail("development.invalid_change_count");
  return paths;
}

function decideRelease(repo, paths) {
  if (repo === "main") {
    return paths.some((path) => /^(?:apps\/|package\.json$|\.env\.example$)/u.test(path) &&
      !/(?:\.test\.[^/.]+$|_test\.go$|\.md$)/iu.test(path)) ? "go-web" : "none";
  }
  if (paths.some((path) => /^(?:android\/|src\/native\/|gradle(?:[./]|$)|scripts\/build-icons\.mjs$)/iu.test(path))) {
    return "native";
  }
  return paths.some((path) => /^(?:src\/|public\/|index\.html$|vite\.config\.)/u.test(path) &&
    !/(?:\.test\.[^/.]+$|\.md$)/iu.test(path)) ? "ota" : "none";
}

function otaPolicy(value) {
  if (!value || !Number.isSafeInteger(value.minNativeVersionCode) || value.minNativeVersionCode < 1 ||
      value.minNativeVersionCode > 2_100_000_000) throw fail("development.ota_policy_required");
  versionParts(value.version);
  return { version: value.version, minNativeVersionCode: value.minNativeVersionCode };
}

function commandPayload(stage, ticketId, fields) {
  return { protocol: `duallane.release-agent.${stage}`, version: 1, ticketId, ...fields };
}

function parseJson(value, code) {
  try { return JSON.parse(value); } catch { throw fail(code); }
}

function checkedGitId(value) {
  const id = value.trim();
  if (!gitSha(id)) throw fail("development.invalid_git_identity");
  return id;
}

async function requireMissingGitPointer(directory) {
  try { await lstat(join(directory, ".git")); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw fail("development.worker_git_metadata");
}

async function readGitConfig(metadata) {
  const file = join(metadata, "config");
  const info = await lstat(file);
  if (!info.isFile() || info.size > 16_384 || info.nlink !== 1) throw fail("development.worker_git_metadata");
  return await readFile(file, "utf8");
}

function releaseVersion(manifest) {
  versionParts(manifest?.version);
  return manifest.version;
}

async function checkReleaseMetadata(git, paths, base, releaseKind) {
  const manifestPaths = new Set(paths.filter((path) => /(?:^|\/)package\.json$/iu.test(path)));
  if (releaseKind === "go-web") {
    manifestPaths.add("package.json");
    manifestPaths.add("apps/web/package.json");
  }
  const versions = new Map();
  for (const path of manifestPaths) {
    const oldManifest = parseJson(await git(["show", `${base}:${path}`]), "development.invalid_package_metadata");
    const newManifest = parseJson(await git(["show", `:${path}`]), "development.invalid_package_metadata");
    const oldVersion = releaseVersion(oldManifest);
    const newVersion = releaseVersion(newManifest);
    if (!isDeepStrictEqual({ ...oldManifest, version: null }, { ...newManifest, version: null })) {
      throw fail("development.protected_package_change");
    }
    versions.set(path, { oldVersion, newVersion });
  }
  if (releaseKind !== "go-web") {
    if (paths.includes(".env.example")) throw fail("development.protected_environment_change");
    return null;
  }
  const root = versions.get("package.json");
  const web = versions.get("apps/web/package.json");
  if (root.newVersion !== web.newVersion || !newerVersion(root.newVersion, root.oldVersion) ||
      !newerVersion(web.newVersion, web.oldVersion)) throw fail("development.go_release_version_required");
  if (paths.includes(".env.example")) {
    const oldEnv = (await git(["show", `${base}:.env.example`])).replace(/\r\n/gu, "\n");
    const newEnv = (await git(["show", ":.env.example"])).replace(/\r\n/gu, "\n");
    if (newEnv !== oldEnv.replace(/^DUALLANE_APP_VERSION=.*$/mu, `DUALLANE_APP_VERSION=${root.newVersion}`)) {
      throw fail("development.protected_environment_change");
    }
  }
  return { version: root.newVersion };
}

function pullRequestBody(ticketId, head) {
  return [
    "## Purpose", `Implement the scoped DualLane change tracked as ${ticketId}.`,
    "## Changes", "Review the candidate diff and linked CI before approving the change.",
    "## Scope And Non-Goals", "This draft covers the affected DualLane repository and workspace behavior.",
    "## Risk Review", "Review authentication, privacy, retention, compatibility and rollout against the repository checklist.",
    "## Validation", `Independent verification succeeded on commit \`${head}\`. Review the required CI jobs for this candidate.`,
    "## Migration, Release, And Rollback", "The maintainer reviews the release candidate, approved version and rollback baseline.",
    "## Merge Authorization", "Only the repository maintainer can merge this pull request.",
  ].map((section, index) => index % 2 === 0 ? section : `${section}\n`).join("\n\n");
}

export function createDevelopment({ config, env = process.env, localRemotes = {} }) {
  if (!config || !isAbsolute(config.workDirectory || "") || !isAbsolute(config.artifactDirectory || "") ||
      !Number.isSafeInteger(config.budgetMinutes) || config.budgetMinutes < 1 || config.budgetMinutes > 1440) {
    throw fail("development.invalid_configuration");
  }
  const commands = Object.fromEntries(STAGES.map((label) => [label, validateDevelopmentCommand(config.commands?.[label], label)]));
  if (config.repositories && Object.entries(config.repositories).some(([key, repository]) =>
    !Object.hasOwn(REPOSITORIES, key) || (typeof repository === "string" ? repository : repository?.fullName) !== REPOSITORIES[key])) {
    throw fail("development.invalid_repository_configuration");
  }
  const allowDraftPush = config.allowDraftPush === true;
  if (allowDraftPush && Object.keys(localRemotes).length) throw fail("development.test_remote_forbidden");
  const budgetMinutes = config.budgetMinutes;

  function stageSignal(signal) {
    const budget = AbortSignal.timeout(budgetMinutes * 60_000);
    return signal ? AbortSignal.any([signal, budget]) : budget;
  }

  async function scratch(id, stage) {
    await mkdir(config.workDirectory, { recursive: true, mode: 0o700 });
    // Resolve operator-owned aliases (including Windows short names) before
    // comparing canonical paths inside the candidate checkout.
    return await mkdtemp(join(await realpath(config.workDirectory), `${id.toLowerCase()}-${stage}-`));
  }

  async function invoke(stage, cwd, home, ticketId, fields, signal) {
    await mkdir(home, { recursive: true, mode: 0o700 });
    return await runDevelopmentStage(commands[stage], {
      label: stage, cwd, home, env, payload: commandPayload(stage, ticketId, fields), signal,
    });
  }

  async function makeGit(home, checkoutRoot, signal) {
    const file = await executable("git", config.gitExecutable, env);
    const gitEnv = {
      ...isolatedEnvironment(home, env),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const hooksPath = join(home, "hooks");
    await mkdir(hooksPath, { recursive: true, mode: 0o700 });
    return async (args, { worktree, metadata, token, maxOutput } = {}) => {
      const credentials = token ? {
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      } : {};
      const repository = metadata ? [`--git-dir=${metadata}`, `--work-tree=${worktree}`] : [];
      return await runDevelopmentProcess(file, ["--no-pager", "--no-replace-objects", "-c", `core.hooksPath=${hooksPath}`,
        "-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", "core.longpaths=true", "-c", "credential.helper=",
        "-c", "http.sslVerify=true", "-c", "http.followRedirects=false",
        ...repository, ...args], {
        cwd: checkoutRoot, env: { ...gitEnv, ...credentials }, signal, label: "git", maxOutput,
      });
    };
  }

  async function openDraft(change, branch, git, remote, home, ticketId, signal) {
    const token = env.DUALLANE_DEV_GITHUB_TOKEN;
    if (typeof token !== "string" || !/^[a-z\d_.-]{20,4096}$/iu.test(token)) throw fail("development.github_token_required");
    const name = REPOSITORIES[change.repo];
    const ref = `refs/heads/${branch}`;
    const remoteOutput = await git(["ls-remote", "--refs", remote, "refs/heads/main", ref], { token });
    const remoteRefs = new Map(remoteOutput.trim().split(/\r?\n/u).map((line) => line.split("\t").reverse()));
    if (remoteRefs.get("refs/heads/main") !== change.base) throw fail("development.main_advanced");
    const existingHead = remoteRefs.get(ref);
    if (existingHead && existingHead !== change.head) throw fail("development.branch_conflict");
    if (!existingHead) {
      // The empty expected value authorizes creating this draft branch only.
      await git(["push", `--force-with-lease=${ref}:`, remote, `${change.head}:${ref}`], { token });
    }
    const file = await executable("gh", config.ghExecutable, env);
    const gh = async (method, endpoint, payload) => parseJson(await runDevelopmentProcess(file,
      ["api", "--hostname", "github.com", "--method", method, endpoint, ...(payload ? ["--input", "-"] : [])], {
        cwd: home, env: { ...isolatedEnvironment(home, env), GH_TOKEN: token, GH_PROMPT_DISABLED: "1" },
        input: payload ? JSON.stringify(payload) : undefined, signal, label: "github", timeoutMs: 60_000,
      }), "development.invalid_github_reply");
    const path = `repos/${name}/pulls`;
    const filters = new URLSearchParams({ state: "all", head: `${name.split("/")[0]}:${branch}`, base: "main" });
    const prior = await gh("GET", `${path}?${filters}`);
    if (!Array.isArray(prior) || prior.length > 1) throw fail("development.pr_conflict");
    const pr = prior[0] ?? await gh("POST", path, {
      title: `Implement DualLane request ${ticketId}`, body: pullRequestBody(ticketId, change.head),
      draft: true, base: "main", head: branch, maintainer_can_modify: true,
    });
    if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || pr.head?.sha !== change.head || pr.head?.ref !== branch ||
        pr.base?.ref !== "main" || pr.state !== "open" || pr.draft !== true) throw fail("development.pr_conflict");
    return pr.number;
  }

  async function developRepository(ticket, evaluation, repo, workRoot, options) {
    const { signal } = options;
    const branch = `codex/${ticket.id.toLowerCase()}`;
    const root = join(workRoot, repo);
    const worktree = join(root, "develop");
    const metadata = join(root, "develop-git");
    const verification = join(root, "verify");
    const verificationMetadata = join(root, "verify-git");
    const home = join(root, "git-home");
    const remote = localRemotes[repo] || `https://github.com/${REPOSITORIES[repo]}.git`;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const command = await makeGit(home, root, signal);
    const git = (args, parameters = {}) => command(args, { ...parameters, metadata, worktree });
    const verifyGit = (args) => command(args, { metadata: verificationMetadata, worktree: verification });
    await command(["clone", "--no-tags", "--single-branch", "--depth=1", "--branch", "main", "--no-local", "--separate-git-dir", metadata,
      "--", remote, worktree]);
    const base = checkedGitId(await git(["rev-parse", "refs/remotes/origin/main"]));
    await git(["switch", "--no-track", "-c", branch, base]);
    const initialGitConfig = await readGitConfig(metadata);
    // Keep the control-side Git configuration and index outside the worker checkout.
    await unlink(join(worktree, ".git"));
    const result = await invoke("develop", worktree, join(root, "develop-home"), ticket.id, {
      text: ticket.text, context: ticket.context, repository: repo, base,
      acceptance: evaluation.acceptance, estimatedMinutes: evaluation.estimatedMinutes,
    }, signal);
    const summary = shortText(result.summary, 280);
    await requireMissingGitPointer(worktree);
    if (await readGitConfig(metadata) !== initialGitConfig) throw fail("development.worker_git_metadata");
    if (checkedGitId(await git(["rev-parse", "HEAD"])) !== base) throw fail("development.worker_changed_head");
    await git(["add", "-A", "--", "."]);
    const paths = changedPaths(await git(["diff", "--cached", "--no-renames", "--raw", "-z", base]));
    const patch = await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=0", base], { maxOutput: 2 * 1024 * 1024 });
    if (patch.split("\n").some((line) => line.startsWith("+") && SECRET.test(line))) throw fail("development.sensitive_change");
    const releaseKind = decideRelease(repo, paths);
    const goWeb = await checkReleaseMetadata(git, paths, base, releaseKind);
    const selectedOta = releaseKind === "ota" ? otaPolicy(config.ota ?? options.ota) : null;
    await git(["-c", "user.name=DualLane Release Agent", "-c", "user.email=duallane-release-agent@users.noreply.github.com",
      "-c", "commit.gpgsign=false", "commit", "-m", `Implement DualLane request ${ticket.id}`]);
    const head = checkedGitId(await git(["rev-parse", "HEAD"]));
    const tree = checkedGitId(await git(["rev-parse", "HEAD^{tree}"]));
    if (checkedGitId(await git(["rev-parse", "HEAD^1"])) !== base) throw fail("development.invalid_candidate_parent");
    await command(["clone", "--no-tags", "--single-branch", "--depth=1", "--branch", branch, "--no-local", "--separate-git-dir", verificationMetadata,
      "--", metadata, verification]);
    await verifyGit(["switch", "--detach", head]);
    const initialVerifyGitConfig = await readGitConfig(verificationMetadata);
    await unlink(join(verification, ".git"));
    const check = await invoke("verify", verification, join(root, "verify-home"), ticket.id, {
      repository: repo, base, head, tree, acceptance: evaluation.acceptance, releaseKind,
    }, signal);
    await requireMissingGitPointer(verification);
    if (await readGitConfig(verificationMetadata) !== initialVerifyGitConfig || await readGitConfig(metadata) !== initialGitConfig) {
      throw fail("development.worker_git_metadata");
    }
    if (check.passed === false && ["runtime", "dependency_cache", "native_dependencies", "go_modules", "test", "lint", "build",
      "go_test", "go_build", "isolation", "timeout"].includes(check.reason)) {
      throw fail(`development.verify_${check.reason}`);
    }
    if (check.passed !== true || !Array.isArray(check.evidence) || !check.evidence.length || check.evidence.length > 6 ||
        checkedGitId(await verifyGit(["rev-parse", "HEAD"])) !== head ||
        checkedGitId(await verifyGit(["rev-parse", "HEAD^{tree}"])) !== tree ||
        (await verifyGit(["status", "--porcelain", "--untracked-files=no"])).trim()) throw fail("development.verification_failed");
    const evidence = check.evidence.map((line) => `${repo}: ${shortText(line, 230)}`);
    const ota = selectedOta ? { ...selectedOta, ...(await prepareOtaArtifact(
      join(verification, "android", "app", "src", "main", "assets", "www"), config.artifactDirectory,
    )) } : null;
    return { branch, git, remote, home, summary, evidence, goWeb, ota, native: releaseKind === "native",
      change: { repo, number: null, base, head, tree } };
  }

  return {
    async evaluate(ticket, options = {}) {
      const { id, text, context } = sourceTicket(ticket);
      const directory = await scratch(id, "evaluate");
      const result = await invoke("evaluate", directory, join(directory, "home"), id,
        { text, context, budgetMinutes }, stageSignal(options.signal));
      return normalizeEvaluation(result, budgetMinutes);
    },
    async develop(original, unverifiedEvaluation, options = {}) {
      const ticket = sourceTicket(original);
      const evaluation = normalizeEvaluation(unverifiedEvaluation, budgetMinutes);
      if (evaluation.decision !== "accept") throw fail("development.ticket_not_accepted");
      const signal = stageSignal(options.signal);
      const workRoot = await scratch(ticket.id, "work");
      const builds = [];
      // Verify every affected repository before writing the first GitHub draft.
      for (const repo of evaluation.repositories) builds.push(await developRepository(ticket, evaluation, repo, workRoot, { ...options, signal }));
      const native = builds.some((build) => build.native);
      if (allowDraftPush && !native) {
        for (const build of builds) build.change.number = await openDraft(
          build.change, build.branch, build.git, build.remote, build.home, ticket.id, signal,
        );
      }
      return { summary: builds.map((build) => build.summary).join("\n"), changes: builds.map((build) => build.change),
        goWeb: builds.find((build) => build.goWeb)?.goWeb || null, ota: builds.find((build) => build.ota)?.ota || null,
        native, evidence: builds.flatMap((build) => build.evidence) };
    },
  };
}
