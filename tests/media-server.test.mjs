import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createOwnerAuth, hashPassword } from "../media-server/auth.mjs";
import { MediaProcessor } from "../media-server/media-processor.mjs";
import { createMvpServer, normalizeServerError } from "../media-server/server.mjs";
import { VideoStore } from "../media-server/store.mjs";
import { EncryptedStreamPresetStore } from "../media-server/stream-preset-store.mjs";
import { TelegramService } from "../media-server/telegram-service.mjs";
import { EncryptedTelegramStore } from "../media-server/telegram-store.mjs";
import {
  buildPlayoutFfmpegArgs,
  buildUplinkFfmpegArgs,
} from "../media-server/stream-controller.mjs";

class FakeController {
  constructor() {
    this.getQueue = () => [];
    this.lastBitrate = null;
    this.skipCount = 0;
    this.state = {
      status: "STOPPED",
      videoId: null,
      videoName: null,
      queueItemId: null,
      startedAt: null,
      stoppedAt: null,
      lastError: null,
      logs: [],
    };
  }

  checkFfmpeg() {
    return { available: true, version: "ffmpeg test", message: null };
  }

  snapshot() {
    return { ...this.state };
  }

  async init({ getQueue }) {
    this.getQueue = getQueue;
  }

  isActive() {
    return this.state.status === "LIVE";
  }

  isCurrentQueueItem(itemId) {
    return this.state.queueItemId === itemId;
  }

  usesVideo(videoId) {
    return this.state.videoId === videoId;
  }

  async start({ videoBitrateKbps }) {
    const video = this.getQueue()[0];
    this.lastBitrate = videoBitrateKbps;
    this.state = {
      ...this.state,
      status: "LIVE",
      videoId: video.id,
      videoName: video.name,
      queueItemId: video.queueItemId,
      videoBitrateKbps,
      startedAt: new Date().toISOString(),
    };
    return this.snapshot();
  }

  async stop() {
    this.state = { ...this.state, status: "STOPPED", stoppedAt: new Date().toISOString() };
    return this.snapshot();
  }

  async skip() {
    this.skipCount += 1;
    const queue = this.getQueue();
    const currentIndex = queue.findIndex((item) => item.queueItemId === this.state.queueItemId);
    const video = queue[(currentIndex + 1) % queue.length];
    this.state = {
      ...this.state,
      videoId: video.id,
      videoName: video.name,
      queueItemId: video.queueItemId,
    };
    return this.snapshot();
  }
}

const TEST_PASSWORD = "correct-horse-battery-staple";
const TEST_PASSWORD_HASH = hashPassword(TEST_PASSWORD, "streamlab-test-salt");

function testAuth() {
  return createOwnerAuth({
    username: "owner",
    passwordHash: TEST_PASSWORD_HASH,
    sessionSecret: "streamlab-test-session-secret-32-characters",
  });
}

function testPresetStore(dataDir) {
  return new EncryptedStreamPresetStore({
    rootDir: dataDir,
    secret: "streamlab-test-preset-secret-32-characters",
  });
}

function testTelegram(dataDir) {
  const calls = [];
  const service = new TelegramService({
    store: new EncryptedTelegramStore({
      rootDir: dataDir,
      secret: "streamlab-test-telegram-secret-32-characters",
    }),
    fetchImpl: async (url, init) => {
      const method = new URL(url).pathname.split("/").at(-1);
      calls.push({ method, body: JSON.parse(init.body) });
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            result: method === "getMe"
              ? { id: 123456, is_bot: true, username: "streamlab_test_bot", first_name: "StreamLab" }
              : true,
          };
        },
      };
    },
  });
  service.calls = calls;
  return service;
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "owner", password: TEST_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  return {
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
    csrfToken: session.csrfToken,
  };
}

