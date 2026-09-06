import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  GO_RECOVERY_SERVICES,
  MANIFEST_FORMAT,
  MANIFEST_VERSION,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  assertSupportedPlatform,
  captureExternalFiles,
  verifyExternalFiles,
} from "../../deploy/production/release-external-files.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const helper = path.join(root, "deploy/production/release-external-files.mjs");
const services = [...GO_RECOVERY_SERVICES];

function expectCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

async function expectAsyncCode(callback, code) {
  await assert.rejects(callback, (error) => error?.code === code);
}

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "duallane-release-external-files-"));
}

async function writePrivate(filePath, value) {
  await writeFile(filePath, value, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function writeCompose(directory, overrides = {}) {
  const secretPath =
    overrides.secretPath ?? path.join(directory, "secret$.json");
  const configPath =
    overrides.configPath ?? path.join(directory, "workspace.conf");
  const bindPath = overrides.bindPath ?? path.join(directory, "renderer.mjs");
  if (overrides.writeFiles !== false) {
    await writePrivate(
      secretPath,
      '{"accessKey":"synthetic$access","secretKey":"synthetic$secret"}\n',
    );
    await writePrivate(configPath, "synthetic workspace config\n");
    let bindInfo = null;
    try {
      bindInfo = await lstat(bindPath);
    } catch {}
    if (!bindInfo?.isDirectory() && !bindInfo?.isSymbolicLink()) {
      await writePrivate(bindPath, "export default 'synthetic';\n");
      await chmod(bindPath, 0o644);
    }
  }
  const baseCompose = {
    name: "duallane-synthetic-release",
    services: {
      p2p: { image: "sha256:p2p", command: ["serve"] },
      workspace: {
        image: "sha256:workspace",
        secrets: [
          { source: "workspace-s3", target: "workspace-s3", mode: "0600" },
        ],
        configs: [
          {
            source: "workspace-config",
            target: "/etc/duallane/workspace.conf",
          },
        ],
        volumes: [
          {
            type: "bind",
            source: bindPath,
            target: "/app/renderer.mjs",
            read_only: true,
          },
        ],
      },
      worker: { image: "sha256:worker", secrets: ["workspace-s3"] },
      web: { image: "sha256:web", volumes: ["web-cache:/var/cache/nginx"] },
      migrate: { image: "sha256:migrate", command: ["up"] },
    },
    secrets: {
      "workspace-s3": { file: secretPath },
    },
    configs: {
      "workspace-config": { file: configPath },
    },
    volumes: {
      "web-cache": {},
    },
  };
  const composeOverrides = overrides.compose ?? {};
  const compose = {
    ...baseCompose,
    ...composeOverrides,
    services: { ...baseCompose.services, ...(composeOverrides.services ?? {}) },
  };
  const composePath =
    overrides.composePath ?? path.join(directory, "compose.json");
  await writePrivate(composePath, `${JSON.stringify(compose, null, 2)}\n`);
  return { compose, composePath, secretPath, configPath, bindPath };
}

async function captureFixture(overrides = {}) {
  const directory = await temporaryDirectory();
  const fixture = await writeCompose(directory, overrides);
  const manifestPath = path.join(directory, "external-manifest.json");
  await captureExternalFiles({
    composePath: fixture.composePath,
    services,
    outputPath: manifestPath,
  });
  return { directory, manifestPath, ...fixture };
}

function runCLI(args) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 256 * 1024,
    env: { ...process.env },
  });
}

