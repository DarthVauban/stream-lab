import assert from "node:assert/strict";
import test from "node:test";
import { percentile, runLoadTest } from "../scripts/load-test.mjs";

test("calculates load-test percentiles", () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.95), 50);
});

test("produces a passing report for healthy read-only traffic", async () => {
  let clock = 0;
  const report = await runLoadTest({
    baseUrl: "https://stream.example.test",
    durationSeconds: 1,
    concurrency: 2,
    maxP95Ms: 100,
    now: () => {
      clock += 10;
      return clock;
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async arrayBuffer() { return new ArrayBuffer(0); },
    }),
  });
  assert.equal(report.passed, true);
  assert.equal(report.requests.errors, 0);
  assert.ok(report.requests.total > 0);
  assert.ok(report.latencyMs.p95 <= 100);
});
