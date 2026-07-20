import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  buildDecodeValidationArgs,
  buildTranscodeArgs,
  MediaProcessor,
  parseProbeResult,
  parseVolumeDetect,
  selectVideoEncoder,
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
        pix_fmt: "yuv420p",
        bit_rate: "7800000",
        field_order: "progressive",
      },
      { codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2, bit_rate: "192000" },
    ],
    format: { duration: "125.5", bit_rate: "8000000", size: "125500000", format_name: "mov,mp4" },
  });

  assert.equal(media.durationSeconds, 125.5);
  assert.equal(media.width, 1920);
  assert.equal(media.height, 1080);
  assert.equal(media.fps, 29.97);
  assert.equal(media.videoCodec, "h264");
  assert.equal(media.audioCodec, "aac");
  assert.equal(media.audioSampleRate, 44_100);
  assert.equal(media.audioChannels, 2);
  assert.equal(media.pixelFormat, "yuv420p");
  assert.equal(media.videoBitrate, 7_800_000);
  assert.equal(media.audioBitrate, 192_000);
  assert.equal(media.sizeBytes, 125_500_000);
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
    pixelFormat: "yuv420p",
    audioSampleRate: 48_000,
    audioChannels: 2,
    sizeBytes: 1_024,
  };
  assert.equal(validateStreamMedia(normalized), normalized);
  assert.throws(() => validateStreamMedia({ ...normalized, width: 1280 }), /профіль/);
});

test("builds full decode validation and parses loudness metrics", () => {
  const args = buildDecodeValidationArgs("C:/media/prepared.mp4");
  assert.equal(args.includes("-ss"), false);
  assert.equal(args.includes("-t"), false);
  assert.equal(args[args.indexOf("-map") + 1], "0:v:0");
  assert.ok(args.includes("0:a:0"));
  assert.ok(args.includes("explode"));
  assert.deepEqual(
    parseVolumeDetect("mean_volume: -18.4 dB\nmax_volume: -0.7 dB"),
    { audioMeanVolumeDb: -18.4, audioPeakDb: -0.7 },
  );
});

test("selects hardware encoders and emits hardware-specific arguments", () => {
  const nvenc = { id: "NVIDIA_NVENC", codec: "h264_nvenc", label: "NVIDIA NVENC" };
  assert.deepEqual(selectVideoEncoder("AUTO", [nvenc]), nvenc);
  assert.equal(selectVideoEncoder("CPU", [nvenc]).codec, "libx264");
  assert.throws(() => selectVideoEncoder("GPU", []), /no hardware encoder/);
  const args = buildTranscodeArgs({
    inputPath: "source.mp4",
    outputPath: "prepared.mp4",
    encoder: nvenc,
  });
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_nvenc");
  assert.equal(args[args.indexOf("-rc") + 1], "cbr");
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
    pixelFormat: "yuv420p",
    audioSampleRate: 48_000,
    audioChannels: 2,
    sizeBytes: content.length,
  };
  const streamMedia = { ...sourceMedia, width: 1920, height: 1080, fps: 30 };
  let failFirstProbe = true;
  const thumbnailPositions = [];
  const decodeModes = [];
  const processor = new MediaProcessor({
    store,
    detectEncodersImpl: async () => [],
    audioAnalysisImpl: async () => ({ audioMeanVolumeDb: -18.2, audioPeakDb: -0.8 }),
    decodeValidationImpl: async (_filePath, { mode }) => {
      decodeModes.push(mode);
      return { status: "PASSED", mode, checkedAt: new Date().toISOString(), segments: [] };
    },
    hashFileImpl: async () => "a".repeat(64),
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
    customThumbnailImpl: async ({ inputPath, outputPath }) => copyFile(inputPath, outputPath),
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
  assert.equal(store.listVideos()[0].encoder, "CPU · libx264");
  assert.equal(store.listVideos()[0].validation.mode, "FULL");
  assert.equal(store.listVideos()[0].preparedChecksumSha256, "a".repeat(64));
  assert.deepEqual(decodeModes, ["SAMPLE", "FULL"]);

  const operation = processor.requestThumbnail(upload.id, 5.2);
  assert.equal(operation.positionSeconds, 5.2);
  await processor.waitForIdle();
  const updated = store.listVideos()[0];
  assert.equal(updated.thumbnailStatus, "READY");
  assert.equal(updated.thumbnailPositionSeconds, 5.2);
  assert.match(updated.thumbnailUrl, /\/thumbnail\?v=/);
  assert.deepEqual(thumbnailPositions, [null, 5.2]);

  const custom = await processor.replaceThumbnail(upload.id, Buffer.from("custom-png"));
  assert.equal(custom.thumbnailStatus, "READY");
  assert.equal(custom.thumbnailPositionSeconds, null);
  assert.match(store.getThumbnailPath(upload.id), /\.thumbnail\.webp$/);
});

test("falls back from a failed hardware encoder to CPU in AUTO mode", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-encoder-fallback-test-"));
  const store = new VideoStore({ rootDir: dataDir });
  await store.init();
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const content = Buffer.from("fallback-video");
  const upload = await store.createUpload({
    name: "fallback.mp4",
    size: content.length,
    encoderMode: "AUTO",
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
    pixelFormat: "yuv420p",
    audioSampleRate: 48_000,
    audioChannels: 2,
    sizeBytes: content.length,
  };
  const streamMedia = { ...sourceMedia, width: 1920, height: 1080, fps: 30 };
  const attemptedEncoders = [];
  const events = [];
  const processor = new MediaProcessor({
    store,
    detectEncodersImpl: async () => [
      { id: "NVIDIA_NVENC", codec: "h264_nvenc", label: "NVIDIA NVENC" },
    ],
    audioAnalysisImpl: async () => ({ audioMeanVolumeDb: -18, audioPeakDb: -1 }),
    decodeValidationImpl: async (_filePath, { mode }) => ({
      status: "PASSED",
      mode,
      checkedAt: new Date().toISOString(),
      segments: [],
    }),
    hashFileImpl: async () => "b".repeat(64),
    probeImpl: async (filePath) => filePath.endsWith(".processing.tmp.mp4") ? streamMedia : sourceMedia,
    transcodeImpl: async ({ inputPath, outputPath, encoder }) => {
      attemptedEncoders.push(encoder.id);
      if (encoder.id === "NVIDIA_NVENC") throw new Error("device lost");
      await copyFile(inputPath, outputPath);
    },
    thumbnailImpl: async ({ inputPath, outputPath }) => copyFile(inputPath, outputPath),
    onEvent: async (type, payload) => events.push({ type, payload }),
    logger: { error() {}, warn() {} },
  });
  t.after(async () => processor.shutdown());

  await processor.init();
  await processor.waitForIdle();
  const video = store.listVideos()[0];
  assert.equal(video.status, "READY");
  assert.equal(video.encoder, "CPU · libx264");
  assert.deepEqual(attemptedEncoders, ["NVIDIA_NVENC", "CPU"]);
  assert.ok(events.some((event) => event.type === "VIDEO_ENCODER_FALLBACK"));
});
