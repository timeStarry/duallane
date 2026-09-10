import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  compareSchemaCompatibility,
  compareSchemaInventories,
  CONTAINER_MEMORY_BYTES,
  CONTAINER_PIDS_LIMIT,
  createDockerRunner,
  MAX_DOCKER_OUTPUT_BYTES,
  REVIEWED_BASE_MIGRATION,
  REVIEWED_COMPATIBLE_MIGRATION,
  REVIEWED_COMPATIBLE_MIGRATION_SHA256,
  SCHEMA_COMPATIBILITY_LABEL,
  SCHEMA_COMPATIBILITY_USER,
  SCHEMA_INSPECTION_SCRIPT,
  SchemaCompatibilityError,
  verifySchemaCompatibility,
} from "../../deploy/production/release-schema-compatibility.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const helper = path.join(root, "deploy/production/release-schema-compatibility.mjs");
const previousImage = `sha256:${"a".repeat(64)}`;
const targetImage = `sha256:${"b".repeat(64)}`;

function hash(letter) {
  return letter.repeat(64);
}

function migration(number, name, digest = hash(String.fromCharCode(96 + number))) {
  return {
    name: `${String(number).padStart(3, "0")}_${name}.sql`,
    sha256: digest,
  };
}

function policy(baseMigration, compatibleMigrations) {
  return {
    version: 1,
    baseMigration,
    compatibleMigrations,
  };
}

function inventory(migrations, compatibilityPolicy = null) {
  return { migrations, policy: compatibilityPolicy };
}

function reviewedPolicy() {
  return policy(
    REVIEWED_BASE_MIGRATION,
    [{ name: REVIEWED_COMPATIBLE_MIGRATION, sha256: REVIEWED_COMPATIBLE_MIGRATION_SHA256 }],
  );
}

function reviewedMigrations(includeCompatible = false, compatibleHash = REVIEWED_COMPATIBLE_MIGRATION_SHA256) {
  const result = Array.from({ length: 32 }, (_, index) =>
    migration(index + 1, `step${index + 1}`, hash("a")),
  );
  result.push({ name: REVIEWED_BASE_MIGRATION, sha256: hash("b") });
  if (includeCompatible) {
    result.push({ name: REVIEWED_COMPATIBLE_MIGRATION, sha256: compatibleHash });
  }
  return result;
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error instanceof SchemaCompatibilityError && error.code === code);
}

function expectAsyncCode(callback, code) {
  return assert.rejects(callback, (error) => error instanceof SchemaCompatibilityError && error.code === code);
}

function reportFor(value) {
  const lines = ["DLSCHEMA\t1"];
  for (const item of value.migrations) {
    lines.push(`M\t${item.name}\t${item.sha256}`);
  }
  lines.push(`C\t${value.migrations.length}`);
  if (value.policy === null || value.policy === undefined) {
    lines.push("N");
    return Buffer.from(`${lines.join("\n")}\n`, "utf8");
  }
  const text = JSON.stringify(value.policy);
  lines.push(`P\t${Buffer.byteLength(text, "utf8")}`);
  return Buffer.from(`${lines.join("\n")}\n${text}\nP_END\n`, "utf8");
}

function validContainer(id, image, runID, state = { Running: false, Status: "created", ExitCode: 0 }) {
  return {
    Id: id,
    Image: image,
    Path: "/bin/sh",
    Args: ["-c", SCHEMA_INSPECTION_SCRIPT],
    Config: {
      Image: image,
      User: SCHEMA_COMPATIBILITY_USER,
      Labels: { [SCHEMA_COMPATIBILITY_LABEL]: runID },
      Entrypoint: ["/bin/sh"],
      Cmd: ["-c", SCHEMA_INSPECTION_SCRIPT],
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "DUALLANE_MIGRATIONS_DIR=/app/migrations",
        "DUALLANE_EMOTE_CATALOG_PATH=/app/assets/emote-packs.json",
        "DUALLANE_ECHO_RELEASE_CATALOG_PATH=/app/assets/echo-release-guides.json",
      ],
      Volumes: null,
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges:true"],
      NetworkMode: "none",
      RestartPolicy: { Name: "no" },
      AutoRemove: false,
      Memory: CONTAINER_MEMORY_BYTES,
      MemorySwap: CONTAINER_MEMORY_BYTES,
      PidsLimit: CONTAINER_PIDS_LIMIT,
      Binds: null,
      Tmpfs: null,
      PortBindings: {},
    },
    Mounts: [],
    NetworkSettings: {
      Networks: {
        none: {
          NetworkID: "f".repeat(64),
          EndpointID: "",
          IPAddress: "",
          GlobalIPv6Address: "",
          Gateway: "",
          IPv6Gateway: "",
          MacAddress: "",
        },
      },
      Ports: {},
    },
    State: state,
  };
}

