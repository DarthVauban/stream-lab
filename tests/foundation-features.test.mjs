import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { compressionProfile, listCompressionProfiles } from "../media-server/compression-profiles.mjs";
import { buildThumbnailArgs, normalizeThumbnailPosition } from "../media-server/media-processor.mjs";
import { PlaylistStore } from "../media-server/playlist-store.mjs";
import { SettingsStore } from "../media-server/settings-store.mjs";
import { StorageMonitor } from "../media-server/storage-monitor.mjs";
import { VideoStore } from "../media-server/store.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("resumes an interrupted upload by stable browser fingerprint", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-resume-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new VideoStore({ rootDir });
  await store.init();
  const input = {
    name: "resume.mp4",
    size: 12,
    mimeType: "video/mp4",
    fingerprint: "resume.mp4:12:123456789",
    compressionProfile: "ECONOMY",
  };
  const created = await store.createUpload(input);
  await store.appendChunk(created.id, 0, Readable.from(Buffer.from("first")));
  const resumed = await store.createUpload(input);
  assert.equal(resumed.id, created.id);
  assert.equal(resumed.uploadedBytes, 5);
  assert.equal(resumed.compressionProfile, "ECONOMY");
  assert.equal(store.listActiveUploads().length, 1);
  await store.cancelUpload(created.id);
  assert.equal(store.listActiveUploads().length, 0);
});

test("writes multiple uploads concurrently and verifies every checksum", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-parallel-upload-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new VideoStore({ rootDir });
  await store.init();
  const firstData = Buffer.from("first parallel payload");
  const secondData = Buffer.from("second parallel payload");
  const [first, second] = await Promise.all([
    store.createUpload({ name: "first.mp4", size: firstData.length, checksumSha256: sha256(firstData) }),
    store.createUpload({ name: "second.mp4", size: secondData.length, checksumSha256: sha256(secondData) }),
  ]);

  await Promise.all([
    store.appendChunk(first.id, 0, Readable.from(firstData), { checksumSha256: sha256(firstData) }),
    store.appendChunk(second.id, 0, Readable.from(secondData), { checksumSha256: sha256(secondData) }),
  ]);
  const completed = await Promise.all([store.completeUpload(first.id), store.completeUpload(second.id)]);
  assert.deepEqual(completed.map((video) => video.integrityVerified), [true, true]);
  assert.deepEqual(completed.map((video) => video.checksumSha256), [sha256(firstData), sha256(secondData)]);
});

test("keeps the upload offset unchanged when a chunk checksum is invalid", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-invalid-checksum-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new VideoStore({ rootDir });
  await store.init();
  const data = Buffer.from("checksum payload");
  const upload = await store.createUpload({ name: "checksum.mp4", size: data.length });
  await assert.rejects(
    store.appendChunk(upload.id, 0, Readable.from(data), { checksumSha256: "0".repeat(64) }),
    /Checksum блоку не збігається/,
  );
  assert.equal(store.listActiveUploads()[0].uploadedBytes, 0);
  await store.appendChunk(upload.id, 0, Readable.from(data), { checksumSha256: sha256(data) });
  assert.equal(store.listActiveUploads()[0].uploadedBytes, data.length);
});

test("acknowledges upload chunks without waiting for a slow progress checkpoint", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-upload-checkpoint-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let currentTime = 0;
  let blockWrites = false;
  let releaseWrite;
  let markWriteStarted;
  const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const repository = {
    readDocument: async () => null,
    writeDocument: async () => {
      if (!blockWrites) return;
      markWriteStarted();
      await writeGate;
    },
  };
  const store = new VideoStore({
    rootDir,
    repository,
    now: () => currentTime,
    progressPersistIntervalMs: 5_000,
  });
  await store.init();
  const upload = await store.createUpload({ name: "fast.mp4", size: 2 });
  currentTime = 6_000;
  blockWrites = true;

  const appended = store.appendChunk(upload.id, 0, Readable.from(Buffer.from("a")), {
    checksumSha256: sha256(Buffer.from("a")),
  });
  const result = await Promise.race([
    appended,
    new Promise((_, reject) => setTimeout(() => reject(new Error("chunk acknowledgement was blocked")), 250)),
  ]);
  assert.equal(result.uploadedBytes, 1);
  await writeStarted;
  releaseWrite();
  await store.persistQueue;
  blockWrites = false;
  await store.cancelUpload(upload.id);
});

