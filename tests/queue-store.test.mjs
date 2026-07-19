import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { QueueStore } from "../media-server/queue-store.mjs";

test("persists queue order and restores it after restart", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-queue-test-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const queue = new QueueStore({ rootDir: dataDir });
  await queue.init();
  const first = await queue.add("video-1");
  const second = await queue.add("video-2");
  const third = await queue.add("video-3");
  assert.deepEqual(queue.snapshot().items.map((item) => item.videoId), [
    "video-1",
    "video-2",
    "video-3",
  ]);

  await queue.reorder([third.id, first.id, second.id]);
  await queue.moveNext(second.id);
  assert.deepEqual(queue.snapshot().items.map((item) => item.videoId), [
    "video-2",
    "video-3",
    "video-1",
  ]);

  const restored = new QueueStore({ rootDir: dataDir });
  await restored.init();
  assert.equal(restored.snapshot().mode, "LOOP_ALL");
  assert.deepEqual(restored.snapshot().items.map((item) => item.videoId), [
    "video-2",
    "video-3",
    "video-1",
  ]);

  await restored.remove(third.id);
  assert.deepEqual(restored.snapshot().items.map((item) => item.videoId), [
    "video-2",
    "video-1",
  ]);

  await restored.add("video-1");
  assert.equal(await restored.removeVideo("video-1"), 2);
  assert.deepEqual(restored.snapshot().items.map((item) => item.videoId), ["video-2"]);
});

test("moves an item directly after the live item", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-queue-next-test-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const queue = new QueueStore({ rootDir: dataDir });
  await queue.init();
  const current = await queue.add("video-1");
  await queue.add("video-2");
  const requested = await queue.add("video-3");

  await queue.moveNext(requested.id, current.id);
  assert.deepEqual(queue.snapshot().items.map((item) => item.videoId), [
    "video-1",
    "video-3",
    "video-2",
  ]);
});

test("rejects incomplete or foreign reorder payloads", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-queue-order-test-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const queue = new QueueStore({ rootDir: dataDir });
  await queue.init();
  const item = await queue.add("video-1");

  await assert.rejects(queue.reorder([]), /не відповідає/);
  await assert.rejects(queue.reorder([item.id, "foreign-id"]), /не відповідає/);
  assert.equal(queue.snapshot().items.length, 1);
});
