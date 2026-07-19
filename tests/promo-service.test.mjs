import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWebpArgs, detectImageMimeType } from "../media-server/image-processor.mjs";
import { PromoService } from "../media-server/promo-service.mjs";
import { PromoStore } from "../media-server/promo-store.mjs";

test("detects supported images and builds a compact WebP thumbnail command", () => {
  assert.equal(
    detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/png",
  );
  assert.equal(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  const args = buildWebpArgs({ inputPath: "input.png", outputPath: "preview.webp", mode: "thumbnail" });
  assert.equal(args[args.indexOf("-c:v") + 1], "libwebp");
  assert.match(args[args.indexOf("-vf") + 1], /480:270/);
  assert.equal(args.at(-1), "preview.webp");
});

test("stores promo assets, applies a live overlay and schedules a campaign", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-promo-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new PromoStore({ rootDir });
  const overlays = [];
  let currentTime = new Date("2026-07-19T12:00:00.000Z").getTime();
  const service = new PromoService({
    store,
    convertImpl: async ({ inputPath, outputPath }) => copyFile(inputPath, outputPath),
    probeImpl: async () => ({ width: 800, height: 400 }),
    isStreamActive: () => true,
    onOverlayChange: async (items) => overlays.push(items),
    now: () => currentTime,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  await service.init();
  const asset = await service.createAsset({
    name: "QR code",
    tags: "qr,social",
    buffer: Buffer.from("image-fixture"),
    sourceMimeType: "image/png",
  });
  assert.equal(asset.mimeType, "image/webp");
  assert.deepEqual(asset.tags, ["qr", "social"]);

  await service.updateAsset(asset.id, { placement: { x: 100, y: 200, width: 400, height: 200, opacity: 0.8 } });
  await service.show(asset.id, { durationSeconds: 8 });
  assert.equal(overlays.at(-1)[0].placement.x, 100);
  assert.equal(service.snapshot().active.assetId, asset.id);
  await service.hide();
  assert.deepEqual(overlays.at(-1), []);

  const campaign = await service.createCampaign({
    name: "QR every hour",
    assetId: asset.id,
    status: "ACTIVE",
    intervalMinutes: 60,
    durationSeconds: 12,
    timezone: "Europe/Kyiv",
  });
  currentTime += 1_000;
  await service.tick();
  assert.equal(service.snapshot().active.campaignId, campaign.id);
  assert.equal(service.snapshot().campaigns[0].impressions, 1);
  await service.stop();
});
