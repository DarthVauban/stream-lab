import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EncryptedStreamPresetStore } from "../media-server/stream-preset-store.mjs";

const secret = "streamlab-preset-encryption-secret-32-characters";

test("encrypts, restores, updates and deletes stream presets", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-presets-test-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const store = new EncryptedStreamPresetStore({ rootDir: dataDir, secret });
  await store.init();

  const created = await store.create({
    name: "Основний канал",
    streamUrl: "rtmps://a.rtmps.youtube.com/live2",
    streamKey: "first-secret-key",
  });
  assert.equal(store.list()[0].streamKey, undefined);
  assert.match(store.list()[0].streamKeyMasked, /-key$/);
  assert.equal(store.get(created.id).streamKey, "first-secret-key");
  assert.doesNotMatch(
    await readFile(path.join(dataDir, "stream-presets.enc.json"), "utf8"),
    /first-secret-key/,
  );

  await store.update(created.id, {
    name: "Резервний канал",
    streamUrl: "rtmps://b.rtmps.youtube.com/live2",
    streamKey: "second-secret-key",
  });
  const restored = new EncryptedStreamPresetStore({ rootDir: dataDir, secret });
  await restored.init();
  assert.equal(restored.get(created.id).name, "Резервний канал");
  assert.equal(restored.get(created.id).streamKey, "second-secret-key");

  await restored.remove(created.id);
  assert.deepEqual(restored.list(), []);
});
