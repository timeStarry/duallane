import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../workflows/ci.yml', import.meta.url);
const workflow = (await readFile(workflowPath, 'utf8')).replace(/\r\n?/g, '\n');

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
