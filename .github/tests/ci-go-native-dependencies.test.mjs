import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../workflows/ci.yml', import.meta.url);
const workflow = (await readFile(workflowPath, 'utf8')).replace(/\r\n?/g, '\n');

test('the module minimum is supported by the pinned CI and container Go toolchain', async () => {
  const root = new URL('../../', import.meta.url);
  const [module, ...dockerfiles] = await Promise.all([
    'apps/backend/go.mod', 'Dockerfile.p2p', 'Dockerfile.workspace',
  ].map((path) => readFile(new URL(path, root), 'utf8')));
  const normalizedModule = module.replace(/\r\n?/g, '\n');
  const minimum = normalizedModule.match(/^go (\d+)\.(\d+)\.(\d+)$/m);
  const toolchain = normalizedModule.match(/^toolchain go(\d+)\.(\d+)\.(\d+)$/m);
  assert.ok(minimum, 'the module must declare its minimum Go version');
  assert.ok(toolchain, 'CI must select an explicit Go toolchain');
  const version = (match) => match.slice(1).map(Number);
  const minimumVersion = version(minimum);
  const toolchainVersion = version(toolchain);
  const firstDifference = minimumVersion.findIndex((part, index) => part !== toolchainVersion[index]);
  assert.ok(firstDifference === -1 || minimumVersion[firstDifference] < toolchainVersion[firstDifference],
    'the pinned toolchain cannot run a module requiring a newer Go version');
  for (const dockerfile of dockerfiles) {
    assert.match(dockerfile, new RegExp(`golang:${toolchain[1]}\\.${toolchain[2]}(?:[.-])`),
      'container builds must use the same Go release line as CI');
  }
});

function goQualityGateBlock(contents) {
  const match = contents.match(
    /\n  go-quality-gate:\n(?<body>[\s\S]*?)\n  quality-gate:\n/,
  );
  assert.ok(match?.groups?.body, 'go-quality-gate job is missing from CI workflow');
  return match.groups.body;
}

test('Go CI provisions and verifies the native CGO toolchain before make verify', () => {
  const job = goQualityGateBlock(workflow);
  const nativeStep = job.indexOf('- name: Provision Go native dependencies');
  const qualityGate = job.indexOf('- name: Run Go quality gate');

  assert.notEqual(nativeStep, -1, 'native dependency step is missing');
  assert.notEqual(qualityGate, -1, 'Go quality gate step is missing');
  assert.ok(nativeStep < qualityGate, 'native dependencies must be ready before make verify');
  assert.match(job.slice(qualityGate), /run: make verify/);
  assert.match(job, /CGO_ENABLED:\s*["']?1["']?/);
  assert.match(job, /CC:\s*gcc/);

  const nativeSection = job.slice(nativeStep, qualityGate);
  assert.match(nativeSection, /sudo apt-get update/);
  assert.match(nativeSection, /sudo apt-get install[^\n]*\bgcc\b/);
  assert.match(nativeSection, /sudo apt-get install[^\n]*\blibvips-dev\b/);
  assert.match(nativeSection, /sudo apt-get install[^\n]*\bpkg-config\b/);
  assert.match(nativeSection, /command -v gcc/);
  assert.match(nativeSection, /command -v pkg-config/);
  assert.match(nativeSection, /pkg-config --exists vips/);
  assert.match(nativeSection, /test "\$\(go env CGO_ENABLED\)" = "1"/);
  assert.match(nativeSection, /go env CGO_ENABLED/);
  assert.match(nativeSection, /go version/);
  assert.match(nativeSection, /gcc --version/);
  assert.match(nativeSection, /pkg-config --modversion vips/);
});
