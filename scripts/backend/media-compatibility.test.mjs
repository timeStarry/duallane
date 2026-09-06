import test from "node:test";
import assert from "node:assert/strict";
import { runMediaCompatibility } from "./media-compatibility.mjs";

test("Sharp and govips media compatibility corpus", async () => {
  const report = await runMediaCompatibility({ jsonOutput: false });
  assert.equal(report.summary.failures, 0, "media compatibility report contains mismatches");
  assert.ok(report.summary.accepted >= 10, "valid synthetic media cases were not exercised");
  assert.ok(report.summary.rejected >= 8, "invalid and over-limit cases were not exercised");
  assert.equal(report.summary.pixelChecks, report.summary.accepted, "every accepted output must receive a pixel comparison");
});
