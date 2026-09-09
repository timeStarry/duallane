import assert from "node:assert/strict";
import test from "node:test";

import {
  PROBE_MAX_BYTES,
  MAX_DOCKER_ARGUMENT_BYTES,
  MAX_DOCKER_ENV_VALUE_BYTES,
  DATA_MOUNT_ROOT,
  PROBE_DATA_ROOT,
  INIT_SCRIPT,
  buildSyntheticCases,
  buildFixtureInitEnvironment,
  buildVolumeMountArgument,
  parseOptions,
  validateDockerArgumentBudget,
  validateContainerInspection,
  summarizeSyntheticOutput,
  assertCleanupComplete,
  cleanupDockerResources,
  runRuntimePermissions
} from "./runtime-permissions.mjs";

test("runtime permission rehearsal requires explicit Docker opt-in and image", () => {
  assert.throws(() => parseOptions([], {}), /docker_opt_in_required/);
  assert.throws(() => parseOptions(["--docker"], {}), /explicit_image_required/);
  assert.throws(() => parseOptions(["--docker", "--image", "bad image"], {}), /explicit_image_required/);
  assert.throws(() => parseOptions(["--docker", "--image", "candidate:synthetic"], {}), /explicit_init_image_required/);
  assert.deepEqual(parseOptions([
    "--docker", "--image", "duallane-go-workspace:synthetic",
    "--init-image", "docker.m.daocloud.io/library/postgres:17-alpine"
  ], {}), {
    docker: true,
    image: "duallane-go-workspace:synthetic",
    initImage: "docker.m.daocloud.io/library/postgres:17-alpine",
    dockerBinary: "docker",
    trace: false
  });
});

test("synthetic matrix covers ownership, secret, 2 MiB boundary, and symlinks", () => {
  const cases = buildSyntheticCases();
  assert.deepEqual(cases.map((fixture) => fixture.id), [
    "root-data-denied",
    "owned-positive",
    "root-secret-denied",
    "max-bytes-accepted",
    "over-max-rejected",
    "symlinks-rejected"
  ]);
  assert.equal(cases.find((fixture) => fixture.id === "max-bytes-accepted").dataBytes, PROBE_MAX_BYTES);
  assert.equal(cases.find((fixture) => fixture.id === "over-max-rejected").dataBytes, PROBE_MAX_BYTES + 1);
  assert.equal(cases.find((fixture) => fixture.id === "owned-positive").manifest.secret.path, "/run/secrets/workspace-s3");
});

test("large boundary fixtures never enter Docker environment arguments", () => {
  for (const fixture of buildSyntheticCases().filter((candidate) => candidate.dataMode === "boundary" || candidate.dataMode === "oversize")) {
    const environment = buildFixtureInitEnvironment(fixture);
    assert.equal(environment.CANONICAL_B64, undefined);
    assert.equal(environment.LEGACY_B64, undefined);
    assert.ok(Number(environment.DATA_BYTES) >= PROBE_MAX_BYTES);
  }
  assert.throws(() => validateDockerArgumentBudget(["--env", `BIG=${"x".repeat(MAX_DOCKER_ENV_VALUE_BYTES + 1)}`]), /docker_env_argument_too_large/);
  assert.throws(() => validateDockerArgumentBudget(["x".repeat(MAX_DOCKER_ARGUMENT_BYTES + 1)]), /docker_arguments_too_large/);
});

test("synthetic blob fixtures use Node workspace-files below the mounted data root", () => {
  assert.equal(DATA_MOUNT_ROOT, "/app/data");
  assert.equal(PROBE_DATA_ROOT, "/app/data/workspace-files");
  const cases = buildSyntheticCases();
  for (const fixture of cases) {
    assert.ok(fixture.manifest.canonical.key.startsWith("workspace/objects/sha256/"));
    assert.ok(fixture.manifest.legacy.key.startsWith("workspace/"));
  }
  assert.equal(cases.find((fixture) => fixture.id === "root-data-denied").dataOwner, "root");
});

