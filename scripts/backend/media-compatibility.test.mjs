import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseGoImageReference,
  parseMediaCompatibilityArguments,
  environmentReport,
  runGoProbe,
  runMediaCompatibility
} from "./media-compatibility.mjs";

test("Sharp and govips media compatibility corpus", async () => {
  const report = await runMediaCompatibility({ jsonOutput: false });
  assert.equal(report.summary.failures, 0, "media compatibility report contains mismatches");
  assert.ok(report.summary.accepted >= 10, "valid synthetic media cases were not exercised");
  assert.ok(report.summary.rejected >= 8, "invalid and over-limit cases were not exercised");
  assert.equal(report.summary.pixelChecks, report.summary.accepted, "every accepted output must receive a pixel comparison");
});

test("native probe runner is synthetic, image-pinned, and label-owned", async () => {
  const workDirectory = await mkdtemp(path.join(tmpdir(), "duallane-media-native-runner-"));
  const imageID = `sha256:${"a".repeat(64)}`;
  const containerID = "b".repeat(64);
  const calls = [];
  const runner = {
    async inspectImage(image) {
      calls.push({ operation: "inspectImage", image });
      return image;
    },
    async create(spec) {
      calls.push({ operation: "create", spec });
      return containerID;
    },
    async inspectContainer(id, label) {
      calls.push({ operation: "inspectContainer", id, label });
      return { missing: false, id, image: imageID, label };
    },
    async start(id, timeoutMs) {
      calls.push({ operation: "start", id, timeoutMs });
    },
    async remove(id, label) {
      calls.push({ operation: "remove", id, label });
    }
  };

  try {
    const result = await runGoProbe({
      manifestPath: path.join(workDirectory, "manifest.json"),
      goReportPath: path.join(workDirectory, "go-report.json"),
      workDirectory,
      goImage: imageID,
      dockerRunner: runner
    });
    assert.equal(result.mode, "native-container");
    assert.equal(result.imageID, imageID);
    assert.deepEqual(calls.map(({ operation }) => operation), [
      "inspectImage", "create", "inspectContainer", "start", "remove"
    ]);
    assert.equal(calls[0].image, imageID);
    assert.equal(calls[3].id, containerID);
    assert.equal(calls[4].id, containerID);
    assert.equal(calls[4].label, calls[2].label);

    const spec = calls[1].spec;
    assert.equal(spec.image, imageID);
    assert.match(spec.label, /^[0-9a-f-]{36}$/);
    assert.deepEqual(spec.args.slice(0, 2), ["create", "--rm"]);
    assert.ok(spec.args.includes("--network") && spec.args.includes("none"));
    assert.ok(spec.args.includes("--cap-drop") && spec.args.includes("ALL"));
    assert.ok(spec.args.includes("--security-opt") && spec.args.includes("no-new-privileges"));
    assert.ok(spec.args.includes("--read-only"));
    assert.ok(spec.args.includes("--tmpfs") && spec.args.includes("/tmp:rw,exec,nosuid,nodev,size=2g"));
    assert.ok(spec.args.includes("--user"));
    assert.equal(spec.args[spec.args.indexOf("--user") + 1], `${process.getuid()}:${process.getgid()}`);
    assert.ok(spec.args.includes(`type=bind,src=${workDirectory},dst=${workDirectory}`));
    assert.equal(spec.args.includes("--pull"), false);
    assert.equal(spec.args.includes("build"), false);
    assert.equal(spec.args.includes("--name"), false);
    assert.match(spec.args.at(-1), /go test -count=1 \.\/internal\/platform\/media/);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

test("native probe rejects a container image drift before start", async () => {
  const workDirectory = await mkdtemp(path.join(tmpdir(), "duallane-media-native-drift-"));
  const imageID = `sha256:${"1".repeat(64)}`;
  const driftedImageID = `sha256:${"2".repeat(64)}`;
  const containerID = "3".repeat(64);
  let started = false;
  const removed = [];
  const runner = {
    async inspectImage(image) {
      return image;
    },
    async create() {
      return containerID;
    },
    async inspectContainer(id, label) {
      return { missing: false, id, image: driftedImageID, label };
    },
    async start() {
      started = true;
    },
    async remove(id, label) {
      removed.push({ id, label });
    }
  };

  try {
    await assert.rejects(
      runGoProbe({
        manifestPath: path.join(workDirectory, "manifest.json"),
        goReportPath: path.join(workDirectory, "go-report.json"),
        workDirectory,
        goImage: imageID,
        dockerRunner: runner
      }),
      /ownership could not be confirmed/
    );
    assert.equal(started, false);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].id, containerID);
    assert.match(removed[0].label, /^[0-9a-f-]{36}$/);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

test("native probe cleanup uses exact container ID after a bounded failure", async () => {
  const workDirectory = await mkdtemp(path.join(tmpdir(), "duallane-media-native-timeout-"));
  const imageID = `sha256:${"c".repeat(64)}`;
  const containerID = "d".repeat(64);
  const removed = [];
  const runner = {
    async inspectImage(image) {
      return image;
    },
    async create() {
      return containerID;
    },
    async inspectContainer(id, label) {
      return { missing: false, id, image: imageID, label };
    },
    async start() {
      throw new Error("synthetic bounded timeout");
    },
    async remove(id, label) {
      removed.push({ id, label });
    }
  };

  try {
    await assert.rejects(
      runGoProbe({
        manifestPath: path.join(workDirectory, "manifest.json"),
        goReportPath: path.join(workDirectory, "go-report.json"),
        workDirectory,
        goImage: imageID,
        dockerRunner: runner
      }),
      /synthetic bounded timeout/
    );
    assert.equal(removed.length, 1);
    assert.equal(removed[0].id, containerID);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

test("go image option requires an exact local image ID", () => {
  const imageID = `sha256:${"e".repeat(64)}`;
  assert.equal(parseGoImageReference(imageID), imageID);
  assert.equal(parseGoImageReference(undefined), undefined);
  assert.equal(parseGoImageReference(null), undefined);
  for (const value of ["latest", "sha256:short", `sha256:${"E".repeat(64)}`, "sha256:"]) {
    assert.throws(() => parseGoImageReference(value), /sha256/);
  }
});

test("CLI parser makes native image selection explicit", () => {
  const imageID = `sha256:${"f".repeat(64)}`;
  assert.deepEqual(parseMediaCompatibilityArguments(["--json", "--go-image", imageID]), {
    jsonOutput: true,
    goImage: imageID
  });
  assert.deepEqual(parseMediaCompatibilityArguments([`--go-image=${imageID}`]), {
    jsonOutput: false,
    goImage: imageID
  });
  assert.throws(() => parseMediaCompatibilityArguments(["--go-image"]), /requires/);
  assert.throws(
    () => parseMediaCompatibilityArguments(["--unexpected-secret-looking-value"]),
    (error) => error instanceof Error && error.message === "unsupported media compatibility option"
  );
});

test("native probe rejects unsupported host UID/GID platforms", async () => {
  if (process.platform === "linux") return;
  await assert.rejects(
    runGoProbe({
      goImage: `sha256:${"8".repeat(64)}`
    }),
    /requires Linux host UID\/GID/
  );
});

test("native environment evidence is bounded and semantically validated", async () => {
  const workDirectory = await mkdtemp(path.join(tmpdir(), "duallane-media-native-env-"));
  const environmentPaths = {
    goVersion: path.join(workDirectory, "go-version.txt"),
    goCgo: path.join(workDirectory, "go-cgo.txt"),
    libvips: path.join(workDirectory, "libvips-version.txt")
  };
  const probe = { mode: "native-container", environmentPaths };
  const imageID = `sha256:${"9".repeat(64)}`;

  try {
    await writeFile(environmentPaths.goVersion, "go version go1.26.8 linux/amd64\n");
    await writeFile(environmentPaths.goCgo, "1\n");
    await writeFile(environmentPaths.libvips, "8.14.1\n");
    const report = await environmentReport({ probe, goImage: imageID });
    assert.equal(report.go, "go version go1.26.8 linux/amd64");
    assert.equal(report.goCgo, "1");
    assert.equal(report.systemLibvips, "8.14.1");
    assert.equal(report.goSource, "container");

    await writeFile(environmentPaths.goCgo, "0\n");
    await assert.rejects(environmentReport({ probe, goImage: imageID }), /CGO_ENABLED evidence is invalid/);
    await writeFile(environmentPaths.goCgo, "1\n");
    await writeFile(environmentPaths.libvips, "not-a-version\n");
    await assert.rejects(environmentReport({ probe, goImage: imageID }), /libvips version evidence is invalid/);
    await writeFile(environmentPaths.libvips, "8.14.1\n");
    await writeFile(environmentPaths.goVersion, "x".repeat(4 * 1024 + 1));
    await assert.rejects(environmentReport({ probe, goImage: imageID }), /Go version evidence is invalid/);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});
