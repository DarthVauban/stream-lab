import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SoakTestService } from "../media-server/soak-test-service.mjs";

test("persists and completes a soak test only after all required scenarios were observed", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-soak-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let now = Date.parse("2026-07-20T00:00:00.000Z");
  const snapshot = {
    stream: { status: "LIVE", videoId: "video-1", isFallback: false },
    system: { memory: { processRssBytes: 100_000_000, processHeapUsedBytes: 20_000_000 } },
    database: { configured: true, connected: true },
    realtime: { configured: true, connected: true },
    monitoring: { events: [] },
    promos: { campaigns: [{ impressions: 2 }] },
    telegram: { webhook: { lastCommandAt: null } },
  };
  const service = new SoakTestService({
    rootDir,
    getSnapshot: async () => structuredClone(snapshot),
    now: () => now,
    intervalMs: 1_000,
    minimumDurationHours: 0.001,
  });
  t.after(() => service.close());
  await service.init();
  await service.start({ durationHours: 0.001 });

  snapshot.stream = { status: "LIVE", videoId: "fallback", isFallback: true };
  snapshot.monitoring.events = [
    { id: "video", type: "VIDEO_CHANGED", occurredAt: new Date(now + 100).toISOString() },
    { id: "lost", type: "UPLINK_RECONNECTING", occurredAt: new Date(now + 200).toISOString() },
    { id: "back", type: "UPLINK_RECOVERED", occurredAt: new Date(now + 300).toISOString() },
  ];
  snapshot.promos.campaigns[0].impressions = 3;
  snapshot.telegram.webhook.lastCommandAt = new Date(now + 400).toISOString();
  for (let index = 0; index < 4; index += 1) {
    now += 1_000;
    await service.capture();
  }

  const completed = service.snapshot().current;
  assert.equal(completed.status, "PASSED");
  assert.equal(completed.result.passed, true);
  assert.equal(completed.coverage.videoTransitions, 1);
  assert.equal(completed.coverage.fallbackObserved, true);
  assert.equal(completed.coverage.reconnectRecoveries, 1);
  assert.equal(completed.coverage.promoImpressions, 1);
  assert.equal(completed.coverage.telegramCommands, 1);

  const restored = new SoakTestService({
    rootDir,
    getSnapshot: async () => structuredClone(snapshot),
    now: () => now,
    intervalMs: 1_000,
    minimumDurationHours: 0.001,
  });
  await restored.init();
  assert.equal(restored.snapshot().current.status, "PASSED");
  assert.equal(restored.snapshot().history.length, 1);
  await restored.close();
});

test("requires an active stream and at least the production duration", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-soak-invalid-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const service = new SoakTestService({
    rootDir,
    getSnapshot: async () => ({ stream: { status: "STOPPED" } }),
    minimumDurationHours: 72,
  });
  t.after(() => service.close());
  await service.init();
  await assert.rejects(() => service.start({ durationHours: 24 }), /72/);
  await assert.rejects(() => service.start({ durationHours: 72 }), /запустіть трансляцію/);
});

test("counts missed samples as downtime", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-soak-gap-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let now = Date.parse("2026-07-20T00:00:00.000Z");
  const service = new SoakTestService({
    rootDir,
    getSnapshot: async () => ({
      stream: { status: "LIVE" },
      system: { memory: { processRssBytes: 100_000_000 } },
      database: { configured: true, connected: true },
      realtime: { configured: true, connected: true },
      monitoring: { status: "STABLE", events: [] },
      promos: { campaigns: [] },
      telegram: { webhook: {} },
    }),
    now: () => now,
    intervalMs: 1_000,
    minimumDurationHours: 0.001,
  });
  t.after(() => service.close());
  await service.init();
  await service.start({
    durationHours: 0.001,
    requirements: { videoTransition: false, fallback: false, reconnect: false, promo: false, telegram: false },
  });
  now += 4_000;
  await service.capture();

  const completed = service.snapshot().current;
  assert.equal(completed.status, "FAILED");
  assert.ok(completed.result.availabilityPercent < 99.5);
  assert.equal(completed.result.checks.find((check) => check.id === "sample-continuity").passed, false);
});