test("synthetic init resets image-layer ownership for data and secret fixtures", () => {
  assert.ok(INIT_SCRIPT.includes("chown -R 0:0 /app/data"));
  assert.ok(INIT_SCRIPT.includes("chown -R 65532:65532 /app/data"));
  assert.ok(INIT_SCRIPT.includes("chown 0:0 /run/secrets/workspace-s3"));
  assert.ok(INIT_SCRIPT.includes("chown 65532:65532 /run/secrets/workspace-s3"));
});

test("synthetic volume mounts disable image copy-up", () => {
  assert.equal(buildVolumeMountArgument({
    volume: "fixture-data",
    destination: DATA_MOUNT_ROOT,
    rw: true
  }), "type=volume,source=fixture-data,target=/app/data,volume-nocopy");
  assert.equal(buildVolumeMountArgument({
    volume: "fixture-secret",
    destination: "/run/secrets",
    rw: false
  }), "type=volume,source=fixture-secret,target=/run/secrets,volume-nocopy,readonly");
});

test("init failure diagnostics are status-only and never echo container output", () => {
  const sensitive = "SECRET_B64=super-secret CANONICAL_B64=YWJj\nprivate fixture bytes";
  assert.equal(summarizeSyntheticOutput({ status: 1, stderr: sensitive, stdout: sensitive }), "exit_one");
  assert.equal(summarizeSyntheticOutput({ status: 125, stderr: sensitive, stdout: sensitive }), "exit_nonzero");
});

test("container proof requires owned labels, nonroot user, read-only rootfs and loopback-only ports", () => {
  const details = {
    Config: {
      User: "65532:65532",
      Labels: {
        "com.timestarry.duallane.owner": "runtime-permissions",
        "com.timestarry.duallane.runtime-permissions-run": "run-1",
        "com.timestarry.duallane.synthetic": "true"
      }
    },
    HostConfig: { ReadonlyRootfs: true, NetworkMode: "none" },
    Mounts: [
      { Destination: "/app/data", RW: false },
      { Destination: "/run/permission-probe", RW: false },
      { Destination: "/run/secrets", RW: false },
      { Destination: "/dev/shm", RW: true, Type: "tmpfs" }
    ],
    NetworkSettings: { Ports: { "8787/tcp": [{ HostIp: "127.0.0.1" }] } }
  };
  assert.equal(validateContainerInspection(details, {
    runId: "run-1",
    user: "65532:65532",
    mounts: [
      { destination: "/app/data", rw: false },
      { destination: "/run/permission-probe", rw: false },
      { destination: "/run/secrets", rw: false }
    ]
  }), true);
  assert.throws(() => validateContainerInspection({ ...details, HostConfig: { ...details.HostConfig, ReadonlyRootfs: false } }, {
    runId: "run-1", user: "65532:65532", mounts: []
  }), /container_rootfs_not_readonly/);
  assert.throws(() => validateContainerInspection({ ...details, NetworkSettings: { Ports: { "8787/tcp": [{ HostIp: "0.0.0.0" }] } } }, {
    runId: "run-1", user: "65532:65532", mounts: []
  }), /container_non_loopback_publish/);
  for (const [imageRole, imageUser, expectedDataRW] of [["candidate-probe", "65532:65532", false], ["init-helper", "0:0", true]]) {
    const roleMounts = [
      { Destination: "/app/data", RW: expectedDataRW },
      { Destination: "/run/permission-probe", RW: expectedDataRW },
      { Destination: "/run/secrets", RW: expectedDataRW },
      { Destination: "/dev/shm", RW: true, Type: "tmpfs" },
      { Destination: `/unexpected-${imageRole}`, RW: true, Type: "volume" }
    ];
    assert.throws(() => validateContainerInspection({ ...details, Config: { ...details.Config, User: imageUser }, Mounts: roleMounts }, {
      runId: "run-1", user: imageUser,
      mounts: roleMounts.slice(0, 3).map((mount) => ({ destination: mount.Destination, rw: mount.RW }))
    }), /container_unexpected_rw_mount/);
  }
});

