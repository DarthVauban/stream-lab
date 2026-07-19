import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { StreamController } from "../media-server/stream-controller.mjs";
import { EncryptedStreamStateStore } from "../media-server/stream-state-store.mjs";

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stderr = new PassThrough();
  }

  kill(signal) {
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

function controllerHarness({ persisted = null, playlistPath = null, now } = {}) {
  const children = [];
  const persistedWrites = [];
  let clears = 0;
  const stateStore = {
    async load() {
      return persisted;
    },
    async saveActive(value) {
      persistedWrites.push(value);
    },
    async clear() {
      clears += 1;
    },
  };
  const controller = new StreamController({
    spawnImpl() {
      const child = new FakeChild(1000 + children.length);
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    spawnSyncImpl() {
      return { status: 0, stdout: "ffmpeg test" };
    },
    stateStore,
    playlistPath,
    ...(now ? { now } : {}),
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    stableRunMs: 50,
  });
  return {
    controller,
    children,
    persistedWrites,
    clearCount: () => clears,
  };
}

const video = {
  id: "video-1",
  name: "demo.mp4",
  filePath: "C:/media/demo.mp4",
};

test("encrypts persisted stream configuration and removes it on clear", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-state-test-"));
  const store = new EncryptedStreamStateStore({
    rootDir,
    secret: "streamlab-encryption-secret-32-characters",
  });
  const state = {
    videoId: "video-1",
    target: "rtmps://example.test/live/super-secret-key",
    streamKey: "super-secret-key",
    startedAt: "2026-07-19T00:00:00.000Z",
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

test("reconnects FFmpeg after a crash and manual stop cancels recovery", async () => {
  const harness = controllerHarness();
  const target = "rtmps://example.test/live/super-secret-key";
  await harness.controller.start({ video, target, streamKey: "super-secret-key" });
  assert.equal(harness.persistedWrites.length, 1);
  assert.equal(harness.controller.snapshot().autoResumeEnabled, true);

  harness.children[0].stderr.write(`frame=1 ${target}\n`);
  await delay(0);
  assert.equal(harness.controller.snapshot().status, "LIVE");
  assert.doesNotMatch(JSON.stringify(harness.controller.snapshot()), /super-secret-key/);

  harness.children[0].emit("exit", 1, null);
  assert.equal(harness.controller.snapshot().status, "RECONNECTING");
  assert.equal(harness.controller.snapshot().reconnectAttempt, 1);

  await delay(15);
  assert.equal(harness.children.length, 2);
  harness.children[1].stderr.write("frame=2\n");
  await delay(0);
  assert.equal(harness.controller.snapshot().status, "LIVE");

  await harness.controller.stop();
  assert.equal(harness.clearCount(), 1);
  assert.equal(harness.controller.snapshot().status, "STOPPED");
  assert.equal(harness.controller.snapshot().autoResumeEnabled, false);
  await delay(20);
  assert.equal(harness.children.length, 2);
});

test("plays every queued video in order and reports the current queue item", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-playlist-test-"));
  const playlistPath = path.join(rootDir, "stream-playlist.ffconcat");
  let currentTime = 1_000;
  const harness = controllerHarness({ playlistPath, now: () => currentTime });
  const first = {
    ...video,
    queueItemId: "queue-1",
    media: { durationSeconds: 10 },
  };
  const second = {
    id: "video-2",
    name: "next.mp4",
    filePath: "C:/media/next.mp4",
    queueItemId: "queue-2",
    media: { durationSeconds: 20 },
  };
  t.after(async () => {
    await harness.controller.stop();
    await rm(rootDir, { recursive: true, force: true });
  });

  await harness.controller.start({
    videos: [first, second],
    target: "rtmps://example.test/live/playlist-key",
    streamKey: "playlist-key",
  });
  const playlist = await readFile(playlistPath, "utf8");
  assert.match(playlist, /demo\.mp4[\s\S]+next\.mp4/);
  assert.equal(harness.persistedWrites[0].videoIds.length, 2);
  assert.deepEqual(harness.persistedWrites[0].queueItemIds, ["queue-1", "queue-2"]);
  assert.equal(harness.controller.snapshot().queueItemId, "queue-1");

  currentTime += 11_000;
  assert.equal(harness.controller.snapshot().videoId, "video-2");
  assert.equal(harness.controller.snapshot().queueItemId, "queue-2");

  currentTime += 20_000;
  assert.equal(harness.controller.snapshot().videoId, "video-1");
  assert.equal(harness.controller.snapshot().queueItemId, "queue-1");
});

test("restores the desired stream after service restart without clearing encrypted state", async () => {
  const persisted = {
    videoId: video.id,
    target: "rtmps://example.test/live/persisted-key",
    streamKey: "persisted-key",
    startedAt: "2026-07-19T00:00:00.000Z",
  };
  const harness = controllerHarness({ persisted });

  await harness.controller.init({ resolveVideo: () => video });
  const restored = harness.controller.snapshot();
  assert.equal(restored.status, "RECONNECTING");
  assert.equal(restored.restoredAfterRestart, true);
  assert.equal(restored.autoResumeEnabled, true);
  assert.equal(harness.children.length, 1);

  await harness.controller.shutdown();
  assert.equal(harness.clearCount(), 0);
});
