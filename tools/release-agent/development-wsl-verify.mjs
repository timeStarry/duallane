import { spawn } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";

// The verification commands and environment are operator-owned. The candidate
// receives a disposable home and caches; repository scripts run only in bwrap.
const VERIFY = String.raw`
set -eu
run_check() {
  local failure=$1
  shift
  "$@" </dev/null >/dev/null 2>&1 || exit "$failure"
}
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 22 ]] || exit 20
[[ "$(pnpm --version)" == 10.30.3 ]] || exit 20
[[ ! -e /mnt && ! -e /run && ! -e /root/.ssh ]] || exit 28
while IFS=: read -r interface counters; do
  [[ -z "$counters" || "$interface" =~ ^[[:space:]]*lo$ ]] || exit 28
done < /proc/net/dev
mkdir /tmp/pnpm-store /tmp/go-build /tmp/go-home
run_check 21 cp -R /cache/pnpm/. /tmp/pnpm-store/
run_check 21 pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir /tmp/pnpm-store --package-import-method copy
case "$1" in
  main)
    [[ "$(go env GOVERSION)" == go1.26.11 ]] || exit 20
    run_check 30 pkg-config --exists vips
    run_check 22 go -C apps/backend mod verify
    run_check 23 pnpm test
    run_check 24 pnpm lint
    run_check 25 pnpm build
    run_check 26 go -C apps/backend test ./...
    run_check 27 go -C apps/backend build ./cmd/...
    ;;
  mobile)
    run_check 23 pnpm check
    run_check 25 pnpm build:web
    ;;
  *) exit 20 ;;
esac
`;

const FAILURES = new Map([
  [20, "runtime"], [21, "dependency_cache"], [22, "go_modules"], [23, "test"],
  [24, "lint"], [25, "build"], [26, "go_test"], [27, "go_build"], [28, "isolation"], [29, "timeout"],
  [30, "native_dependencies"],
]);
const EVIDENCE = {
  main: ["pnpm test, lint and build passed in the isolated candidate", "Pinned Go modules verified, Go tests and command builds passed"],
  mobile: ["pnpm check and build:web passed in the isolated candidate"],
};

function contains(parent, child) {
  const route = relative(parent, child);
  return route === "" || (route !== ".." && !route.startsWith("../") && !isAbsolute(route));
}

async function operatorDirectory(config, key, checkout, requiredPath) {
  const value = config[key];
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("verify_config");
  const absolute = await realpath(value);
  if (absolute === "/" || contains(absolute, checkout) || contains(checkout, absolute) ||
      !(await lstat(absolute)).isDirectory()) {
    throw new Error("verify_config");
  }
  await stat(join(absolute, requiredPath));
  return absolute;
}

async function verify(input, configPath) {
  if (process.platform !== "linux" || input?.protocol !== "duallane.release-agent.verify" || input.version !== 1 ||
      !Object.hasOwn(EVIDENCE, input.repository) || ![input.base, input.head, input.tree].every(
        (id) => typeof id === "string" && /^[a-f0-9]{40}$/.test(id))) throw new Error("verify_input");

  const checkout = await realpath(process.cwd());
  if (basename(checkout) !== "verify" || !(await lstat(join(checkout, "package.json"))).isFile() ||
      !isAbsolute(configPath || "")) throw new Error("verify_checkout");
  const authority = await realpath(configPath);
  const configFile = await lstat(authority);
  if (contains(checkout, authority) || !configFile.isFile() || configFile.size > 4096) throw new Error("verify_config");
  const config = JSON.parse(await readFile(authority, "utf8"));
  const timeoutMs = config.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) throw new Error("verify_config");
  const [node, pnpm, go, pnpmStore, goModules] = await Promise.all([
    operatorDirectory(config, "nodeDirectory", checkout, "bin/node"),
    operatorDirectory(config, "pnpmDirectory", checkout, "node_modules/pnpm/bin/pnpm.cjs"),
    operatorDirectory(config, "goDirectory", checkout, "bin/go"),
    operatorDirectory(config, "pnpmStoreDirectory", checkout, "v10/index"),
    operatorDirectory(config, "goModuleCache", checkout, "cache/download"),
  ]);
  const args = [
    "--unshare-all", "--unshare-user", "--disable-userns", "--cap-drop", "ALL", "--die-with-parent", "--new-session", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64", "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind-try", "/etc/alternatives/hdf5.pc", "/etc/alternatives/hdf5.pc",
    "--file", "3", "/etc/hosts", "--file", "4", "/etc/nsswitch.conf",
    "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", "/home", "--dir", "/home/verify",
    "--ro-bind", node, "/tools/node", "--ro-bind", pnpm, "/tools/pnpm", "--ro-bind", go, "/tools/go",
    "--ro-bind", pnpmStore, "/cache/pnpm", "--ro-bind", goModules, "/cache/go-mod", "--bind", checkout, "/checkout",
    "--chdir", "/checkout", "--setenv", "PATH", "/tools/node/bin:/tools/pnpm/node_modules/.bin:/tools/go/bin:/usr/bin",
    "--setenv", "HOME", "/home/verify", "--setenv", "TMPDIR", "/tmp", "--setenv", "CI", "true",
    "--setenv", "npm_config_manage_package_manager_versions", "false", "--setenv", "npm_config_update_notifier", "false",
    "--setenv", "GOMODCACHE", "/cache/go-mod", "--setenv", "GOCACHE", "/tmp/go-build", "--setenv", "GOPATH", "/tmp/go-home",
    "--setenv", "GOTOOLCHAIN", "local", "--setenv", "GOPROXY", "off", "--setenv", "GOWORK", "off",
    "--setenv", "GOFLAGS", "-mod=readonly", "--setenv", "GOMAXPROCS", "4", "--setenv", "CGO_ENABLED", "1", "--setenv", "CC", "gcc",
    "--", "/usr/bin/bash", "--noprofile", "--norc", "-c", VERIFY, "duallane-verify", input.repository,
  ];
  const exit = await new Promise((resolve) => {
    const child = spawn("/usr/bin/bwrap", args, { cwd: "/", env: {}, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    child.stdio[3].on("error", () => {});
    child.stdio[4].on("error", () => {});
    child.stdio[3].end("127.0.0.1 localhost\n::1 localhost\n");
    child.stdio[4].end("hosts: files\n");
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (code) => {
      clearTimeout(timer);
      resolve(timedOut ? 29 : code);
    };
    child.once("error", () => finish(undefined));
    child.once("close", finish);
  });
  if (exit !== 0) return { passed: false, reason: FAILURES.get(exit) || "isolation" };
  return { passed: true, evidence: EVIDENCE[input.repository] };
}

try {
  const chunks = [];
  let size = 0;
  for await (const bytes of process.stdin) {
    size += bytes.length;
    if (size > 16_384) throw new Error("verify_input");
    chunks.push(bytes);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(`${JSON.stringify(await verify(input, process.argv[2]))}\n`);
} catch {
  process.stdout.write(`${JSON.stringify({ passed: false, reason: "runtime" })}\n`);
}
