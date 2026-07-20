import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsStore } from "../media-server/settings-store.mjs";

test("persists the selected video bitrate", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-settings-test-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const settings = new SettingsStore({ rootDir: dataDir, defaultVideoBitrate: "8M" });
  await settings.init();
  assert.equal(settings.snapshot().videoBitrateKbps, 8_000);

  await settings.updateStream({ videoBitrateKbps: 6_500, fallbackVideoId: "video-1", encoderMode: "GPU" });
  const restored = new SettingsStore({ rootDir: dataDir, defaultVideoBitrate: "10M" });
  await restored.init();
  assert.equal(restored.snapshot().videoBitrateKbps, 6_500);
  assert.equal(restored.snapshot().fallbackVideoId, "video-1");
  assert.equal(restored.snapshot().encoderMode, "GPU");
  assert.ok(restored.snapshot().updatedAt);
});

test("rejects bitrate outside the supported range", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-settings-range-test-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const settings = new SettingsStore({ rootDir: dataDir });
  await settings.init();

  await assert.rejects(
    settings.updateStream({ videoBitrateKbps: 2_999 }),
    /від 3000 до 12000/,
  );
  await assert.rejects(
    settings.updateStream({ videoBitrateKbps: "not-a-number" }),
    /від 3000 до 12000/,
  );
});
