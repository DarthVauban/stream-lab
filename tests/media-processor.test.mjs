import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  buildTranscodeArgs,
  MediaProcessor,
  parseProbeResult,
  validateStreamMedia,
} from "../media-server/media-processor.mjs";
import { VideoStore } from "../media-server/store.mjs";

test("extracts safe media metadata from ffprobe output", () => {
  const media = parseProbeResult({
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        avg_frame_rate: "30000/1001",
      },
      { codec_type: "audio", codec_name: "aac", sample_rate: "44100" },
    ],
    format: { duration: "125.5", bit_rate: "8000000", format_name: "mov,mp4" },
  });

  assert.equal(media.durationSeconds, 125.5);
  assert.equal(media.width, 1920);
  assert.equal(media.height, 1080);
  assert.equal(media.fps, 29.97);
  assert.equal(media.videoCodec, "h264");
  assert.equal(media.audioCodec, "aac");
  assert.equal(media.audioSampleRate, 44_100);
});

test("rejects files without an audio track", () => {
  assert.throws(
    () => parseProbeResult({
      streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
      format: { duration: "10" },
    }),
    /аудіопотік/,
  );
});

test("accepts only the normalized stream profile", () => {
  const normalized = {
    durationSeconds: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: "h264",
    audioCodec: "aac",
  };
  assert.equal(validateStreamMedia(normalized), normalized);
  assert.throws(() => validateStreamMedia({ ...normalized, width: 1280 }), /профіль/);
});

test("builds a deterministic 1080p30 stream preparation command", () => {
  const args = buildTranscodeArgs({
    inputPath: "C:/media/source.mov",
    outputPath: "C:/media/prepared.mp4",
    videoBitrate: "8M",
    audioBitrate: "128k",
    preset: "veryfast",
  });
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-r") + 1], "30");
  assert.match(args[args.indexOf("-vf") + 1], /scale=1920:1080/);
  assert.equal(args.at(-1), "C:/media/prepared.mp4");
});

test("restores pending processing and supports retry after a failure", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-processor-test-"));
  const store = new VideoStore({ rootDir: dataDir });
  await store.init();
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const content = Buffer.from("test-video");
  const upload = await store.createUpload({
    name: "recovery.mp4",
    size: content.length,
    mimeType: "video/mp4",
  });
  await store.appendChunk(upload.id, 0, Readable.from(content));
  await store.completeUpload(upload.id);

  const sourceMedia = {
    durationSeconds: 10,
    width: 1280,
    height: 720,
    fps: 25,
    videoCodec: "h264",
    audioCodec: "aac",
  };
  const streamMedia = { ...sourceMedia, width: 1920, height: 1080, fps: 30 };
  let failFirstProbe = true;
  const thumbnailPositions = [];
  const processor = new MediaProcessor({
    store,
    probeImpl: async (filePath) => {
      if (failFirstProbe) {
        failFirstProbe = false;
        throw new Error("temporary probe failure");
      }
      return filePath.endsWith(".processing.tmp.mp4") ? streamMedia : sourceMedia;
    },
    transcodeImpl: async ({ inputPath, outputPath, onProgress }) => {
      onProgress(60);
      await copyFile(inputPath, outputPath);
    },
    thumbnailImpl: async ({ inputPath, outputPath, positionSeconds }) => {
      thumbnailPositions.push(positionSeconds ?? null);
      await copyFile(inputPath, outputPath);
    },
    logger: { error() {} },
  });
  t.after(async () => processor.shutdown());

  await processor.init();
  await processor.waitForIdle();
  assert.equal(store.listVideos()[0].status, "FAILED");
  assert.match(store.listVideos()[0].processingError, /Не вдалося підготувати/);

  await store.retryProcessing(upload.id);
  processor.enqueue(upload.id);
  await processor.waitForIdle();
  assert.equal(store.listVideos()[0].status, "READY");
  assert.equal(store.listVideos()[0].processingProgress, 100);

  const operation = processor.requestThumbnail(upload.id, 5.2);
  assert.equal(operation.positionSeconds, 5.2);
  await processor.waitForIdle();
  const updated = store.listVideos()[0];
  assert.equal(updated.thumbnailStatus, "READY");
  assert.equal(updated.thumbnailPositionSeconds, 5.2);
  assert.match(updated.thumbnailUrl, /\/thumbnail\?v=/);
  assert.deepEqual(thumbnailPositions, [null, 5.2]);
});
