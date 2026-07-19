import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MonitoringService, evaluateStreamHealth } from "../media-server/monitoring-service.mjs";
import { MonitoringStore } from "../media-server/monitoring-store.mjs";

test("classifies stable, buffering-risk and critical uplink states", () => {
  const now = Date.parse("2026-07-19T12:00:00.000Z");
  const base = {
    status: "LIVE",
    startedAt: new Date(now - 60_000).toISOString(),
    videoBitrateKbps: 8_000,
    outputMetrics: {
      capturedAt: new Date(now - 1_000).toISOString(),
      bitrateKbps: 8_150,
      fps: 30,
      speed: 1,
      droppedFrames: 0,
    },
  };
  assert.equal(evaluateStreamHealth({ stream: base, now }).status, "STABLE");
  assert.equal(
    evaluateStreamHealth({
      stream: {
        ...base,
        outputMetrics: { ...base.outputMetrics, bitrateKbps: null, fps: null, speed: null },
      },
      now,
    }).status,
    "STABLE",
  );
  assert.equal(
    evaluateStreamHealth({
      stream: { ...base, outputMetrics: { ...base.outputMetrics, speed: 0.95 } },
      now,
    }).status,
    "BUFFERING_RISK",
  );
  assert.equal(
    evaluateStreamHealth({ stream: { ...base, status: "RECONNECTING" }, now }).status,
    "CRITICAL",
  );
});

test("persists monitoring history and stream transition events", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-monitoring-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let now = Date.parse("2026-07-19T12:00:00.000Z");
  let stream = {
    status: "STOPPED",
    startedAt: null,
    videoBitrateKbps: 8_000,
    outputMetrics: null,
  };
  const controller = { snapshot: () => ({ ...stream }) };
  const youtube = {
    snapshot: () => ({
      connected: true,
      stream: { healthStatus: "good", configurationIssues: [] },
      metrics: { viewers: 3 },
    }),
  };
  const store = new MonitoringStore({ rootDir, now: () => now });
  const monitoring = new MonitoringService({
    controller,
    youtube,
    store,
    now: () => now,
    sampleIntervalMs: 1,
  });
  await monitoring.init();

  now += 60_000;
  stream = {
    status: "LIVE",
    startedAt: new Date(now).toISOString(),
    videoId: "video-1",
    videoName: "demo.mp4",
    videoBitrateKbps: 8_000,
    outputMetrics: {
      capturedAt: new Date(now).toISOString(),
      bitrateKbps: 8_100,
      fps: 30,
      speed: 1,
      droppedFrames: 0,
      duplicateFrames: 0,
    },
  };
  await monitoring.capture({ forceSample: true });

  now += 60_000;
  stream = { ...stream, status: "RECONNECTING", reconnectAttempt: 1, outputMetrics: null };
  await monitoring.capture({ forceSample: true });

  now += 60_000;
  stream = {
    ...stream,
    status: "LIVE",
    outputMetrics: {
      capturedAt: new Date(now).toISOString(),
      bitrateKbps: 8_050,
      fps: 30,
      speed: 1,
      droppedFrames: 0,
      duplicateFrames: 0,
    },
  };
  await monitoring.capture({ forceSample: true });

  const snapshot = monitoring.snapshot({ hours: 1 });
  assert.equal(snapshot.status, "STABLE");
  assert.equal(snapshot.session.restarts, 1);
  assert.equal(snapshot.session.peakViewers, 3);
  assert.ok(snapshot.history.length >= 3);
  assert.ok(snapshot.events.some((event) => event.type === "STREAM_STARTED"));
  assert.ok(snapshot.events.some((event) => event.type === "UPLINK_RECONNECTING"));
  assert.ok(snapshot.events.some((event) => event.type === "UPLINK_RECOVERED"));

  const raw = JSON.parse(await readFile(path.join(rootDir, "monitoring.json"), "utf8"));
  assert.equal(raw.counters.streamStarts, 1);
  assert.equal(raw.counters.uplinkRestarts, 1);
  assert.equal(raw.samples[0].bitrateKbps, null);
});