function fakeDocker(inventories, { mode = "valid" } = {}) {
  const calls = [];
  const containers = new Map();
  const imagesByContainer = new Map();
  let nextID = 0;
  const runIDs = new Map();
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === "image" && args[1] === "inspect") {
      return { status: 0, stdout: `${args.at(-1)}\n` };
    }
    if (args[0] === "create") {
      const image = args[args.indexOf("/bin/sh") + 1];
      const label = args[args.indexOf("--label") + 1];
      const runID = label.slice(label.indexOf("=") + 1);
      const id = `${String.fromCharCode(99 + nextID)}${"0".repeat(63)}`;
      nextID += 1;
      runIDs.set(id, runID);
      imagesByContainer.set(id, image);
      const container = validContainer(id, image, runID);
      if (mode === "foreign-cleanup" && nextID === 1) {
        container.Config.Labels[SCHEMA_COMPATIBILITY_LABEL] = "d".repeat(64);
      }
      containers.set(id, container);
      if (mode === "create-response-timeout" || mode === "create-response-timeout-unconfirmed") {
        throw new SchemaCompatibilityError("docker_timeout");
      }
      if (mode === "create-response-corrupt") {
        return { status: 0, stdout: "not-a-container-id\n" };
      }
      return { status: 0, stdout: `${id}\n` };
    }
    if (args[0] === "ps") {
      if (mode === "create-response-timeout-unconfirmed") return { status: 0, stdout: "" };
      const filter = args[args.indexOf("--filter") + 1];
      const label = filter.slice("label=".length);
      const ids = [...containers.entries()]
        .filter(([, container]) => container.Config.Labels[SCHEMA_COMPATIBILITY_LABEL] === label.split("=")[1])
        .map(([id]) => id);
      return { status: 0, stdout: ids.length === 0 ? "" : `${ids.join("\n")}\n` };
    }
    if (args[0] === "inspect") {
      const container = containers.get(args.at(-1));
      if (!container) return { status: 1, stdout: "", stderr: "secret daemon output" };
      return { status: 0, stdout: JSON.stringify([container]) };
    }
    if (args[0] === "start") {
      const id = args.at(-1);
      const value = inventories.get(imagesByContainer.get(id));
      if (mode === "inspection-failure" && imagesByContainer.get(id) === previousImage) {
        return { status: 1, stdout: "", stderr: "untrusted image output" };
      }
      if (mode === "malicious-output" && imagesByContainer.get(id) === previousImage) {
        return { status: 0, stdout: Buffer.from("DLSCHEMA\t1\nM\tSELECT secret\t" + hash("f") + "\nC\t1\nN\n", "utf8") };
      }
      if (mode === "duplicate-policy" && imagesByContainer.get(id) === previousImage) {
        const text = `{"version":1,"baseMigration":"003_third.sql","baseMigration":"003_third.sql","compatibleMigrations":[]}`;
        const lines = ["DLSCHEMA\t1", ...value.migrations.map((item) => `M\t${item.name}\t${item.sha256}`), `C\t${value.migrations.length}`, `P\t${Buffer.byteLength(text, "utf8")}`];
        return { status: 0, stdout: Buffer.from(`${lines.join("\n")}\n${text}\nP_END\n`, "utf8") };
      }
      return { status: 0, stdout: reportFor(value) };
    }
    if (args[0] === "rm") {
      const id = args.at(-1);
      containers.delete(id);
      return { status: 0, stdout: `${id}\n` };
    }
    throw new Error(`unexpected fake Docker command: ${args.join(" ")}`);
  };
  return { calls, containers, runIDs, runner };
}