test("Linux is an explicit platform gate and the manifest fingerprints only used external files", async (t) => {
  expectCode(() => assertSupportedPlatform("win32"), "linux_only");
  if (process.platform !== "linux") {
    t.skip(
      "functional fixture checks run in the required Linux validation environment",
    );
    return;
  }
  const fixture = await captureFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  assert.equal(manifest.format, MANIFEST_FORMAT);
  assert.equal(manifest.version, MANIFEST_VERSION);
  assert.deepEqual(manifest.services, services);
  assert.equal(manifest.files.length, 3);
  assert.equal(
    manifest.files.reduce((total, file) => total + file.size, 0),
    manifest.totalBytes,
  );
  assert.ok(
    manifest.files.every(
      (file) => file.dev && file.ino && file.sha256.length === 64,
    ),
  );
  assert.equal(JSON.stringify(manifest).includes("synthetic$access"), false);
  assert.equal(JSON.stringify(manifest).includes("synthetic$secret"), false);
  assert.equal((await lstat(fixture.manifestPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    await verifyExternalFiles({
      composePath: fixture.composePath,
      inputPath: fixture.manifestPath,
    }),
    {
      status: "completed",
      operation: "verify",
      format: MANIFEST_FORMAT,
      version: MANIFEST_VERSION,
      fileCount: 3,
      totalBytes: manifest.totalBytes,
    },
  );

  const cliManifestPath = path.join(fixture.directory, "cli-manifest.json");
  const captured = runCLI([
    "capture",
    "--compose",
    fixture.composePath,
    "--services",
    services.join(","),
    "--output",
    cliManifestPath,
  ]);
  assert.equal(captured.status, 0, captured.stderr);
  assert.equal(captured.stderr, "");
  assert.equal(JSON.parse(captured.stdout).fileCount, 3);
  assert.equal(captured.stdout.includes("synthetic$secret"), false);
  const verified = runCLI([
    "verify",
    "--compose",
    fixture.composePath,
    "--input",
    cliManifestPath,
  ]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stderr, "");
  assert.equal(JSON.parse(verified.stdout).operation, "verify");
});

test("capture and verify bind the frozen canonical Compose structure and exact service set", async (t) => {
  if (process.platform !== "linux") {
    t.skip(
      "functional fixture checks run in the required Linux validation environment",
    );
    return;
  }
  const fixture = await captureFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const altered = structuredClone(fixture.compose);
  altered.services.workspace.command = ["changed"];
  await writePrivate(fixture.composePath, `${JSON.stringify(altered)}\n`);
  await assert.rejects(
    verifyExternalFiles({
      composePath: fixture.composePath,
      inputPath: fixture.manifestPath,
    }),
    (error) => error?.code === "compose_changed",
  );
  expectCode(() => assertSupportedPlatform("darwin"), "linux_only");
});

test("verify rejects a changed final file before reading beyond the remaining total budget", async (t) => {
  if (process.platform !== "linux") {
    t.skip(
      "functional fixture checks run in the required Linux validation environment",
    );
    return;
  }
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = ["growth-0", "growth-1", "growth-2", "growth-3", "growth-4"];
  const sources = names.map((name) => path.join(directory, `${name}.secret`));
  const sizes = [
    MAX_FILE_BYTES,
    MAX_FILE_BYTES,
    MAX_FILE_BYTES,
    MAX_FILE_BYTES - 1024,
    8,
  ];
  const fixture = await writeCompose(directory, {
    writeFiles: false,
    compose: {
      secrets: Object.fromEntries(
        names.map((name, index) => [name, { file: sources[index] }]),
      ),
      services: {
        workspace: {
          image: "sha256:workspace",
          secrets: names,
          configs: [],
          volumes: [],
        },
        worker: { image: "sha256:worker", secrets: [] },
      },
    },
  });
  for (const [index, source] of sources.entries())
    await writePrivate(source, Buffer.alloc(sizes[index], 0x61 + index));
  const manifestPath = path.join(directory, "growth-manifest.json");
  await captureExternalFiles({
    composePath: fixture.composePath,
    services,
    outputPath: manifestPath,
  });

  await writePrivate(sources[4], Buffer.alloc(MAX_FILE_BYTES, 0x7a));
  await expectAsyncCode(
    () =>
      verifyExternalFiles({
        composePath: fixture.composePath,
        inputPath: manifestPath,
      }),
    "external_file_changed",
  );
});

test("capture rejects external and environment-backed secret/config sources", async (t) => {
  if (process.platform !== "linux") {
    t.skip(
      "functional fixture checks run in the required Linux validation environment",
    );
    return;
  }
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const definition of [
    { external: true },
    { environment: "SYNTHETIC_SECRET" },
  ]) {
    const fixture = await writeCompose(directory, {
      compose: { secrets: { "workspace-s3": definition } },
    });
    await expectAsyncCode(
      () =>
        captureExternalFiles({
          composePath: fixture.composePath,
          services,
          outputPath: path.join(directory, "manifest.json"),
        }),
      "secret_source_not_file",
    );
  }
});

test("capture rejects writable binds, directories, symlinks, and symlinked parents", async (t) => {
  if (process.platform !== "linux") {
    t.skip(
      "functional fixture checks run in the required Linux validation environment",
    );
    return;
  }
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writable = await writeCompose(directory, {
    compose: {
      services: {
        workspace: {
          volumes: [
            {
              type: "bind",
              source: path.join(directory, "renderer.mjs"),
              target: "/app/x",
              read_only: false,
            },
          ],
        },
      },
    },
  });
  await expectAsyncCode(
    () =>
      captureExternalFiles({
        composePath: writable.composePath,
        services,
        outputPath: path.join(directory, "writable.json"),
      }),
    "bind_not_read_only",
  );

  const directoryBind = path.join(directory, "directory-bind");
  await mkdir(directoryBind);
  const directoryFixture = await writeCompose(directory, {
    bindPath: directoryBind,
  });
  await expectAsyncCode(
    () =>
      captureExternalFiles({
        composePath: directoryFixture.composePath,
        services,
        outputPath: path.join(directory, "directory.json"),
      }),
    "external_file_not_regular",
  );

  const symlinkTarget = path.join(directory, "symlink-target");
  const symlinkPath = path.join(directory, "renderer-link.mjs");
  await writePrivate(symlinkTarget, "synthetic\n");
  await symlink(symlinkTarget, symlinkPath);
  const symlinkFixture = await writeCompose(directory, {
    bindPath: symlinkPath,
  });
  await expectAsyncCode(
    () =>
      captureExternalFiles({
        composePath: symlinkFixture.composePath,
        services,
        outputPath: path.join(directory, "symlink.json"),
      }),
    "external_file_symlink",
  );

  const realParent = path.join(directory, "real-parent");
  const linkedParent = path.join(directory, "linked-parent");
  await mkdir(realParent);
  await symlink(realParent, linkedParent);
  const parentPath = path.join(linkedParent, "bind.mjs");
  await writePrivate(path.join(realParent, "bind.mjs"), "synthetic\n");
  const parentFixture = await writeCompose(directory, { bindPath: parentPath });
  await expectAsyncCode(
    () =>
      captureExternalFiles({
        composePath: parentFixture.composePath,
        services,
        outputPath: path.join(directory, "parent.json"),
      }),
    "external_file_parent_symlink",
  );
});

test("verify fails closed for in-place changes, replacement, permissions, and missing files", async (t) => {
  if (process.platform !== "linux") {
    t.skip(
      "functional fixture checks run in the required Linux validation environment",
    );
    return;
  }
  {
    const fixture = await captureFixture();
    t.after(() => rm(fixture.directory, { recursive: true, force: true }));
    await writePrivate(
      fixture.secretPath,
      '{"accessKey":"changed$access","secretKey":"synthetic$secret"}\n',
    );
    await assert.rejects(
      verifyExternalFiles({
        composePath: fixture.composePath,
        inputPath: fixture.manifestPath,
      }),
      (error) => error?.code === "external_file_changed",
    );
  }
  {
    const fixture = await captureFixture();
    t.after(() => rm(fixture.directory, { recursive: true, force: true }));
    const retained = `${fixture.secretPath}.retained`;
    await rename(fixture.secretPath, retained);
    await writePrivate(
      fixture.secretPath,
      '{"accessKey":"rotations$access","secretKey":"synthetic$secret"}\n',
    );
    await assert.rejects(
      verifyExternalFiles({
        composePath: fixture.composePath,
        inputPath: fixture.manifestPath,
      }),
      (error) => error?.code === "external_file_identity_changed",
    );
  }
  {
    const fixture = await captureFixture();
    t.after(() => rm(fixture.directory, { recursive: true, force: true }));
    await chmod(fixture.secretPath, 0o644);
    await assert.rejects(
      verifyExternalFiles({
        composePath: fixture.composePath,
        inputPath: fixture.manifestPath,
      }),
      (error) => error?.code === "external_file_changed",
    );
  }
  {
    const fixture = await captureFixture();
    t.after(() => rm(fixture.directory, { recursive: true, force: true }));
    await rm(fixture.secretPath);
    await assert.rejects(
      verifyExternalFiles({
        composePath: fixture.composePath,
        inputPath: fixture.manifestPath,
      }),
      (error) => error?.code === "external_file_missing",
    );
  }
});

test("capture refuses an unreadable source for the deployment identity without changing its mode", async (t) => {
  if (process.platform !== "linux") {
    t.skip(
      "functional fixture checks run in the required Linux validation environment",
    );
    return;
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root can bypass a mode-bit readability check");
    return;
  }
  const fixture = await (async () => {
    const directory = await temporaryDirectory();
    const value = await writeCompose(directory);
    return { directory, ...value };
  })();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await chmod(fixture.secretPath, 0o000);
  await expectAsyncCode(
    () =>
      captureExternalFiles({
        composePath: fixture.composePath,
        services,
        outputPath: path.join(fixture.directory, "unreadable.json"),
      }),
    "external_file_unreadable",
  );
  assert.equal((await lstat(fixture.secretPath)).mode & 0o777, 0);
});

test("file and aggregate byte limits are bounded before a manifest is written", async (t) => {
  if (process.platform !== "linux") {
    t.skip(
      "functional fixture checks run in the required Linux validation environment",
    );
    return;
  }
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oversized = await writeCompose(directory);
  await writeFile(oversized.bindPath, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61), {
    mode: 0o600,
  });
  await chmod(oversized.bindPath, 0o600);
  await expectAsyncCode(
    () =>
      captureExternalFiles({
        composePath: oversized.composePath,
        services,
        outputPath: path.join(directory, "oversized.json"),
      }),
    "external_file_too_large",
  );

  const totalCompose = await writeCompose(directory);
  const totalPaths = [];
  for (let index = 0; index < 5; index += 1) {
    const source = path.join(directory, `total-${index}.secret`);
    await writeFile(source, Buffer.alloc(MAX_FILE_BYTES, 0x62), {
      mode: 0o600,
    });
    await chmod(source, 0o600);
    totalPaths.push(source);
  }
  const totalSecrets = Object.fromEntries(
    totalPaths.map((source, index) => [`synthetic-${index}`, { file: source }]),
  );
  totalCompose.compose.secrets = totalSecrets;
  totalCompose.compose.services.workspace.secrets = Object.keys(
    totalSecrets,
  ).map((source) => ({ source, target: source }));
  totalCompose.compose.services.worker.secrets = [];
  await writePrivate(
    totalCompose.composePath,
    `${JSON.stringify(totalCompose.compose)}\n`,
  );
  await expectAsyncCode(
    () =>
      captureExternalFiles({
        composePath: totalCompose.composePath,
        services,
        outputPath: path.join(directory, "total.json"),
      }),
    "too_many_total_bytes",
  );
  assert.equal(MAX_TOTAL_BYTES, 4 * MAX_FILE_BYTES);
});

