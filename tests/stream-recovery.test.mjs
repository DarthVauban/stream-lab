import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  FfmpegProgressParser,
  StreamController,
} from "../media-server/stream-controller.mjs";
import { EncryptedStreamStateStore } from "../media-server/stream-state-store.mjs";

class FakeChild extends EventEmitter {
  constructor(pid, role, args) {
    super();
    this.pid = pid;
    this.role = role;
    this.args = args;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill(signal) {
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

function controllerHarness({ persisted = null, now, saveActiveImpl = null } = {}) {
  const children = [];
  const uplinks = [];
  const playouts = [];
  const persistedWrites = [];
  let clears = 0;
  let queue = [];
  let fallback = null;
  const stateStore = {
    async load() {
      return persisted;
    },
    async saveActive(value) {
      persistedWrites.push(value);
      await saveActiveImpl?.(value, persistedWrites.length);
    },
    async clear() {
      clears += 1;
    },
  };
  const controller = new StreamController({
    spawnImpl(_command, args) {
      const role = args.includes("flv") ? "uplink" : "playout";
      const child = new FakeChild(1000 + children.length, role, args);
      children.push(child);
      (role === "uplink" ? uplinks : playouts).push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    spawnSyncImpl() {
      return { status: 0, stdout: "ffmpeg test" };
    },
    stateStore,
    ...(now ? { now } : {}),
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    stableRunMs: 50,
  });
  const init = () => controller.init({
    resolveVideo: (videoId) => queue.find((item) => item.id === videoId),
    getQueue: () => queue,
    getFallback: () => fallback,
  });
  return {
    controller,
    children,
    uplinks,
    playouts,
    persistedWrites,
    clearCount: () => clears,
    setQueue(value) {
      queue = value;
    },
    setFallback(value) {
      fallback = value;
    },
    init,
  };
}

const firstVideo = {
  id: "video-1",
  name: "demo.mp4",
  filePath: "C:/media/demo.mp4",
  queueItemId: "queue-1",
  media: { durationSeconds: 10 },
};

const secondVideo = {
  id: "video-2",
  name: "next.mp4",
  filePath: "C:/media/next.mp4",
  queueItemId: "queue-2",
  media: { durationSeconds: 20 },
};

test("parses machine-readable FFmpeg uplink progress", () => {
  const parser = new FfmpegProgressParser({ now: () => Date.parse("2026-07-19T12:00:00.000Z") });
  assert.deepEqual(parser.push("frame=180\nfps=29.97\nbitrate=8192.5kbits/s\nout_time_us=6000000\n"), []);
  const [metrics] = parser.push("dup_frames=2\ndrop_frames=1\nspeed=0.998x\nprogress=continue\n");
  assert.deepEqual(metrics, {
    capturedAt: "2026-07-19T12:00:00.000Z",
    frame: 180,
    fps: 29.97,
    bitrateKbps: 8192.5,
    totalSizeBytes: null,
    outTimeMs: 6000,
    duplicateFrames: 2,
    droppedFrames: 1,
    speed: 0.998,
  });
});

test("encrypts persisted stream configuration and removes it on clear", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-state-test-"));
  const store = new EncryptedStreamStateStore({
    rootDir,
    secret: "streamlab-encryption-secret-32-characters",
  });
  const state = {
    videoId: "video-1",
    videoIds: ["video-1"],
    queueItemIds: ["queue-1"],
    target: "rtmps://example.test/live/super-secret-key",
    streamKey: "super-secret-key",
    startedAt: "2026-07-19T00:00:00.000Z",
    videoBitrateKbps: 7_500,
  };

  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await store.saveActive(state);
  const raw = await readFile(path.join(rootDir, "stream-state.enc.json"), "utf8");
  assert.doesNotMatch(raw, /super-secret-key/);
  const wrongKeyStore = new EncryptedStreamStateStore({
    rootDir,
    secret: "different-encryption-secret-32-characters",
  });
  await assert.rejects(() => wrongKeyStore.load(), /STREAM_CONFIG_SECRET/);
  assert.deepEqual(await store.load(), state);
  await store.clear();
  assert.equal(await store.load(), null);
});

test("keeps one uplink while the live queue advances and changes", async (t) => {
  let currentTime = 1_000;
  const harness = controllerHarness({ now: () => currentTime });
  harness.setQueue([firstVideo, secondVideo]);
  await harness.init();
  t.after(() => harness.controller.stop());

  const target = "rtmps://example.test/live/super-secret-key";
  await harness.controller.start({
    target,
    streamKey: "super-secret-key",
    videoBitrateKbps: 7_500,
  });
  assert.equal(harness.uplinks.length, 1);
  assert.equal(harness.playouts.length, 1);
  assert.equal(harness.playouts[0].args[harness.playouts[0].args.indexOf("-i") + 1], firstVideo.filePath);
  assert.ok(harness.uplinks[0].args.includes("7500k"));
  assert.equal(harness.uplinks[0].args[harness.uplinks[0].args.indexOf("-progress") + 1], "pipe:1");
  assert.equal(harness.persistedWrites[0].videoId, firstVideo.id);

  harness.uplinks[0].stderr.write(`frame=1 ${target}\n`);
  harness.uplinks[0].stdout.write(
    "frame=1\nfps=30.00\nbitrate=7692.0kbits/s\nout_time_us=1000000\ndup_frames=0\ndrop_frames=0\nspeed=1.00x\nprogress=continue\n",
  );
  await delay(0);
  assert.equal(harness.controller.snapshot().status, "LIVE");
  assert.equal(harness.controller.snapshot().outputMetrics.bitrateKbps, 7692);
  assert.doesNotMatch(JSON.stringify(harness.controller.snapshot()), /super-secret-key/);

  const relayed = [];
  harness.uplinks[0].stdin.on("data", (chunk) => relayed.push(chunk));
  harness.playouts[0].stdout.write(Buffer.from("lossless-local-mpegts"));
  await delay(0);
  assert.equal(Buffer.concat(relayed).toString(), "lossless-local-mpegts");

  const thirdVideo = {
    id: "video-3",
    name: "inserted.mp4",
    filePath: "C:/media/inserted.mp4",
    queueItemId: "queue-3",
    media: { durationSeconds: 15 },
  };
  harness.setQueue([firstVideo, thirdVideo, secondVideo]);
  currentTime += 10_000;
  harness.playouts[0].emit("exit", 0, null);
  await delay(0);
  await delay(0);

  assert.equal(harness.uplinks.length, 1);
  assert.equal(harness.playouts.length, 2);
  assert.equal(harness.controller.snapshot().videoId, thirdVideo.id);
  assert.equal(harness.controller.snapshot().queueItemId, thirdVideo.queueItemId);
  assert.equal(harness.playouts[1].args[harness.playouts[1].args.indexOf("-i") + 1], thirdVideo.filePath);
  assert.equal(harness.playouts[1].args[harness.playouts[1].args.indexOf("-output_ts_offset") + 1], "10.000");
  assert.equal(harness.playouts[1].args.at(-1), "pipe:1");
  assert.equal(harness.uplinks[0].args[harness.uplinks[0].args.indexOf("-i") + 1], "pipe:0");
});

test("starts the next playout before slow state persistence completes", async (t) => {
  let releaseSave;
  const blockedSave = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const harness = controllerHarness({
    saveActiveImpl: async (_value, writeNumber) => {
      if (writeNumber === 2) await blockedSave;
    },
  });
  harness.setQueue([firstVideo, secondVideo]);
  await harness.init();
  t.after(() => harness.controller.stop());
  await harness.controller.start({
    target: "rtmps://example.test/live/persistence-key",
    streamKey: "persistence-key",
  });

  harness.playouts[0].emit("exit", 0, null);
  await delay(0);
  await delay(0);
  assert.equal(harness.playouts.length, 2);
  assert.equal(harness.controller.snapshot().videoId, secondVideo.id);

  releaseSave();
  await delay(0);
});

test("skips the current video without restarting the uplink", async (t) => {
  const harness = controllerHarness();
  harness.setQueue([firstVideo, secondVideo]);
  await harness.init();
  t.after(() => harness.controller.stop());
  await harness.controller.start({
    target: "rtmps://example.test/live/skip-key",
    streamKey: "skip-key",
  });

  await harness.controller.skip();
  await delay(0);
  assert.equal(harness.uplinks.length, 1);
  assert.equal(harness.playouts.length, 2);
  assert.equal(harness.controller.snapshot().videoId, secondVideo.id);
  assert.equal(harness.controller.snapshot().history.at(-1).status, "SKIPPED");
});

test("reconnects only the uplink after a network failure", async (t) => {
  const harness = controllerHarness();
  harness.setQueue([firstVideo]);
  await harness.init();
  t.after(() => harness.controller.stop());
  await harness.controller.start({
    target: "rtmps://example.test/live/reconnect-key",
    streamKey: "reconnect-key",
  });
  const originalPlayout = harness.playouts[0];

  harness.uplinks[0].emit("exit", 1, null);
  assert.equal(harness.controller.snapshot().status, "RECONNECTING");
  await delay(15);
  assert.equal(harness.uplinks.length, 2);
  assert.equal(harness.playouts.length, 1);
  assert.equal(harness.playouts[0], originalPlayout);
});

test("uses and loops the fallback when the regular queue is empty", async (t) => {
  const harness = controllerHarness();
  harness.setFallback({ ...firstVideo, queueItemId: undefined, isFallback: true });
  await harness.init();
  t.after(() => harness.controller.stop());
  await harness.controller.start({
    target: "rtmps://example.test/live/fallback-key",
    streamKey: "fallback-key",
  });
  assert.equal(harness.controller.snapshot().isFallback, true);

  harness.playouts[0].emit("exit", 0, null);
  await delay(0);
  await delay(0);
  assert.equal(harness.playouts.length, 2);
  assert.equal(harness.controller.snapshot().videoId, firstVideo.id);
  assert.equal(harness.controller.snapshot().isFallback, true);
});

test("switches to fallback after a playout failure", async (t) => {
  const harness = controllerHarness();
  const fallback = {
    id: "video-fallback",
    name: "fallback.mp4",
    filePath: "C:/media/fallback.mp4",
    media: { durationSeconds: 30 },
    isFallback: true,
  };
  harness.setQueue([firstVideo, secondVideo]);
  harness.setFallback(fallback);
  await harness.init();
  t.after(() => harness.controller.stop());
  await harness.controller.start({
    target: "rtmps://example.test/live/fallback-error-key",
    streamKey: "fallback-error-key",
  });

  harness.playouts[0].emit("exit", 1, null);
  await delay(0);
  await delay(0);
  assert.equal(harness.controller.snapshot().videoId, fallback.id);
  assert.equal(harness.controller.snapshot().isFallback, true);
  assert.equal(harness.controller.snapshot().status, "DEGRADED");
});

test("restores both the uplink and current playout after service restart", async () => {
  const persisted = {
    videoId: firstVideo.id,
    videoIds: [firstVideo.id],
    queueItemIds: [firstVideo.queueItemId],
    target: "rtmps://example.test/live/persisted-key",
    streamKey: "persisted-key",
    startedAt: "2026-07-19T00:00:00.000Z",
    videoBitrateKbps: 6_500,
  };
  const harness = controllerHarness({ persisted });
  harness.setQueue([firstVideo, secondVideo]);

  await harness.init();
  const restored = harness.controller.snapshot();
  assert.equal(restored.status, "RECONNECTING");
  assert.equal(restored.restoredAfterRestart, true);
  assert.equal(restored.autoResumeEnabled, true);
  assert.equal(restored.videoBitrateKbps, 6_500);
  assert.equal(harness.uplinks.length, 1);
  assert.equal(harness.playouts.length, 1);

  await harness.controller.shutdown();
  assert.equal(harness.clearCount(), 0);
});