test("uploads a video in chunks and starts the queue stream", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-test-"));
  const controller = new FakeController();
  const store = new VideoStore({ rootDir: dataDir });
  const sourceMedia = {
    durationSeconds: 10,
    width: 1280,
    height: 720,
    fps: 25,
    videoCodec: "h264",
    audioCodec: "aac",
    audioSampleRate: 44_100,
    audioChannels: 2,
    pixelFormat: "yuv420p",
    sizeBytes: 6,
    bitrate: 2_000_000,
    format: "mov,mp4",
  };
  const streamMedia = {
    ...sourceMedia,
    width: 1920,
    height: 1080,
    fps: 30,
    audioSampleRate: 48_000,
    bitrate: 8_000_000,
  };
  const processor = new MediaProcessor({
    store,
    detectEncodersImpl: async () => [],
    audioAnalysisImpl: async () => ({ audioMeanVolumeDb: -17.8, audioPeakDb: -0.6 }),
    decodeValidationImpl: async (_filePath, { mode }) => ({
      status: "PASSED",
      mode,
      checkedAt: new Date().toISOString(),
      segments: [],
    }),
    hashFileImpl: async () => "a".repeat(64),
    probeImpl: async (filePath) => filePath.endsWith(".processing.tmp.mp4") ? streamMedia : sourceMedia,
    transcodeImpl: async ({ inputPath, outputPath, onProgress }) => {
      onProgress(50);
      await copyFile(inputPath, outputPath);
      onProgress(100);
    },
    thumbnailImpl: async ({ inputPath, outputPath }) => copyFile(inputPath, outputPath),
    customThumbnailImpl: async ({ inputPath, outputPath }) => copyFile(inputPath, outputPath),
  });
  const app = await createMvpServer({
    dataDir,
    store,
    processor,
    controller,
    auth: testAuth(),
    presets: testPresetStore(dataDir),
    telegram: testTelegram(dataDir),
  });
  const address = await app.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const unauthorized = await fetch(`${baseUrl}/api/videos`);
  assert.equal(unauthorized.status, 401);

  const session = await login(baseUrl);
  const telegramToken = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
  const telegramResponse = await fetch(`${baseUrl}/api/telegram/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({
      token: telegramToken,
      webhookUrl: "https://stream.example.test/api/telegram/webhook",
      allowedUserIds: ["111"],
      allowedChatIds: ["111"],
    }),
  });
  assert.equal(telegramResponse.status, 200);
  const telegram = (await telegramResponse.json()).telegram;
  assert.equal(telegram.connected, true);
  assert.equal(telegram.bot.username, "streamlab_test_bot");
  assert.equal(telegram.token, undefined);
  assert.match(telegram.tokenMasked, /abcd$/);
  assert.doesNotMatch(
    await readFile(path.join(dataDir, "telegram-bot.enc.json"), "utf8"),
    new RegExp(telegramToken),
  );
  const telegramSecret = app.telegram.store.readConnection().webhook.secret;
  const webhookResponse = await fetch(`${baseUrl}/api/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": telegramSecret,
    },
    body: JSON.stringify({
      update_id: 1,
      message: { message_id: 1, from: { id: 111 }, chat: { id: 111 }, text: "/start" },
    }),
  });
  assert.equal(webhookResponse.status, 200);
  assert.deepEqual(await webhookResponse.json(), { ok: true });
  const rejectedWebhookResponse = await fetch(`${baseUrl}/api/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "invalid-secret",
    },
    body: JSON.stringify({ update_id: 2 }),
  });
  assert.equal(rejectedWebhookResponse.status, 403);
  const createPresetResponse = await fetch(`${baseUrl}/api/stream-presets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({
      name: "Основний канал",
      streamUrl: "rtmps://a.rtmps.youtube.com/live2",
      streamKey: "preset-secret-key",
    }),
  });
  assert.equal(createPresetResponse.status, 201);
  const presetSummary = (await createPresetResponse.json()).preset;
  assert.equal(presetSummary.name, "Основний канал");
  assert.equal(presetSummary.streamKey, undefined);
  assert.match(presetSummary.streamKeyMasked, /-key$/);

  const rawPresets = await readFile(path.join(dataDir, "stream-presets.enc.json"), "utf8");
  assert.doesNotMatch(rawPresets, /preset-secret-key/);

  const presetDetailsResponse = await fetch(
    `${baseUrl}/api/stream-presets/${presetSummary.id}`,
    { headers: { Cookie: session.cookie } },
  );
  assert.equal(presetDetailsResponse.status, 200);
  assert.equal((await presetDetailsResponse.json()).preset.streamKey, "preset-secret-key");

  const createResponse = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({
      name: "demo.mp4",
      size: 6,
      mimeType: "video/mp4",
      description: "Night broadcast loop",
      tags: ["night", "ambient"],
      musicType: "Ambient",
      album: "Night Sessions",
      year: 2026,
      encoderMode: "CPU",
      checksumSha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const encodersResponse = await fetch(`${baseUrl}/api/media/encoders`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(encodersResponse.status, 200);
  assert.deepEqual((await encodersResponse.json()).encoders.hardware, []);

  const pauseResponse = await fetch(`${baseUrl}/api/uploads/${created.upload.id}/pause`, {
    method: "POST",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  assert.equal(pauseResponse.status, 200);
  assert.equal((await pauseResponse.json()).upload.uploadState, "PAUSED");

  const pausedChunk = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/chunks?offset=0`,
    {
      method: "PUT",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
      body: Buffer.from("abc"),
    },
  );
  assert.equal(pausedChunk.status, 409);

  const resumeResponse = await fetch(`${baseUrl}/api/uploads/${created.upload.id}/resume`, {
    method: "POST",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  assert.equal(resumeResponse.status, 200);
  assert.equal((await resumeResponse.json()).upload.uploadState, "ACTIVE");

  const firstChunk = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/chunks?offset=0`,
    {
      method: "PUT",
      headers: {
        Cookie: session.cookie,
        "X-CSRF-Token": session.csrfToken,
        "X-Chunk-SHA256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
      body: Buffer.from("abc"),
    },
  );
  assert.equal(firstChunk.status, 200);

  const secondChunk = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/chunks?offset=3`,
    {
      method: "PUT",
      headers: {
        Cookie: session.cookie,
        "X-CSRF-Token": session.csrfToken,
        "X-Chunk-SHA256": "cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34",
      },
      body: Buffer.from("def"),
    },
  );
  assert.equal(secondChunk.status, 200);

  const completeResponse = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/complete`,
    {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
    },
  );
  assert.equal(completeResponse.status, 202);
  const processingVideo = await completeResponse.json();
  assert.equal(processingVideo.video.status, "ANALYZING");
  assert.equal(processingVideo.video.integrityVerified, true);
  assert.equal(processingVideo.video.checksumSha256, "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721");
  await processor.waitForIdle();

  const videosResponse = await fetch(`${baseUrl}/api/videos`, {
    headers: { Cookie: session.cookie },
  });
  const videos = await videosResponse.json();
  assert.equal(videos.videos.length, 1);
  assert.equal(videos.videos[0].name, "demo.mp4");
  assert.equal(videos.videos[0].status, "READY");
  assert.equal(videos.videos[0].processingProgress, 100);
  assert.equal(videos.videos[0].media.width, 1920);
  assert.equal(videos.videos[0].preparedSize, 6);
  assert.equal(videos.videos[0].description, "Night broadcast loop");
  assert.deepEqual(videos.videos[0].tags, ["night", "ambient"]);
  assert.equal(videos.videos[0].musicType, "Ambient");
  assert.equal(videos.videos[0].album, "Night Sessions");
  assert.equal(videos.videos[0].year, 2026);
  assert.equal(videos.videos[0].encoder, "CPU · libx264");
  assert.equal(videos.videos[0].validation.mode, "FULL");
  assert.equal(videos.videos[0].preparedChecksumSha256, "a".repeat(64));
  assert.equal(videos.videos[0].sourceMedia.audioMeanVolumeDb, -17.8);
  assert.equal(videos.videos[0].sourceMedia.audioPeakDb, -0.6);
  assert.equal(videos.videos[0].sourceMedia.decodeValidation.mode, "SAMPLE");
  assert.equal(videos.videos[0].sourceMedia.corruptionDetected, false);
  assert.ok((await readdir(path.join(dataDir, "uploads"))).every((name) => !name.includes(".source.")));

  const renameResponse = await fetch(`${baseUrl}/api/videos/${created.upload.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({ name: "Broadcast loop" }),
  });
  assert.equal(renameResponse.status, 200);
  assert.equal((await renameResponse.json()).video.name, "Broadcast loop.mp4");

  const customThumbnailResponse = await fetch(`${baseUrl}/api/videos/${created.upload.id}/thumbnail`, {
    method: "PUT",
    headers: {
      "Content-Type": "image/png",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
  });
  assert.equal(customThumbnailResponse.status, 200);
  const thumbnailResponse = await fetch(`${baseUrl}/api/videos/${created.upload.id}/thumbnail`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(thumbnailResponse.status, 200);
  assert.equal(thumbnailResponse.headers.get("content-type"), "image/webp");

  const addQueueResponse = await fetch(`${baseUrl}/api/queue/items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({ videoId: created.upload.id }),
  });
  assert.equal(addQueueResponse.status, 201);
  const queueBody = await addQueueResponse.json();
  assert.equal(queueBody.queue.items.length, 1);
  assert.equal(queueBody.queue.items[0].video.name, "Broadcast loop.mp4");

  const addAgainResponse = await fetch(`${baseUrl}/api/queue/items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({ videoId: created.upload.id }),
  });
  assert.equal(addAgainResponse.status, 201);

  const queueResponse = await fetch(`${baseUrl}/api/queue`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(queueResponse.status, 200);
  const savedQueue = (await queueResponse.json()).queue;
  assert.equal(savedQueue.mode, "LOOP_ALL");
  assert.equal(savedQueue.items.length, 2);

  const settingsResponse = await fetch(`${baseUrl}/api/settings/stream`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(settingsResponse.status, 200);
  const defaultSettings = (await settingsResponse.json()).settings;
  assert.equal(defaultSettings.videoBitrateKbps, 8_000);
  assert.equal(defaultSettings.fallbackVideoId, null);
  assert.equal(defaultSettings.encoderMode, "AUTO");

  const updateSettingsResponse = await fetch(`${baseUrl}/api/settings/stream`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({
      videoBitrateKbps: 7_500,
      fallbackVideoId: created.upload.id,
      encoderMode: "CPU",
    }),
  });
  assert.equal(updateSettingsResponse.status, 200);
  assert.equal((await updateSettingsResponse.json()).settings.encoderMode, "CPU");

  const startResponse = await fetch(`${baseUrl}/api/stream/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({
      streamUrl: "rtmps://a.rtmps.youtube.com/live2",
      streamKey: "abcd-efgh-ijkl-mnop",
    }),
  });
  assert.equal(startResponse.status, 202);
  const started = await startResponse.json();
  assert.equal(started.stream.status, "LIVE");
  assert.equal(started.stream.videoName, "Broadcast loop.mp4");
  assert.equal(controller.lastBitrate, 7_500);
  assert.doesNotMatch(JSON.stringify(started), /abcd-efgh/);

  const telegramSkipRequest = await fetch(`${baseUrl}/api/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": telegramSecret,
    },
    body: JSON.stringify({
      update_id: 10,
      message: { message_id: 10, from: { id: 111 }, chat: { id: 111 }, text: "/next" },
    }),
  });
  assert.equal(telegramSkipRequest.status, 200);
  const telegramConfirmation = app.telegram.calls
    .filter((call) => call.method === "sendMessage" && /наступного відео/.test(call.body.text))
    .at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(telegramConfirmation, /^ctl_confirm:/);
  const telegramSkipConfirm = await fetch(`${baseUrl}/api/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": telegramSecret,
    },
    body: JSON.stringify({
      update_id: 11,
      callback_query: {
        id: "confirm-next",
        from: { id: 111 },
        data: telegramConfirmation,
        message: { message_id: 11, chat: { id: 111 } },
      },
    }),
  });
  assert.equal(telegramSkipConfirm.status, 200);
  assert.equal(controller.skipCount, 1);
  await fetch(`${baseUrl}/api/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": telegramSecret,
    },
    body: JSON.stringify({
      update_id: 12,
      callback_query: {
        id: "replay-next",
        from: { id: 111 },
        data: telegramConfirmation,
        message: { message_id: 11, chat: { id: 111 } },
      },
    }),
  });
  assert.equal(controller.skipCount, 1);
  const telegramAuditResponse = await fetch(`${baseUrl}/api/audit?limit=50`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(telegramAuditResponse.status, 200);
  const telegramAudit = (await telegramAuditResponse.json()).entries;
  assert.ok(telegramAudit.some((entry) => entry.action === "TELEGRAM_CONTROL_SKIP_REQUESTED"));
  assert.ok(telegramAudit.some((entry) => entry.action === "TELEGRAM_CONTROL_SKIP_EXECUTED"));
  assert.ok(telegramAudit.some((entry) => entry.action === "TELEGRAM_CTL_CONFIRM" && entry.status === "REJECTED"));

  const monitoringResponse = await fetch(`${baseUrl}/api/monitoring/status?hours=1`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(monitoringResponse.status, 200);
  const monitoring = (await monitoringResponse.json()).monitoring;
  assert.equal(monitoring.current.targetBitrateKbps, 7_500);
  assert.equal(monitoring.session.totalStreamStarts, 1);
  assert.doesNotMatch(JSON.stringify(monitoring), /abcd-efgh/);

  const changeActiveQueueResponse = await fetch(`${baseUrl}/api/queue/items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({ videoId: created.upload.id }),
  });
  assert.equal(changeActiveQueueResponse.status, 201);
  assert.equal((await changeActiveQueueResponse.json()).queue.items.length, 3);

  const removeCurrentResponse = await fetch(
    `${baseUrl}/api/queue/items/${controller.state.queueItemId}`,
    {
      method: "DELETE",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
    },
  );
  assert.equal(removeCurrentResponse.status, 409);

  const skipResponse = await fetch(`${baseUrl}/api/stream/skip`, {
    method: "POST",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  assert.equal(skipResponse.status, 200);

  const deleteActiveResponse = await fetch(`${baseUrl}/api/videos/${created.upload.id}`, {
    method: "DELETE",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  assert.equal(deleteActiveResponse.status, 409);

  const stopResponse = await fetch(`${baseUrl}/api/stream/stop`, {
    method: "POST",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  assert.equal(stopResponse.status, 200);

  const deleteResponse = await fetch(`${baseUrl}/api/videos/${created.upload.id}`, {
    method: "DELETE",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  assert.equal(deleteResponse.status, 200);
  const deleted = await deleteResponse.json();
  assert.equal(deleted.queue.items.length, 0);
  assert.equal(app.settings.snapshot().fallbackVideoId, null);
  assert.deepEqual(
    (await readdir(path.join(dataDir, "uploads"))).filter((name) => name !== ".trash"),
    [],
  );
});

test("rejects state-changing requests without a CSRF token", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-auth-test-"));
  const app = await createMvpServer({
    dataDir,
    controller: new FakeController(),
    auth: testAuth(),
    presets: testPresetStore(dataDir),
    telegram: testTelegram(dataDir),
  });
  const address = await app.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const session = await login(baseUrl);
  const response = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: session.cookie },
    body: JSON.stringify({ name: "demo.mp4", size: 6, mimeType: "video/mp4" }),
  });
  assert.equal(response.status, 403);
});

test("builds a CPU-independent remux uplink and dynamic playout commands", () => {
  const args = buildUplinkFfmpegArgs({
    inputUrl: "udp://127.0.0.1:23000",
    target: "rtmps://example.test/live/key",
    videoBitrateKbps: 7_500,
  });
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args.includes("libx264"), false);
  assert.ok(args.includes("flv"));
  assert.ok(args.includes("-nostats"));
  assert.equal(args[args.indexOf("-progress") + 1], "pipe:1");
  assert.equal(args.at(-1), "rtmps://example.test/live/key");
  assert.equal(args.includes("-vf"), false);
  assert.equal(args.includes("-re"), true);
  assert.equal(args[args.indexOf("-i") + 1], "udp://127.0.0.1:23000");
  assert.equal(args[args.indexOf("-ar") + 1], "44100");
  assert.equal(args[args.indexOf("-rw_timeout") + 1], "15000000");
  assert.equal(args[args.indexOf("-max_interleave_delta") + 1], "1000000");

  const playoutArgs = buildPlayoutFfmpegArgs({
    inputPath: "C:/media/first.mp4",
    outputUrl: "udp://127.0.0.1:23000?pkt_size=1316",
    timestampOffsetSeconds: 10,
  });
  assert.equal(playoutArgs[playoutArgs.indexOf("-i") + 1], "C:/media/first.mp4");
  assert.equal(playoutArgs[playoutArgs.indexOf("-c") + 1], "copy");
  assert.equal(playoutArgs[playoutArgs.indexOf("-output_ts_offset") + 1], "10.000");
  assert.equal(playoutArgs.includes("-re"), false);
  assert.equal(playoutArgs[playoutArgs.indexOf("-f") + 1], "mpegts");
  assert.match(playoutArgs[playoutArgs.indexOf("-mpegts_flags") + 1], /initial_discontinuity/);

  const promoArgs = buildPlayoutFfmpegArgs({
    inputPath: "C:/media/first.mp4",
    outputUrl: "udp://127.0.0.1:23000?pkt_size=1316",
    timestampOffsetSeconds: 10,
    startSeconds: 5,
    overlays: [{
      filePath: "C:/media/promo.webp",
      placement: { x: 100, y: 50, width: 400, height: 200, opacity: 0.8, zIndex: 1 },
    }],
  });
  assert.equal(promoArgs[promoArgs.indexOf("-ss") + 1], "5.000");
  assert.equal(promoArgs[promoArgs.indexOf("-output_ts_offset") + 1], "15.000");
  assert.ok(promoArgs.includes("-filter_complex"));
  assert.match(promoArgs[promoArgs.indexOf("-filter_complex") + 1], /overlay=100:50/);
  assert.ok(promoArgs.includes("libx264"));
  assert.equal(promoArgs[promoArgs.indexOf("-preset") + 1], "ultrafast");
  assert.equal(promoArgs[promoArgs.indexOf("-b:v") + 1], "8000k");
  assert.equal(promoArgs[promoArgs.indexOf("-g") + 1], "60");
});

test("returns actionable storage errors without exposing filesystem details", () => {
  const permissionError = Object.assign(new Error("EACCES: /app/data/uploads/private.part"), {
    code: "EACCES",
  });
  const normalizedPermissionError = normalizeServerError(permissionError);
  assert.equal(normalizedPermissionError.status, 503);
  assert.equal(normalizedPermissionError.code, "STORAGE_UNAVAILABLE");
  assert.doesNotMatch(normalizedPermissionError.message, /\/app\/data/);

  const fullDiskError = normalizeServerError(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  assert.equal(fullDiskError.status, 507);
  assert.equal(fullDiskError.code, "INSUFFICIENT_STORAGE");
});

test("protects YouTube controls while allowing the state-validated OAuth callback", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-youtube-api-test-"));
  let callbackCount = 0;
  let analyticsRefreshCount = 0;
  const youtube = {
    async init() {},
    start() {},
    stop() {},
    snapshot() {
      return {
        configured: true,
        connected: true,
        channel: { title: "Test channel" },
        selected: { title: "Test live" },
      };
    },
    async beginOAuth() {
      return "https://accounts.google.com/o/oauth2/v2/auth?state=test";
    },
    async completeOAuth({ code, state }) {
      assert.equal(code, "oauth-code");
      assert.equal(state, "oauth-state");
      callbackCount += 1;
    },
    async refreshAnalyticsNow() {
      analyticsRefreshCount += 1;
      return {
        ...this.snapshot(),
        analytics: { available: true, reconnectRequired: false, views: 120 },
      };
    },
    getSelectedIngestion() {
      return {
        streamUrl: "rtmps://a.rtmps.youtube.com/live2",
        streamKey: "youtube-secret-key",
      };
    },
  };
  const app = await createMvpServer({
    dataDir,
    controller: new FakeController(),
    auth: testAuth(),
    presets: testPresetStore(dataDir),
    youtube,
    telegram: testTelegram(dataDir),
  });
  const address = await app.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const callback = await fetch(
    `${baseUrl}/api/youtube/oauth/callback?code=oauth-code&state=oauth-state`,
    { redirect: "manual" },
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/?youtube=connected");
  assert.equal(callbackCount, 1);

  const unauthorized = await fetch(`${baseUrl}/api/youtube/status`);
  assert.equal(unauthorized.status, 401);
  const session = await login(baseUrl);

  const missingCsrf = await fetch(`${baseUrl}/api/youtube/oauth/start`, {
    method: "POST",
    headers: { Cookie: session.cookie },
  });
  assert.equal(missingCsrf.status, 403);

  const oauthStart = await fetch(`${baseUrl}/api/youtube/oauth/start`, {
    method: "POST",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  assert.equal(oauthStart.status, 200);
  assert.match((await oauthStart.json()).authorizationUrl, /^https:\/\/accounts\.google\.com\//);

  const analyticsMissingCsrf = await fetch(`${baseUrl}/api/youtube/analytics/refresh`, {
    method: "POST",
    headers: { Cookie: session.cookie },
  });
  assert.equal(analyticsMissingCsrf.status, 403);

  const analyticsRefresh = await fetch(`${baseUrl}/api/youtube/analytics/refresh`, {
    method: "POST",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  assert.equal(analyticsRefresh.status, 200);
  assert.equal((await analyticsRefresh.json()).youtube.analytics.views, 120);
  assert.equal(analyticsRefreshCount, 1);

  const presetResponse = await fetch(`${baseUrl}/api/youtube/stream-preset`, {
    method: "POST",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  assert.equal(presetResponse.status, 201);
  const preset = (await presetResponse.json()).preset;
  assert.equal(preset.name, "YouTube · Test live");
  assert.equal(preset.streamKey, undefined);
  const rawPresets = await readFile(path.join(dataDir, "stream-presets.enc.json"), "utf8");
  assert.doesNotMatch(rawPresets, /youtube-secret-key/);
});