function threeMigrationInventory() {
  return inventory([
    migration(1, "first"),
    migration(2, "second"),
    migration(3, "third"),
  ]);
}

test("compareSchemaInventories rejects modified common SQL bytes", () => {
  const previous = threeMigrationInventory();
  const target = structuredClone(previous);
  target.migrations[1].sha256 = hash("f");
  expectCode(() => compareSchemaInventories(previous, target), "common_migration_hash_mismatch");
});

test("the reviewed 033-to-034 expansion is accepted only with its exact prior policy", () => {
  const previous = inventory(reviewedMigrations(), reviewedPolicy());
  const target = inventory(reviewedMigrations(true), reviewedPolicy());
  const result = compareSchemaInventories(previous, target);
  assert.equal(result.status, "compatible");
  assert.equal(result.commonMigrationCount, 33);
  assert.equal(result.addedMigrationCount, 1);
  assert.equal(result.policyUsed, true);
  const altered = structuredClone(target);
  altered.migrations[33].sha256 = hash("f");
  assert.throws(() => compareSchemaInventories(previous, altered), SchemaCompatibilityError);
});

test("compareSchemaInventories rejects an unknown added migration", () => {
  const previous = inventory(reviewedMigrations());
  const target = inventory([...previous.migrations, { name: "034_unreviewed.sql", sha256: hash("d") }]);
  expectCode(() => compareSchemaInventories(previous, target), "previous_policy_missing");

  const targetWithUnknown = inventory(target.migrations);
  expectCode(
    () => compareSchemaInventories(inventory(previous.migrations, reviewedPolicy()), targetWithUnknown),
    "migration_not_authorized",
  );
});

test("an old image without policy accepts only an identical schema", () => {
  const previous = threeMigrationInventory();
  const same = structuredClone(previous);
  assert.deepEqual(compareSchemaCompatibility(previous, same), {
    status: "compatible",
    previousMigrationCount: 3,
    targetMigrationCount: 3,
    commonMigrationCount: 3,
    addedMigrationCount: 0,
    removedMigrationCount: 0,
    policyUsed: false,
  });
  const target = inventory([...previous.migrations, migration(4, "fourth")]);
  expectCode(() => compareSchemaCompatibility(previous, target), "previous_policy_missing");
});

test("policy baseline mismatch fails closed", () => {
  const previousMigrations = reviewedMigrations();
  const targetMigrations = reviewedMigrations(true);
  const targetPolicy = reviewedPolicy();
  targetPolicy.baseMigration = "032_workspace_storage_operator_runs.sql";
  expectCode(
    () => compareSchemaInventories(
      inventory(previousMigrations, reviewedPolicy()),
      inventory(targetMigrations, targetPolicy),
    ),
    "target_policy_base_unreviewed",
  );
});

test("target missing a previous migration is rejected", () => {
  const previous = threeMigrationInventory();
  const target = inventory(previous.migrations.slice(0, 2));
  expectCode(() => compareSchemaInventories(previous, target), "target_missing_previous_migration");
});

test("a future migration already present in the old image is common, not newly authorized", () => {
  const migrations = reviewedMigrations(true);
  const oldPolicy = reviewedPolicy();
  const result = compareSchemaInventories(
    inventory(migrations, oldPolicy),
    inventory(migrations, oldPolicy),
  );
  assert.equal(result.addedMigrationCount, 0);
  assert.equal(result.policyUsed, false);
});

test("invalid inventory, policy, order, and directory-shaped metadata fail closed", () => {
  const previous = threeMigrationInventory();
  const target = structuredClone(previous);
  target.migrations[2].name = "004_third.sql";
  expectCode(() => compareSchemaInventories(previous, target), "target_migration_sequence_invalid");

  const invalidPolicy = policy(
    REVIEWED_BASE_MIGRATION,
    [{ name: REVIEWED_COMPATIBLE_MIGRATION, sha256: "not-a-sha" }],
  );
  expectCode(
    () => compareSchemaInventories(inventory(reviewedMigrations(), invalidPolicy), inventory(reviewedMigrations())),
    "previous_policy_compatible_hash_invalid",
  );

  const directoryEntry = structuredClone(previous);
  directoryEntry.migrations.push({ name: "004_bad-name.sql", sha256: hash("d") });
  expectCode(() => compareSchemaInventories(previous, directoryEntry), "target_migration_name_invalid");
});

