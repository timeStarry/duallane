import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { spawnOwnedProcess, stopOwnedProcess, waitForExit } from "../../e2e/support/owned-process.mjs";

test("bounded shutdown escalates an owned process that ignores TERM", { timeout: 5_000 }, async (t) => {
  const child = spawnOwnedProcess(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); process.send("ready"); setInterval(()=>{},1000)'], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => stopOwnedProcess(child, 20));
  await once(child, "message");
  const started = performance.now();
  await stopOwnedProcess(child, 50);
  assert.ok(performance.now() - started < 2_000);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  const result = await waitForExit(child);
  assert.equal(result.signal, child.signalCode);
});

test("exit observed before waiting does not hang shutdown", { timeout: 5_000 }, async () => {
  const child = spawnOwnedProcess(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.equal((await waitForExit(child)).code, 0);
  assert.equal((await waitForExit(child)).code, 0);
  await stopOwnedProcess(child, 20);
});

test("spawn failures and unowned process objects are safe", { timeout: 5_000 }, async () => {
  const child = spawnOwnedProcess("/nonexistent-duallane-synthetic-binary", [], { stdio: "ignore" });
  assert.equal((await waitForExit(child)).code, 1);
  await assert.rejects(stopOwnedProcess({ pid: process.pid }), /not owned/);
});
