import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedPackages = new Set([
  "@aws-sdk/client-s3",
  "@aws-sdk/lib-storage",
  "pg"
]);
const forbiddenRuntimePatterns = [
  /(?:^|[^\w])fastify(?:[^\w]|$)/i,
  /@fastify\//i,
  /\.listen\s*\(/,
  /createServer\s*\(/,
  /node:worker_threads/,
  /setInterval\s*\(/,
  /setTimeout\s*\(/
];

test("node-compat source stays offline and outside the online server closure", async () => {
  const files = await collectSourceFiles(packageRoot);
  assert.ok(files.length > 0);
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    for (const pattern of forbiddenRuntimePatterns) {
      assert.doesNotMatch(source, pattern, `${path.relative(packageRoot, filePath)} matched ${pattern}`);
    }
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(filePath), specifier);
        assert.ok(
          target === packageRoot || target.startsWith(`${packageRoot}${path.sep}`),
          `${path.relative(packageRoot, filePath)} imports outside tools/node-compat: ${specifier}`
        );
        continue;
      }
      assert.doesNotMatch(specifier, /apps[\\/]web[\\/]server/);
      assert.ok(allowedPackages.has(specifier), `${path.relative(packageRoot, filePath)} imports undeclared package ${specifier}`);
    }
  }
});

test("entrypoints have no import-time execution and package has no lifecycle hooks", async () => {
  const entrypoints = ["storage-migrate.mjs", "storage-dedupe.mjs", "storage-provision.mjs"];
  for (const entrypoint of entrypoints) {
    const source = await readFile(path.join(packageRoot, entrypoint), "utf8");
    assert.match(source, /fileURLToPath/);
    assert.match(source, /process\.argv\[1\]/);
    assert.match(source, /path\.resolve/);
  }
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.scripts).sort(), [
    "storage:dedupe",
    "storage:migrate",
    "storage:provision",
    "test"
  ]);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    "@aws-sdk/client-s3",
    "@aws-sdk/lib-storage",
    "pg"
  ]);
  assert.ok(!Object.keys(manifest).some((key) => /install|prepare|post/i.test(key)));
  const databaseSource = await readFile(path.join(packageRoot, "lib", "database.mjs"), "utf8");
  assert.doesNotMatch(databaseSource, /migrateDatabase|seedWorkspace/);
  for (const command of ["storage-migrate.mjs", "storage-dedupe.mjs"]) {
    const source = await readFile(path.join(packageRoot, "commands", command), "utf8");
    assert.match(source, /migrate:\s*false/);
    assert.match(source, /seed:\s*false/);
  }
});

test("canonical SQL remains outside this package", async () => {
  const canonicalMigrations = path.resolve(packageRoot, "..", "..", "apps/web/server/migrations");
  const entries = await readdir(canonicalMigrations);
  assert.ok(entries.some((entry) => entry.endsWith(".sql")));
  assert.equal(path.relative(packageRoot, canonicalMigrations).startsWith(".."), true);
});

async function collectSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "test" || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(entryPath);
    }
  }
  return files;
}

function importSpecifiers(source) {
  return [...source.matchAll(/\bimport\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)]
    .map((match) => match[1]);
}