test("bounded image inspection uses a network-isolated, read-only owned container", async () => {
  const oldValue = threeMigrationInventory();
  const newValue = structuredClone(oldValue);
  const docker = fakeDocker(new Map([
    [previousImage, oldValue],
    [targetImage, newValue],
  ]));
  const result = await verifySchemaCompatibility({
    previousImage,
    targetImage,
    dockerRunner: docker.runner,
    runIDFactory: (role) => role === "previous" ? "1".repeat(64) : "2".repeat(64),
  });
  assert.equal(result.status, "compatible");
  assert.equal(docker.calls.filter((args) => args[0] === "rm").length, 2);
  const createCalls = docker.calls.filter((args) => args[0] === "create");
  assert.equal(createCalls.length, 2);
  for (const args of createCalls) {
    assert.ok(args.includes("--network") && args[args.indexOf("--network") + 1] === "none");
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--cap-drop") && args[args.indexOf("--cap-drop") + 1] === "ALL");
    assert.ok(args.includes("--user") && args[args.indexOf("--user") + 1] === SCHEMA_COMPATIBILITY_USER);
    assert.ok(args.includes("--pids-limit") && args[args.indexOf("--pids-limit") + 1] === String(CONTAINER_PIDS_LIMIT));
    assert.ok(args.includes("--memory"));
    assert.equal(args.includes("--mount"), false);
    assert.equal(args.includes("--env"), false);
    assert.equal(args.includes("--env-file"), false);
    assert.equal(args.includes("/bin/sh"), true);
    assert.equal(args.includes(SCHEMA_INSPECTION_SCRIPT), true);
  }
  assert.equal(SCHEMA_INSPECTION_SCRIPT.includes("printf 'DLSCHEMA\\t1\\n'"), true);
});

test("malicious container report is never surfaced and owned cleanup still runs", async () => {
  const docker = fakeDocker(new Map([
    [previousImage, threeMigrationInventory()],
    [targetImage, threeMigrationInventory()],
  ]), { mode: "malicious-output" });
  await expectAsyncCode(
    () => verifySchemaCompatibility({
      previousImage,
      targetImage,
      dockerRunner: docker.runner,
      runIDFactory: (role) => role === "previous" ? "3".repeat(64) : "4".repeat(64),
    }),
    "container_migration_name_invalid",
  );
  assert.equal(docker.calls.filter((args) => args[0] === "rm").length, 1);
  assert.equal(docker.calls.some((args) => args.some((value) => value.includes("SELECT secret"))), false);
});

test("cleanup refuses a container whose ownership label changed", async () => {
  const docker = fakeDocker(new Map([
    [previousImage, threeMigrationInventory()],
    [targetImage, threeMigrationInventory()],
  ]), { mode: "foreign-cleanup" });
  await expectAsyncCode(
    () => verifySchemaCompatibility({
      previousImage,
      targetImage,
      dockerRunner: docker.runner,
      runIDFactory: (role) => role === "previous" ? "5".repeat(64) : "6".repeat(64),
    }),
    "cleanup_ownership_unverified",
  );
  assert.equal(docker.calls.some((args) => args[0] === "rm"), false);
});

test("duplicate policy keys are rejected instead of being accepted by JSON.parse", async () => {
  const docker = fakeDocker(new Map([
    [previousImage, threeMigrationInventory()],
    [targetImage, threeMigrationInventory()],
  ]), { mode: "duplicate-policy" });
  await expectAsyncCode(
    () => verifySchemaCompatibility({
      previousImage,
      targetImage,
      dockerRunner: docker.runner,
      runIDFactory: (role) => role === "previous" ? "7".repeat(64) : "8".repeat(64),
    }),
    "policy_duplicate_key",
  );
  assert.equal(docker.calls.filter((args) => args[0] === "rm").length, 1);
});