test("file-count limit, exclusive output, and sanitized CLI failures do not expose secret or filesystem details", async (t) => {
  if (process.platform !== "linux") {
    t.skip(
      "functional fixture checks run in the required Linux validation environment",
    );
    return;
  }
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await writeCompose(directory);
  const many = {};
  const references = [];
  for (let index = 0; index < 33; index += 1) {
    const source = path.join(directory, `many-${index}.secret`);
    await writePrivate(source, `synthetic-${index}\n`);
    many[`many-${index}`] = { file: source };
    references.push({ source: `many-${index}`, target: `many-${index}` });
  }
  fixture.compose.secrets = many;
  fixture.compose.services.workspace.secrets = references;
  fixture.compose.services.worker.secrets = [];
  await writePrivate(
    fixture.composePath,
    `${JSON.stringify(fixture.compose)}\n`,
  );
  await expectAsyncCode(
    () =>
      captureExternalFiles({
        composePath: fixture.composePath,
        services,
        outputPath: path.join(directory, "many.json"),
      }),
    "too_many_files",
  );

  const normal = await captureFixture();
  t.after(() => rm(normal.directory, { recursive: true, force: true }));
  const existing = await readFile(normal.manifestPath, "utf8");
  const second = await assert.rejects(
    captureExternalFiles({
      composePath: normal.composePath,
      services,
      outputPath: normal.manifestPath,
    }),
    (error) => error?.code === "manifest_exists",
  );
  assert.equal(second, undefined);
  assert.equal(await readFile(normal.manifestPath, "utf8"), existing);

  await rm(normal.secretPath);
  const cli = runCLI([
    "verify",
    "--compose",
    normal.composePath,
    "--input",
    normal.manifestPath,
  ]);
  assert.notEqual(cli.status, 0);
  assert.match(
    cli.stderr,
    /release external files rejected: external_file_missing\n/,
  );
  assert.equal(cli.stdout, "");
  assert.equal(cli.stderr.includes(normal.secretPath), false);
  assert.equal(cli.stderr.includes("synthetic$secret"), false);
  assert.equal(cli.stderr.includes("ENOENT"), false);
});
