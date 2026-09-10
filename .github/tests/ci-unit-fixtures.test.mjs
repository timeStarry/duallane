import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = (await readFile(new URL('../workflows/ci.yml', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
const fixtureStep = workflow.split(/(?=^      - name: )/m)
  .find((step) => step.startsWith('      - name: Verify frozen Node artifact provenance'));

test('only the Node unit step moves disposable SQLite fixtures to tmpfs', () => {
  const steps = workflow.split(/(?=^      - name: )/m);
  const usingTmpfs = steps.filter((step) => /TMPDIR: \/dev\/shm/.test(step));
  assert.equal(usingTmpfs.length, 1, 'tmpfs must remain scoped to a single unit-test step');
  assert.match(usingTmpfs[0], /^      - name: Run tests\n/);
  assert.match(usingTmpfs[0], /\n        env:\n          TMPDIR: \/dev\/shm\n/);
  assert.match(usingTmpfs[0], /\n        run: pnpm test\n/);
  assert.doesNotMatch(usingTmpfs[0], /testTimeout|--test-timeout|--retry|continue-on-error/);
});

test('frozen Node provenance is checked without invoking retired generators', () => {
  assert.ok(fixtureStep, 'frozen Node artifact provenance step is missing');
  assert.match(fixtureStep, /run: node --test \.github\/tests\/frozen-node-artifacts\.test\.mjs\n/);
  for (const retiredCommand of [
    'Rehearse Node and Go migration owners',
    'DUALLANE_SCHEMA_COEXISTENCE_RUN_PG',
    'media-compatibility',
    'workspace-files-legacy-contract.mjs',
    'workspace-emotes-legacy-contract.mjs',
    'workspace-files-legacy-parity',
    'workspace-emotes-legacy-parity',
    'storage-operator-contract.mjs',
    'storage-operator-backfill-contract.mjs',
    'route-inventory.mjs --check',
    'p2p-parity.mjs'
  ]) {
    assert.doesNotMatch(workflow, new RegExp(retiredCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('frozen Go P2P and legacy fixture gates are registered explicitly', () => {
  assert.match(workflow, /- name: Run frozen Go P2P contract\n        env:\n          CGO_ENABLED: "0"\n        run: node scripts\/backend\/p2p-frozen-contract\.mjs\n/);
  assert.match(workflow, /scripts\/backend\/p2p-frozen-contract\.test\.mjs/);
  assert.match(workflow, /scripts\/backend\/frozen-legacy-contract\.harness\.test\.mjs/);
  const workspaceStart = workflow.indexOf('\n  go-workspace-browser:');
  assert.ok(workspaceStart >= 0, 'Go Workspace browser job boundary is missing');
  const workspaceJob = workflow.slice(workspaceStart);
  assert.match(workspaceJob, /Run frozen Go legacy fixture gates/);
  assert.match(workspaceJob, /TEST_DATABASE_URL: postgres:\/\/duallane:duallane-ci-password@127\.0\.0\.1:5432\/duallane\?sslmode=disable/);
  assert.match(workspaceJob, /NODE_COMPAT_TEST_POSTGRES: "true"/);
  assert.match(workspaceJob, /node scripts\/backend\/frozen-legacy-contract\.test\.mjs --files/);
  assert.match(workspaceJob, /node scripts\/backend\/frozen-legacy-contract\.test\.mjs --emotes/);
  assert.match(workspaceJob, /node --test tools\/node-compat\/test\/database\.postgres\.test\.mjs/);
  assert.doesNotMatch(workspaceJob, /apps\/web\/server\/index\.mjs/);
});

test('Go migration quality remains independent of retired Node coexistence rehearsal', () => {
  const start = workflow.indexOf('\n  go-quality-gate:');
  const end = workflow.indexOf('\n  quality-gate:');
  assert.ok(start >= 0 && end > start, 'Go quality job boundary is missing');
  const goQualityJob = workflow.slice(start, end);
  assert.match(goQualityJob, /services:\n      postgres:/);
  assert.match(goQualityJob, /run: make verify/);
  assert.match(goQualityJob, /run: make integration-postgres/);
  assert.doesNotMatch(goQualityJob, /schema-coexistence|apps\/web\/server|Node and Go migration owners/);
});