test("create timeout and corrupt ID recover one exact label-owned container before cleanup", async () => {
  for (const mode of ["create-response-timeout", "create-response-corrupt"]) {
    const docker = fakeDocker(new Map([
      [previousImage, threeMigrationInventory()],
      [targetImage, threeMigrationInventory()],
    ]), { mode });
    await expectAsyncCode(
      () => verifySchemaCompatibility({
        previousImage,
        targetImage,
        dockerRunner: docker.runner,
        runIDFactory: (role) => role === "previous" ? "9".repeat(64) : "a".repeat(64),
      }),
      mode === "create-response-timeout" ? "container_create_timeout" : "created_container_invalid",
    );
    const lookup = docker.calls.find((args) => args[0] === "ps");
    assert.ok(lookup, `${mode} must perform a bounded label lookup`);
    assert.equal(lookup.includes("--all"), true);
    assert.equal(lookup.includes("--no-trunc"), true);
    assert.match(lookup[lookup.indexOf("--filter") + 1], /^label=com\.duallane\.schema-compatibility=[0-9a-f]{64}$/u);
    const removed = docker.calls.filter((args) => args[0] === "rm");
    assert.equal(removed.length, 1);
    assert.match(removed[0].at(-1), /^[0-9a-f]{64}$/u);
    assert.equal(removed[0].some((value) => value.includes("duallane-schema-compatibility")), false);
  }
});

test("unconfirmed create state is reported without guessing a cleanup target", async () => {
  const docker = fakeDocker(new Map([
    [previousImage, threeMigrationInventory()],
    [targetImage, threeMigrationInventory()],
  ]), { mode: "create-response-timeout-unconfirmed" });
  await expectAsyncCode(
    () => verifySchemaCompatibility({
      previousImage,
      targetImage,
      dockerRunner: docker.runner,
      runIDFactory: (role) => role === "previous" ? "b".repeat(64) : "c".repeat(64),
    }),
    "create_cleanup_unconfirmed",
  );
  assert.equal(docker.calls.some((args) => args[0] === "rm"), false);
});

test("inspection process failure remains a stable error and cleans the verified owner", async () => {
  const docker = fakeDocker(new Map([
    [previousImage, threeMigrationInventory()],
    [targetImage, threeMigrationInventory()],
  ]), { mode: "inspection-failure" });
  await expectAsyncCode(
    () => verifySchemaCompatibility({
      previousImage,
      targetImage,
      dockerRunner: docker.runner,
      runIDFactory: (role) => role === "previous" ? "d".repeat(64) : "e".repeat(64),
    }),
    "container_run_failed",
  );
  assert.equal(docker.calls.filter((args) => args[0] === "rm").length, 1);
});

function deferredChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => child.emit("close", null));
    return true;
  };
  return child;
}

test("Docker runner maps command timeout to a stable bounded error", async () => {
  const child = deferredChild();
  const runner = createDockerRunner({ spawn: () => child });
  await expectAsyncCode(() => runner.run(["version"], { timeoutMs: 5 }), "docker_timeout");
  assert.deepEqual(child.kills, ["SIGKILL"]);
});

test("Docker runner kills an over-output command and never returns unbounded bytes", async () => {
  const child = deferredChild();
  const runner = createDockerRunner({ spawn: () => child });
  const pending = runner.run(["version"], { timeoutMs: 1_000 });
  queueMicrotask(() => child.stdout.emit("data", Buffer.alloc(MAX_DOCKER_OUTPUT_BYTES + 1, 0x41)));
  await expectAsyncCode(() => pending, "docker_output_too_large");
  assert.deepEqual(child.kills, ["SIGKILL"]);
});

test("CLI rejects malformed image IDs with a stable code and no output leak", () => {
  const result = spawnSync(process.execPath, [helper, "verify", "--previous-image", "sha256:secret", "--target-image", targetImage], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "release schema compatibility rejected: invalid_previous_image");
  assert.equal(result.stderr.includes("secret"), false);
});