test("recovers non-checkpointed upload progress from the partial file", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-upload-recovery-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let saved = null;
  const repository = {
    readDocument: async () => saved,
    writeDocument: async (_key, payload) => { saved = structuredClone(payload); },
  };
  const firstStore = new VideoStore({ rootDir, repository, now: () => 0 });
  await firstStore.init();
  const upload = await firstStore.createUpload({
    name: "recover.mp4",
    size: 3,
    fingerprint: "recover.mp4:3:1",
  });
  await firstStore.appendChunk(upload.id, 0, Readable.from(Buffer.from("ab")), {
    checksumSha256: sha256(Buffer.from("ab")),
  });
  assert.equal(saved.records[0].uploadedBytes, 0);

  const restoredStore = new VideoStore({ rootDir, repository, now: () => 0 });
  await restoredStore.init();
  assert.equal(restoredStore.listActiveUploads()[0].uploadedBytes, 2);
  await restoredStore.cancelUpload(upload.id);
});

test("pauses an in-flight chunk before allowing the upload to resume", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-active-pause-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new VideoStore({ rootDir });
  await store.init();
  const data = Buffer.from("active chunk payload");
  const upload = await store.createUpload({ name: "pause.mp4", size: data.length });
  let markStarted;
  let releaseChunk;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const release = new Promise((resolve) => { releaseChunk = resolve; });
  const readable = Readable.from((async function* chunks() {
    markStarted();
    yield data.subarray(0, 6);
    await release;
    yield data.subarray(6);
  })());
  const append = store.appendChunk(upload.id, 0, readable);
  await started;
  const pause = store.pauseUpload(upload.id);
  setTimeout(releaseChunk, 20);
  await assert.rejects(append, /призупинено/);
  const paused = await pause;
  assert.equal(paused.uploadState, "PAUSED");
  assert.equal(paused.uploadedBytes, 0);
  await store.resumeUpload(upload.id);
  await store.appendChunk(upload.id, 0, Readable.from(data), { checksumSha256: sha256(data) });
  assert.equal(store.listActiveUploads()[0].uploadedBytes, data.length);
});

test("creates, reorders and restores named playlists", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-playlist-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new PlaylistStore({ rootDir });
  await store.init();
  const playlist = await store.create("Night rotation");
  const first = await store.addItem(playlist.id, "video-a");
  const second = await store.addItem(playlist.id, "video-b");
  await store.reorder(playlist.id, [second.id, first.id]);

  const restored = new PlaylistStore({ rootDir });
  await restored.init();
  assert.equal(restored.list()[0].name, "Night rotation");
  assert.deepEqual(restored.list()[0].items.map((item) => item.videoId), ["video-b", "video-a"]);
  await restored.removeVideo("video-b");
  assert.deepEqual(restored.list()[0].items.map((item) => item.videoId), ["video-a"]);
});

test("persists the selected compression profile", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-profile-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const settings = new SettingsStore({ rootDir });
  await settings.init();
  await settings.updateStream({ compressionProfile: "QUALITY", encoderMode: "CPU" });
  const restored = new SettingsStore({ rootDir });
  await restored.init();
  assert.equal(restored.snapshot().compressionProfile, "QUALITY");
  assert.equal(restored.snapshot().encoderMode, "CPU");
  assert.equal(compressionProfile("QUALITY").videoBitrate, "8M");
  assert.equal(listCompressionProfiles().length, 3);
});

test("builds a bounded thumbnail command and reports disk thresholds", async () => {
  const args = buildThumbnailArgs({
    inputPath: "C:/media/prepared.mp4",
    outputPath: "C:/media/preview.jpg",
    durationSeconds: 200,
  });
  assert.equal(args[args.indexOf("-ss") + 1], "10.000");
  assert.equal(
    args[args.indexOf("-vf") + 1],
    "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2",
  );
  assert.equal(args.at(-1), "C:/media/preview.jpg");
  assert.equal(normalizeThumbnailPosition(42.5, 200), 42.5);
  assert.throws(() => normalizeThumbnailPosition(201, 200), /Оберіть момент/);

  const monitor = new StorageMonitor({
    path: "C:/media",
    warningPercent: 70,
    criticalPercent: 90,
    statfsImpl: async () => ({ blocks: 100n, bavail: 8n, bsize: 1n }),
  });
  const status = await monitor.snapshot();
  assert.equal(status.percentUsed, 92);
  assert.equal(status.level, "CRITICAL");
  assert.equal(status.freeBytes, 8);
});
