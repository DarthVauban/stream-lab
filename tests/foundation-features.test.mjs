import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { compressionProfile, listCompressionProfiles } from "../media-server/compression-profiles.mjs";
import { buildThumbnailArgs } from "../media-server/media-processor.mjs";
import { PlaylistStore } from "../media-server/playlist-store.mjs";
import { SettingsStore } from "../media-server/settings-store.mjs";
import { StorageMonitor } from "../media-server/storage-monitor.mjs";
import { VideoStore } from "../media-server/store.mjs";

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
  await settings.updateStream({ compressionProfile: "QUALITY" });
  const restored = new SettingsStore({ rootDir });
  await restored.init();
  assert.equal(restored.snapshot().compressionProfile, "QUALITY");
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
  assert.equal(args.at(-1), "C:/media/preview.jpg");

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