function fakeDocker(responder) {
  const calls = [];
  const runner = (binary, args, stage, timeoutMs, allowedStatuses) => {
    calls.push({ binary, args: [...args], stage, timeoutMs, allowedStatuses: [...allowedStatuses] });
    return responder({ args, stage, timeoutMs, allowedStatuses });
  };
  return { calls, runner };
}

function dockerResult(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function ownedLabels(runId = "run-1", overrides = {}) {
  return {
    "com.timestarry.duallane.owner": "runtime-permissions",
    "com.timestarry.duallane.runtime-permissions-run": runId,
    "com.timestarry.duallane.synthetic": "true",
    ...overrides
  };
}

function inspectedVolume(runId = "run-1", overrides = {}) {
  return JSON.stringify([{ Labels: ownedLabels(runId, overrides) }]);
}

function inspectedContainer(runId = "run-1", overrides = {}) {
  return JSON.stringify([{ Config: { Labels: ownedLabels(runId, overrides) } }]);
}

test("cleanup re-inspects exact volume ownership before removing it", () => {
  const fake = fakeDocker(({ args }) => {
    if (args[0] === "ps") return dockerResult(0, "");
    if (args[0] === "volume" && args[1] === "inspect") return dockerResult(0, inspectedVolume());
    if (args[0] === "volume" && args[1] === "rm") return dockerResult(0, "fixture-volume\n");
    assert.fail(`unexpected Docker call: ${args.join(" ")}`);
  });

  const cleanup = cleanupDockerResources("fake-docker", "run-1", {
    containers: [],
    volumes: ["fixture-volume"]
  }, fake.runner);

  assert.equal(cleanup.status, "passed");
  assert.deepEqual(fake.calls.filter((call) => call.args[0] === "volume").map((call) => call.args), [
    ["volume", "inspect", "fixture-volume"],
    ["volume", "rm", "fixture-volume"]
  ]);
  assert.deepEqual(fake.calls.find((call) => call.args[0] === "volume" && call.args[1] === "rm").allowedStatuses, [0]);
});

test("cleanup refuses a volume with mismatched ownership labels and reports incomplete", () => {
  const fake = fakeDocker(({ args }) => {
    if (args[0] === "ps") return dockerResult(0, "");
    if (args[0] === "volume" && args[1] === "inspect") {
      return dockerResult(0, inspectedVolume("other-run"));
    }
    if (args[0] === "volume" && args[1] === "rm") assert.fail("mismatched volume must not be removed");
    assert.fail(`unexpected Docker call: ${args.join(" ")}`);
  });

  const cleanup = cleanupDockerResources("fake-docker", "run-1", {
    containers: [],
    volumes: ["foreign-volume"]
  }, fake.runner);

  assert.equal(cleanup.status, "incomplete");
  assert.ok(cleanup.failures.includes("cleanup_volume_label_mismatch"));
  assert.equal(cleanup.volumes.removed, 0);
  assert.throws(() => assertCleanupComplete(cleanup), /cleanup_incomplete:cleanup_volume_label_mismatch/);
});

test("cleanup fails closed for unknown or malformed volume inspection", () => {
  for (const inspection of [
    dockerResult(1, "", "daemon unavailable"),
    dockerResult(0, "not-json")
  ]) {
    const fake = fakeDocker(({ args }) => {
      if (args[0] === "ps") return dockerResult(0, "");
      if (args[0] === "volume" && args[1] === "inspect") return inspection;
      if (args[0] === "volume" && args[1] === "rm") assert.fail("unproven volume must not be removed");
      assert.fail(`unexpected Docker call: ${args.join(" ")}`);
    });

    const cleanup = cleanupDockerResources("fake-docker", "run-1", {
      containers: [],
      volumes: ["unproven-volume"]
    }, fake.runner);

    assert.equal(cleanup.status, "incomplete");
    assert.ok(cleanup.failures.some((failure) => failure.startsWith("cleanup_volume_inspect:")));
  }
});

test("cleanup treats only a known-missing volume as already absent", () => {
  const fake = fakeDocker(({ args }) => {
    if (args[0] === "ps") return dockerResult(0, "");
    if (args[0] === "volume" && args[1] === "inspect") {
      return dockerResult(1, "", "Error response from daemon: get fixture-volume: no such volume");
    }
    if (args[0] === "volume" && args[1] === "rm") assert.fail("already absent volume must not be removed");
    assert.fail(`unexpected Docker call: ${args.join(" ")}`);
  });

  const cleanup = cleanupDockerResources("fake-docker", "run-1", {
    containers: [],
    volumes: ["fixture-volume"]
  }, fake.runner);

  assert.equal(cleanup.status, "passed");
  assert.equal(cleanup.volumes.alreadyAbsent, 1);
  assert.equal(cleanup.failures.length, 0);
});

test("cleanup reports a volume removal failure instead of passing", () => {
  const fake = fakeDocker(({ args }) => {
    if (args[0] === "ps") return dockerResult(0, "");
    if (args[0] === "volume" && args[1] === "inspect") return dockerResult(0, inspectedVolume());
    if (args[0] === "volume" && args[1] === "rm") return dockerResult(1, "", "volume is in use");
    assert.fail(`unexpected Docker call: ${args.join(" ")}`);
  });

  const cleanup = cleanupDockerResources("fake-docker", "run-1", {
    containers: [],
    volumes: ["fixture-volume"]
  }, fake.runner);

  assert.equal(cleanup.status, "incomplete");
  assert.ok(cleanup.failures.includes("cleanup_volume_remove:failed"));
  assert.throws(() => assertCleanupComplete(cleanup), /cleanup_incomplete:cleanup_volume_remove:failed/);
});

test("cleanup distinguishes --rm natural container disappearance from removal failure", () => {
  const naturallyGone = fakeDocker(({ args }) => {
    if (args[0] === "ps") return dockerResult(0, "");
    if (args[0] === "inspect") return dockerResult(1, "", "Error: No such object: container-id");
    assert.fail(`unexpected Docker call: ${args.join(" ")}`);
  });
  const absentCleanup = cleanupDockerResources("fake-docker", "run-1", {
    containers: ["container-id"],
    volumes: []
  }, naturallyGone.runner);
  assert.equal(absentCleanup.status, "passed");
  assert.equal(absentCleanup.containers.alreadyAbsent, 1);

  const removalFailed = fakeDocker(({ args }) => {
    if (args[0] === "ps") return dockerResult(0, "");
    if (args[0] === "inspect") return dockerResult(0, inspectedContainer());
    if (args[0] === "rm") return dockerResult(1, "", "permission denied");
    assert.fail(`unexpected Docker call: ${args.join(" ")}`);
  });
  const failedCleanup = cleanupDockerResources("fake-docker", "run-1", {
    containers: ["container-id"],
    volumes: []
  }, removalFailed.runner);
  assert.equal(failedCleanup.status, "incomplete");
  assert.ok(failedCleanup.failures.includes("cleanup_container_remove:failed"));
});

const dockerOptIn = process.env.RUNTIME_PERMISSIONS_DOCKER === "1" &&
  Boolean(process.env.RUNTIME_PERMISSIONS_IMAGE) && Boolean(process.env.RUNTIME_PERMISSIONS_INIT_IMAGE);

test("Docker rehearsal validates the actual candidate probe", { timeout: 180_000, skip: !dockerOptIn }, () => {
  const report = runRuntimePermissions({
    image: process.env.RUNTIME_PERMISSIONS_IMAGE,
    initImage: process.env.RUNTIME_PERMISSIONS_INIT_IMAGE,
    dockerBinary: process.env.RUNTIME_PERMISSIONS_DOCKER_BIN || "docker"
  });
  assert.equal(report.status, "passed");
  assert.equal(report.summary.failed, 0);
  assert.ok(report.cases.length >= 6);
});
