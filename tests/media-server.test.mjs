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
  return new TelegramService({
    store: new EncryptedTelegramStore({
      rootDir: dataDir,
      secret: "streamlab-test-telegram-secret-32-characters",
    }),
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          ok: true,
          result: { id: 123456, is_bot: true, username: "streamlab_test_bot", first_name: "StreamLab" },
        };
      },
    }),
  });
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
    bitrate: 2_000_000,
    format: "mov,mp4",
  };
  const streamMedia = {
    ...sourceMedia,
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 8_000_000,
  };
  const processor = new MediaProcessor({
    store,
    probeImpl: async (filePath) => filePath.endsWith(".processing.tmp.mp4") ? streamMedia : sourceMedia,
    transcodeImpl: async ({ inputPath, outputPath, onProgress }) => {
      onProgress(50);
      await copyFile(inputPath, outputPath);
      onProgress(100);
    },
    thumbnailImpl: async ({ inputPath, outputPath }) => copyFile(inputPath, outputPath),
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
    body: JSON.stringify({ token: telegramToken }),
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
    body: JSON.stringify({ name: "demo.mp4", size: 6, mimeType: "video/mp4" }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const firstChunk = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/chunks?offset=0`,
    {
      method: "PUT",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
      body: Buffer.from("abc"),
    },
  );
  assert.equal(firstChunk.status, 200);

  const secondChunk = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/chunks?offset=3`,
    {
      method: "PUT",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
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
  assert.ok((await readdir(path.join(dataDir, "uploads"))).every((name) => !name.includes(".source.")));

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
  assert.equal(queueBody.queue.items[0].video.name, "demo.mp4");

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
    }),
  });
  assert.equal(updateSettingsResponse.status, 200);

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
  assert.equal(started.stream.videoName, "demo.mp4");
  assert.equal(controller.lastBitrate, 7_500);
  assert.doesNotMatch(JSON.stringify(started), /abcd-efgh/);

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
    `${baseUrl}/api/queue/items/${savedQueue.items[0].id}`,
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

test("builds separate dynamic playout and configurable CBR uplink commands", () => {
  const args = buildUplinkFfmpegArgs({
    inputUrl: "udp://127.0.0.1:23000",
    target: "rtmps://example.test/live/key",
    videoBitrateKbps: 7_500,
  });
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("7500k"));
  assert.ok(args.includes("60"));
  assert.ok(args.includes("flv"));
  assert.ok(args.includes("-nostats"));
  assert.equal(args[args.indexOf("-progress") + 1], "pipe:1");
  assert.equal(args.at(-1), "rtmps://example.test/live/key");
  assert.match(args[args.indexOf("-vf") + 1], /scale=1920:1080/);
  assert.equal(args[args.indexOf("-i") + 1], "udp://127.0.0.1:23000");

  const playoutArgs = buildPlayoutFfmpegArgs({
    inputPath: "C:/media/first.mp4",
    outputUrl: "udp://127.0.0.1:23000?pkt_size=1316",
    timestampOffsetSeconds: 10,
  });
  assert.equal(playoutArgs[playoutArgs.indexOf("-i") + 1], "C:/media/first.mp4");
  assert.equal(playoutArgs[playoutArgs.indexOf("-c") + 1], "copy");
  assert.equal(playoutArgs[playoutArgs.indexOf("-output_ts_offset") + 1], "10.000");
  assert.equal(playoutArgs[playoutArgs.indexOf("-f") + 1], "mpegts");
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
