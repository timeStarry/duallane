import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = (await readFile(new URL('../workflows/ci.yml', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
const fixtureStep = workflow.split(/(?=^      - name: )/m)
  .find((step) => step.startsWith('      - name: Verify Node persisted backend contracts'));

const expectedFixtureCommands = [
  'node scripts/backend/echo-requirement-fixtures.mjs --check',
  'node scripts/backend/echo-release-fixtures.mjs --check',
  'node scripts/backend/echo-solicitation-fixtures.mjs --check',
  'node scripts/backend/echo-automation-fixtures.mjs --check',
  'node scripts/backend/echo-parser-fixtures.mjs --check',
  'node scripts/backend/echo-card-fixtures.mjs',
  'node scripts/backend/bot-idempotency-fixtures.mjs',
  'node scripts/backend/bot-message-dto-fixtures.mjs',
  'node scripts/backend/bot-websocket-fixtures.mjs',
  'node scripts/backend/bot-connection-fixtures.mjs',
  'node scripts/backend/bot-contract-fixtures.mjs',
  'node scripts/backend/bot-feishu-contract.mjs',
  'node scripts/backend/bot-feishu-fallback-fixtures.mjs',
  'node scripts/backend/feishu-card-converter-golden.mjs',
  'node scripts/backend/feishu-card-action-golden.mjs',
  'node scripts/backend/route-inventory.mjs --check',
  'node scripts/backend/workspace-core-contract.mjs --check',
  'node scripts/backend/workspace-emotes-contract.mjs --check',
  'node scripts/backend/workspace-files-contract.mjs --check',
  'node scripts/backend/workspace-invites-contract.mjs --check',
  'node scripts/backend/workspace-notifications-null-fixtures.mjs',
  'node scripts/backend/workspace-notifications-contract.mjs --check',
  'node scripts/backend/topic-parser-fixtures.mjs',
  'node scripts/backend/topic-card-fixtures.mjs'
];

test('only the Node unit step moves disposable SQLite fixtures to tmpfs', () => {
  const steps = workflow.split(/(?=^      - name: )/m);
  const usingTmpfs = steps.filter((step) => /TMPDIR: \/dev\/shm/.test(step));
  assert.equal(usingTmpfs.length, 1, 'tmpfs must remain scoped to a single unit-test step');
  assert.match(usingTmpfs[0], /^      - name: Run tests\n/);
  assert.match(usingTmpfs[0], /\n        env:\n          TMPDIR: \/dev\/shm\n/);
  assert.match(usingTmpfs[0], /\n        run: pnpm test\n/);
  assert.doesNotMatch(usingTmpfs[0], /testTimeout|--test-timeout|--retry|continue-on-error/);
});

test('Node fixture freshness runs every persisted contract with its real check interface', () => {
  assert.ok(fixtureStep, 'Node persisted backend contract step is missing');
  const commands = [...fixtureStep.matchAll(/^          (node scripts\/backend\/[^\n]+)$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(commands, expectedFixtureCommands);
});

test('schema coexistence rehearsal is an explicit PostgreSQL service step', () => {
  const start = workflow.indexOf('\n  go-quality-gate:');
  const end = workflow.indexOf('\n  quality-gate:');
  assert.ok(start >= 0 && end > start, 'Go quality job boundary is missing');
  const goQualityJob = workflow.slice(start, end);
  const schemaStep = goQualityJob.split(/(?=^      - name: )/m)
    .find((step) => step.startsWith('      - name: Rehearse Node and Go migration owners on PostgreSQL'));
  assert.ok(schemaStep, 'schema coexistence PostgreSQL step is missing from Go quality job');
  assert.match(goQualityJob, /services:\n      postgres:/);
  assert.match(schemaStep, /TEST_DATABASE_URL: postgres:\/\/duallane:duallane-ci-password@127\.0\.0\.1:5432\/duallane\?sslmode=disable/);
  assert.match(schemaStep, /DUALLANE_SCHEMA_COEXISTENCE_ALLOW_SCHEMA_CREATION: "true"/);
  assert.match(schemaStep, /DUALLANE_SCHEMA_COEXISTENCE_RUN_PG: "true"/);
  assert.match(schemaStep, /run: node --test scripts\/backend\/schema-coexistence\.test\.mjs/);
  assert.doesNotMatch(schemaStep, /go-workspace-browser|test:e2e:workspace-go/);
});
