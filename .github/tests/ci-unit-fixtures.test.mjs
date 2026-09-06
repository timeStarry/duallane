import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = (await readFile(new URL('../workflows/ci.yml', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');

test('only the Node unit step moves disposable SQLite fixtures to tmpfs', () => {
  const steps = workflow.split(/(?=^      - name: )/m);
  const usingTmpfs = steps.filter((step) => /TMPDIR: \/dev\/shm/.test(step));
  assert.equal(usingTmpfs.length, 1, 'tmpfs must remain scoped to a single unit-test step');
  assert.match(usingTmpfs[0], /^      - name: Run tests\n/);
  assert.match(usingTmpfs[0], /\n        env:\n          TMPDIR: \/dev\/shm\n/);
  assert.match(usingTmpfs[0], /\n        run: pnpm test\n/);
  assert.doesNotMatch(usingTmpfs[0], /testTimeout|--test-timeout|--retry|continue-on-error/);
});
