import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const IMAGE = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[0-9a-f]{64}$/u;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u;
const LABEL = "com.duallane.permission-probe";

// This is an explicit offline operator canary, not candidate health behavior.
// Its only writes are fixed files inside a fresh private temporary directory.
export const CANARY = `set -eu
umask 077
test "$(id -u):$(id -g)" = 65532:65532
test -d /app/data/workspace-files
if [ "$1" = secret ]; then
  test "$(stat -c '%u:%g:%a' /run/secrets/workspace-s3)" = 65532:65532:600
  exec 3< /run/secrets/workspace-s3
fi
d="$(mktemp -d /app/data/workspace-files/.duallane-permission-probe.XXXXXXXX)"
case "$d" in /app/data/workspace-files/.duallane-permission-probe.*) ;; *) exit 1 ;; esac
trap 'rm -f -- "$d/first" "$d/second"; rmdir -- "$d"' EXIT
printf '%s' synthetic > "$d/first"
test "$(stat -c '%u:%g:%a' "$d/first")" = 65532:65532:600
mv -- "$d/first" "$d/second"
test "$(cat -- "$d/second")" = synthetic
rm -- "$d/second"
rmdir -- "$d"
trap - EXIT
`;

function fail(code) { throw Object.assign(new Error(code), { safeCode: code }); }

function defaultRunner(args) {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8", timeout: 20_000, maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch { fail("docker_operation_failed"); }
}

function inspect(runner, kind, value) {
  let result;
  try { result = JSON.parse(runner([kind, "inspect", value])); }
  catch { fail("inspect_failed"); }
  if (!Array.isArray(result) || result.length !== 1) fail("inspect_invalid");
  return result[0];
}

export function runProbe({ volume, image, secret }, runner = defaultRunner) {
  if (!NAME.test(volume ?? "") || !IMAGE.test(image ?? "") ||
      (secret !== "-" && (typeof secret !== "string" || !secret.startsWith("/") || /[\x00-\x1f\x7f,]/u.test(secret)))) fail("invalid_arguments");
  const source = inspect(runner, "volume", volume);
  if (source.Name !== volume || source.Driver !== "local" || !source.Mountpoint) fail("volume_invalid");
  if (inspect(runner, "image", image).Id !== image) fail("image_invalid");
  // Do not introduce a second writer, including an existing bind-mount writer.
  const ids = runner(["ps", "--no-trunc", "-q"]).split(/\s+/u).filter(Boolean);
  for (const id of ids) {
    if (!ID.test(id)) fail("container_identity_invalid");
    const c = inspect(runner, "container", id);
    if (!Array.isArray(c.Mounts)) fail("container_mounts_invalid");
    if (c.Mounts.some(m => m.RW && (m.Name === volume || (typeof m.Source === "string" &&
      (m.Source === source.Mountpoint || source.Mountpoint.startsWith(m.Source.replace(/\/$/u, "") + "/") || m.Source.startsWith(source.Mountpoint + "/")))))) fail("writer_not_fenced");
  }
  const run = randomUUID();
  const args = ["create", "--name", `duallane-permission-probe-${run}`, "--label", `${LABEL}=${run}`,
    "--network", "none", "--read-only", "--user", "65532:65532", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "32", "--memory", "64m",
    "--restart", "no", "--mount", `type=volume,source=${volume},target=/app/data,volume-nocopy`];
  if (secret !== "-") args.push("--mount", `type=bind,source=${secret},target=/run/secrets/workspace-s3,readonly`);
  args.push("--entrypoint", "/bin/sh", image, "-c", CANARY, "permission-probe", secret === "-" ? "local" : "secret");
  const id = runner(args);
  if (!ID.test(id)) fail("created_identity_invalid");
  const owned = () => {
    const c = inspect(runner, "container", id);
    if (c.Id !== id || c.Image !== image || c.Config?.Labels?.[LABEL] !== run) fail("probe_ownership_changed");
    return c;
  };
  let failure;
  try {
    const c = owned();
    const mounts = c.Mounts ?? [];
    const data = mounts.filter(m => m.Destination === "/app/data");
    const credentials = mounts.filter(m => m.Destination === "/run/secrets/workspace-s3");
    if (c.State?.Running !== false || c.Config.User !== "65532:65532" ||
        c.HostConfig?.NetworkMode !== "none" || c.HostConfig.ReadonlyRootfs !== true ||
        c.HostConfig.RestartPolicy?.Name !== "no" ||
        !c.HostConfig.CapDrop?.some(cap => cap.toUpperCase() === "ALL") ||
        !c.HostConfig.SecurityOpt?.includes("no-new-privileges") ||
        c.HostConfig.PidsLimit !== 32 || c.HostConfig.Memory !== 64 * 1024 * 1024 ||
        mounts.length !== (secret === "-" ? 1 : 2) || data.length !== 1 ||
        data[0].Type !== "volume" || data[0].Name !== volume || data[0].RW !== true ||
        (secret !== "-" && (credentials.length !== 1 || credentials[0].Type !== "bind" || credentials[0].Source !== secret || credentials[0].RW !== false))) fail("probe_policy_invalid");
    runner(["start", "--attach", id]);
    const after = owned();
    if (after.State?.Running !== false || after.State.ExitCode !== 0) fail("probe_failed");
  } catch (error) { failure = error; }
  try {
    let c = owned();
    if (c.State?.Running) {
      runner(["stop", "--time", "5", id]);
      c = owned();
    }
    if (c.State?.Running !== false || c.HostConfig?.RestartPolicy?.Name !== "no") fail("probe_cleanup_unsafe");
    runner(["rm", id]);
  } catch { fail("probe_cleanup_failed"); }
  if (failure) throw failure;
  return { status: "PASS", uid: 65532, gid: 65532, syntheticWrite: "verified", cleanup: "completed" };
}

function main(args) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) fail("linux_root_required");
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!["--volume", "--image", "--secret"].includes(key) || values[key] || !args[i + 1]) fail("invalid_arguments");
    values[key] = args[i + 1];
  }
  return runProbe({ volume: values["--volume"], image: values["--image"], secret: values["--secret"] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + "\n"); }
  catch (error) {
    process.stderr.write(JSON.stringify({ status: "FAIL", code: error.safeCode ?? "permission_probe_failed" }) + "\n");
    process.exitCode = 1;
  }
}
