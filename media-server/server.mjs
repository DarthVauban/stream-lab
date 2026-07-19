import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { ApiError } from "./api-error.mjs";
import { AuditStore } from "./audit-store.mjs";
import { createOwnerAuth } from "./auth.mjs";
import { listCompressionProfiles } from "./compression-profiles.mjs";
import { PostgresDatabase } from "./database.mjs";
import { MediaProcessor } from "./media-processor.mjs";
import { MonitoringService } from "./monitoring-service.mjs";
import { MonitoringStore } from "./monitoring-store.mjs";
import { PlaylistStore } from "./playlist-store.mjs";
import { QueueStore } from "./queue-store.mjs";
import { RealtimeHub } from "./realtime-hub.mjs";
import { SettingsStore } from "./settings-store.mjs";
import { StorageMonitor } from "./storage-monitor.mjs";
import { VideoStore } from "./store.mjs";
import { StreamController } from "./stream-controller.mjs";
import { EncryptedStreamPresetStore } from "./stream-preset-store.mjs";
import { EncryptedStreamStateStore } from "./stream-state-store.mjs";
import { TelegramService } from "./telegram-service.mjs";
import { EncryptedTelegramStore } from "./telegram-store.mjs";
import { YouTubeService } from "./youtube-service.mjs";
import { EncryptedYouTubeStore, YouTubeStatsStore } from "./youtube-store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const DEFAULT_ALLOWED_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function redirect(response, location) {
  response.writeHead(303, { Location: location });
  response.end();
}

async function readJson(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new ApiError(413, "BODY_TOO_LARGE", "Тіло запиту завелике.");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Некоректний JSON.");
  }
}

function buildTarget(streamUrl, streamKey) {
  if (typeof streamUrl !== "string" || typeof streamKey !== "string") {
    throw new ApiError(400, "STREAM_SETTINGS_REQUIRED", "Вкажіть RTMPS URL і ключ трансляції.");
  }
  let parsed;
  try {
    parsed = new URL(streamUrl.trim());
  } catch {
    throw new ApiError(400, "INVALID_STREAM_URL", "Некоректний RTMPS URL.");
  }
  if (!["rtmp:", "rtmps:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new ApiError(400, "INVALID_STREAM_URL", "Дозволені лише RTMP або RTMPS URL.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ApiError(400, "INVALID_STREAM_URL", "URL не повинен містити логін, query або fragment.");
  }

  const key = streamKey.trim();
  if (!/^[A-Za-z0-9_-]{6,200}$/.test(key)) {
    throw new ApiError(400, "INVALID_STREAM_KEY", "Некоректний формат ключа трансляції.");
  }
  return `${streamUrl.trim().replace(/\/+$/, "")}/${key}`;
}

function setCommonHeaders(request, response, allowedOrigins) {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,X-CSRF-Token");
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function mutationMetadata(method, pathname) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method || "")) return null;
  if (/^\/api\/uploads\/[^/]+\/chunks$/.test(pathname)) return null;
  const segments = pathname.split("/").filter(Boolean);
  return {
    action: `${method} ${pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")}`,
    targetType: segments[1] || "system",
    targetId: segments.find((segment) => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) || null,
  };
}

export function normalizeServerError(error) {
  if (error instanceof ApiError) return error;
  if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) {
    return new ApiError(
      503,
      "STORAGE_UNAVAILABLE",
      "Сховище відео тимчасово недоступне для запису.",
    );
  }
  if (error?.code === "ENOSPC") {
    return new ApiError(507, "INSUFFICIENT_STORAGE", "На сервері недостатньо місця для відео.");
  }
  return new ApiError(500, "INTERNAL_ERROR", "Внутрішня помилка медіасервера.");
}

export async function createMvpServer({
  dataDir = process.env.MEDIA_DATA_DIR || path.join(projectRoot, "data"),
  allowedOrigins = (process.env.MEDIA_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  store,
  controller,
  auth,
  stateStore,
  processor,
  queue,
  settings,
  presets,
  youtube,
  monitoring,
  telegram,
  database,
  realtime,
  audit,
  playlists,
  storage,
} = {}) {
  const databaseService = database ?? new PostgresDatabase();
  await databaseService.init?.();
  const stateRepository = databaseService?.configured ? databaseService : null;
  const realtimeHub = realtime ?? new RealtimeHub();
  await realtimeHub.init?.();
  const auditStore = audit ?? new AuditStore({ rootDir: dataDir, database: databaseService });
  await auditStore.init?.();
  const videoStore = store ?? new VideoStore({ rootDir: dataDir, repository: stateRepository });
  const liveQueue = queue ?? new QueueStore({ rootDir: dataDir, repository: stateRepository });
  const settingsStore = settings ?? new SettingsStore({ rootDir: dataDir, repository: stateRepository });
  const playlistStore = playlists ?? new PlaylistStore({ rootDir: dataDir, repository: stateRepository });
  const streamPresetStore =
    presets ??
    new EncryptedStreamPresetStore({
      rootDir: dataDir,
      secret: process.env.STREAM_CONFIG_SECRET,
    });
  await videoStore.init();
  await liveQueue.init();
  await settingsStore.init();
  await playlistStore.init();
  await streamPresetStore.init();
  const encryptedStateStore =
    stateStore ??
    (controller
      ? null
      : new EncryptedStreamStateStore({
          rootDir: dataDir,
          secret: process.env.STREAM_CONFIG_SECRET,
        }));
  const streamController =
    controller ??
    new StreamController({
      ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
      videoBitrateKbps: settingsStore.snapshot().videoBitrateKbps,
      audioBitrate: process.env.MVP_AUDIO_BITRATE || "192k",
      stateStore: encryptedStateStore,
    });
  const mediaProcessor =
    processor ??
    new MediaProcessor({
      store: videoStore,
      ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
      ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
      videoBitrate: process.env.MEDIA_TRANSCODE_VIDEO_BITRATE || "8M",
      audioBitrate: process.env.MVP_AUDIO_BITRATE || "192k",
      preset: process.env.MEDIA_TRANSCODE_PRESET || "veryfast",
      keepOriginalUploads: process.env.MEDIA_KEEP_ORIGINAL_UPLOADS === "true",
      onEvent: async (type, payload) => {
        await Promise.all([
          realtimeHub.publish(type, payload),
          auditStore.append({
            actor: "system",
            action: type,
            targetType: "videos",
            targetId: payload?.videoId || null,
            status: type.endsWith("FAILED") ? "FAILED" : "SUCCESS",
            details: payload,
          }),
        ]);
      },
    });
  const corsOrigins = allowedOrigins.length ? allowedOrigins : DEFAULT_ALLOWED_ORIGINS;
  const ownerAuth = auth ?? createOwnerAuth();
  const youtubeConfigured = [
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI,
  ].every((value) => typeof value === "string" && value.trim());
  const youtubeIntegration =
    youtube ??
    new YouTubeService(
      youtubeConfigured
        ? {
            store: new EncryptedYouTubeStore({ rootDir: dataDir }),
            statsStore: new YouTubeStatsStore({ rootDir: dataDir, repository: stateRepository }),
          }
        : {},
    );
  const telegramIntegration =
    telegram ??
    new TelegramService({
      store: new EncryptedTelegramStore({ rootDir: dataDir }),
    });
  await encryptedStateStore?.init();
  await streamController.init?.({
    resolveVideo: (videoId) => videoStore.getReadyVideo(videoId),
    getQueue: () =>
      liveQueue.snapshot().items.map((item) => ({
        ...videoStore.getReadyVideo(item.videoId),
        queueItemId: item.id,
      })),
    getFallback: () => {
      const fallbackVideoId = settingsStore.snapshot().fallbackVideoId;
      return fallbackVideoId
        ? { ...videoStore.getReadyVideo(fallbackVideoId), isFallback: true }
        : null;
    },
  });
  await mediaProcessor.init?.();
  await youtubeIntegration.init?.();
  youtubeIntegration.start?.();
  await telegramIntegration.init?.();
  const monitoringService =
    monitoring ??
    new MonitoringService({
      controller: streamController,
      youtube: youtubeIntegration,
      store: new MonitoringStore({ rootDir: dataDir, repository: stateRepository }),
    });
  await monitoringService.init?.();
  monitoringService.start?.();
  const storageMonitor = storage ?? new StorageMonitor({ path: dataDir });
  await storageMonitor.snapshot().catch((error) => {
    console.error("StreamLab storage status failed.", error);
  });
  const captureMonitoring = async () => {
    try {
      await monitoringService.capture?.();
    } catch (error) {
      console.error("StreamLab monitoring capture failed.", error);
    }
  };

  const queueSnapshot = () => {
    const snapshot = liveQueue.snapshot();
    return {
      ...snapshot,
      items: snapshot.items.map((item) => ({
        ...item,
        video: videoStore.getVideo(item.videoId),
      })),
    };
  };

  const playlistsSnapshot = () =>
    playlistStore.list().map((playlist) => ({
      ...playlist,
      items: playlist.items.map((item) => ({
        ...item,
        video: videoStore.getVideo(item.videoId),
      })),
    }));

  let streamStartInProgress = false;
  const deletingVideoIds = new Set();
  const streamEventClients = new Set();
  const realtimeEventClients = new Set();
  const streamIsActive = () =>
    streamStartInProgress ||
    streamController.isActive?.() ||
    ["LIVE", "STARTING", "DEGRADED", "RECONNECTING", "STOPPING"].includes(
      streamController.snapshot().status,
    );

  const server = createServer(async (request, response) => {
    setCommonHeaders(request, response, corsOrigins);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const mutation = mutationMetadata(request.method, url.pathname);
    if (mutation) {
      response.once("finish", () => {
        const status = response.statusCode < 400 ? "SUCCESS" : "FAILED";
        void auditStore.append({
          ...mutation,
          status,
          details: { method: request.method, pathname: url.pathname, statusCode: response.statusCode },
        }).catch((error) => console.error("StreamLab audit write failed.", error));
        if (status === "SUCCESS") {
          void realtimeHub.publish("STATE_CHANGED", {
            resource: mutation.targetType,
            action: mutation.action,
            targetId: mutation.targetId,
          }).catch((error) => console.error("StreamLab event publish failed.", error));
        }
      });
    }
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        const [databaseHealth, realtimeHealth, storageStatus] = await Promise.all([
          databaseService.health?.().catch(() => ({ configured: databaseService.configured, connected: false })),
          realtimeHub.health?.().catch(() => realtimeHub.snapshot()),
          storageMonitor.snapshot().catch(() => storageMonitor.last),
        ]);
        json(response, 200, {
          ok: true,
          service: "streamlab-media",
          ffmpeg: streamController.checkFfmpeg(),
          processing: mediaProcessor.snapshot?.() ?? null,
          queue: { items: liveQueue.snapshot().items.length },
          database: databaseHealth,
          realtime: realtimeHealth,
          storage: storageStatus,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/auth/session") {
        const session = ownerAuth.authenticate(request);
        json(response, 200, session ? { authenticated: true, ...session } : { authenticated: false });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJson(request, 8 * 1024);
        const session = ownerAuth.login(
          request.socket.remoteAddress || "unknown",
          body.username,
          body.password,
        );
        response.setHeader("Set-Cookie", session.setCookie);
        json(response, 200, {
          authenticated: true,
          owner: session.owner,
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        ownerAuth.assertAuthenticated(request, { requireCsrf: true });
        response.setHeader("Set-Cookie", ownerAuth.clearCookie);
        json(response, 200, { authenticated: false });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/youtube/oauth/callback") {
        try {
          await youtubeIntegration.completeOAuth({
            code: url.searchParams.get("code"),
            state: url.searchParams.get("state"),
            error: url.searchParams.get("error"),
          });
          await auditStore.append({ action: "YOUTUBE_OAUTH_CONNECTED", targetType: "youtube" });
          await realtimeHub.publish("STATE_CHANGED", { resource: "youtube", action: "YOUTUBE_OAUTH_CONNECTED" });
          redirect(response, "/?youtube=connected");
        } catch (error) {
          await auditStore.append({
            action: "YOUTUBE_OAUTH_CONNECTED",
            targetType: "youtube",
            status: "FAILED",
            details: { code: error?.code || "UNKNOWN" },
          }).catch(() => {});
          if (!(error instanceof ApiError)) console.error(error);
          redirect(response, "/?youtube=error");
        }
        return;
      }

      ownerAuth.assertAuthenticated(request, {
        requireCsrf: !["GET", "HEAD"].includes(request.method || "GET"),
      });

      if (request.method === "GET" && url.pathname === "/api/stream/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          Connection: "keep-alive",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        });
        response.write("retry: 3000\n\n");
        const sendSnapshot = () => {
          response.write(`data: ${JSON.stringify({ stream: streamController.snapshot() })}\n\n`);
        };
        sendSnapshot();
        const interval = setInterval(sendSnapshot, 1_000);
        interval.unref?.();
        streamEventClients.add(response);
        request.once("close", () => {
          clearInterval(interval);
          streamEventClients.delete(response);
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/realtime/stream") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          Connection: "keep-alive",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        });
        response.write(`data: ${JSON.stringify({ type: "READY", occurredAt: new Date().toISOString() })}\n\n`);
        const unsubscribe = realtimeHub.subscribe((event) => {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 20_000);
        keepAlive.unref?.();
        realtimeEventClients.add(response);
        request.once("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
          realtimeEventClients.delete(response);
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/videos") {
        json(response, 200, { videos: videoStore.listVideos() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/uploads") {
        json(response, 200, { uploads: videoStore.listActiveUploads() });
        return;
      }

      const activeUploadMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)$/);
      if (request.method === "DELETE" && activeUploadMatch) {
        const upload = await videoStore.cancelUpload(activeUploadMatch[1]);
        json(response, 200, { upload, uploads: videoStore.listActiveUploads() });
        return;
      }

      const thumbnailMatch = url.pathname.match(/^\/api\/videos\/([^/]+)\/thumbnail$/);
      if (request.method === "GET" && thumbnailMatch) {
        response.setHeader("Content-Type", "image/jpeg");
        response.setHeader("Cache-Control", "private, max-age=3600");
        createReadStream(videoStore.getThumbnailPath(thumbnailMatch[1])).pipe(response);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/storage/status") {
        json(response, 200, { storage: await storageMonitor.snapshot() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/compression-profiles") {
        json(response, 200, { profiles: listCompressionProfiles() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/audit") {
        json(response, 200, { entries: await auditStore.list({ limit: url.searchParams.get("limit") }) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/settings/stream") {
        json(response, 200, { settings: settingsStore.snapshot() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/stream-presets") {
        json(response, 200, { presets: streamPresetStore.list() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/youtube/status") {
        json(response, 200, { youtube: youtubeIntegration.snapshot() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/monitoring/status") {
        json(response, 200, {
          monitoring: monitoringService.snapshot({ hours: url.searchParams.get("hours") }),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/telegram/status") {
        json(response, 200, { telegram: telegramIntegration.snapshot() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/telegram/connect") {
        const body = await readJson(request, 8 * 1024);
        const snapshot = await telegramIntegration.connect(body.token);
        json(response, 200, { telegram: snapshot });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/telegram/disconnect") {
        const snapshot = await telegramIntegration.disconnect();
        json(response, 200, { telegram: snapshot });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/youtube/oauth/start") {
        const authorizationUrl = await youtubeIntegration.beginOAuth();
        json(response, 200, { authorizationUrl });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/youtube/disconnect") {
        const snapshot = await youtubeIntegration.disconnect();
        json(response, 200, { youtube: snapshot });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/youtube/refresh") {
        const snapshot = await youtubeIntegration.refreshAll();
        json(response, 200, { youtube: snapshot });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/youtube/broadcast/select") {
        const body = await readJson(request, 8 * 1024);
        const snapshot = await youtubeIntegration.selectBroadcast(body.broadcastId);
        json(response, 200, { youtube: snapshot });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/youtube/stats") {
        json(response, 200, {
          stats: youtubeIntegration.history({ hours: url.searchParams.get("hours") }),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/youtube/stream-preset") {
        const body = await readJson(request, 8 * 1024);
        const ingestion = youtubeIntegration.getSelectedIngestion();
        buildTarget(ingestion.streamUrl, ingestion.streamKey);
        const youtubeSnapshot = youtubeIntegration.snapshot();
        const createdPreset = await streamPresetStore.create({
          name:
            typeof body.name === "string" && body.name.trim()
              ? body.name.trim()
              : `YouTube · ${youtubeSnapshot.selected?.title || youtubeSnapshot.channel?.title || "Ефір"}`,
          ...ingestion,
        });
        json(response, 201, {
          preset: streamPresetStore.list().find((preset) => preset.id === createdPreset.id),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/stream-presets") {
        const body = await readJson(request);
        const input = {
          name: body.name,
          streamUrl: typeof body.streamUrl === "string" ? body.streamUrl.trim() : body.streamUrl,
          streamKey: typeof body.streamKey === "string" ? body.streamKey.trim() : body.streamKey,
        };
        buildTarget(input.streamUrl, input.streamKey);
        const createdPreset = await streamPresetStore.create(input);
        json(response, 201, {
          preset: streamPresetStore.list().find((preset) => preset.id === createdPreset.id),
        });
        return;
      }

      const streamPresetMatch = url.pathname.match(/^\/api\/stream-presets\/([^/]+)$/);
      if (request.method === "GET" && streamPresetMatch) {
        json(response, 200, { preset: streamPresetStore.get(streamPresetMatch[1]) });
        return;
      }

      if (request.method === "PUT" && streamPresetMatch) {
        const body = await readJson(request);
        const input = {
          name: body.name,
          streamUrl: typeof body.streamUrl === "string" ? body.streamUrl.trim() : body.streamUrl,
          streamKey: typeof body.streamKey === "string" ? body.streamKey.trim() : body.streamKey,
        };
        buildTarget(input.streamUrl, input.streamKey);
        const updatedPreset = await streamPresetStore.update(streamPresetMatch[1], input);
        json(response, 200, {
          preset: streamPresetStore.list().find((preset) => preset.id === updatedPreset.id),
        });
        return;
      }

      if (request.method === "DELETE" && streamPresetMatch) {
        await streamPresetStore.remove(streamPresetMatch[1]);
        json(response, 200, { presets: streamPresetStore.list() });
        return;
      }

      if (request.method === "PATCH" && url.pathname === "/api/settings/stream") {
        if (streamIsActive()) {
          throw new ApiError(
            409,
            "STREAM_SETTINGS_LOCKED",
            "Змініть профіль ефіру після зупинки трансляції.",
          );
        }
        const body = await readJson(request);
        if (body.fallbackVideoId !== undefined && body.fallbackVideoId !== null) {
          videoStore.getReadyVideo(body.fallbackVideoId);
        }
        const updatedSettings = await settingsStore.updateStream(body);
        json(response, 200, { settings: updatedSettings });
        return;
      }

      const deleteVideoMatch = url.pathname.match(/^\/api\/videos\/([^/]+)$/);
      if (request.method === "DELETE" && deleteVideoMatch) {
        const videoId = deleteVideoMatch[1];
        if (deletingVideoIds.has(videoId)) {
          throw new ApiError(409, "VIDEO_DELETE_IN_PROGRESS", "Відео вже видаляється.");
        }
        deletingVideoIds.add(videoId);
        try {
          const video = videoStore.getVideo(videoId);
          if (!video) throw new ApiError(404, "UPLOAD_NOT_FOUND", "Відео не знайдено.");
          if (["UPLOADING", "ANALYZING", "PROCESSING"].includes(video.status)) {
            throw new ApiError(
              409,
              "VIDEO_BUSY",
              "Дочекайтеся завершення завантаження або обробки відео.",
            );
          }
          const stream = streamController.snapshot();
          if (
            streamIsActive() &&
            (streamStartInProgress || streamController.usesVideo?.(videoId) || stream.videoId === videoId)
          ) {
            throw new ApiError(
              409,
              "VIDEO_IN_USE",
              "Це відео використовується в ефірі. Спочатку зупиніть трансляцію.",
            );
          }
          await liveQueue.removeVideo(videoId);
          await playlistStore.removeVideo(videoId);
          if (settingsStore.snapshot().fallbackVideoId === videoId) {
            await settingsStore.updateStream({ fallbackVideoId: null });
          }
          const deletedVideo = await videoStore.deleteVideo(videoId);
          json(response, 200, { video: deletedVideo, queue: queueSnapshot() });
        } finally {
          deletingVideoIds.delete(videoId);
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/queue") {
        json(response, 200, { queue: queueSnapshot() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/playlists") {
        json(response, 200, { playlists: playlistsSnapshot() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/playlists") {
        const body = await readJson(request);
        await playlistStore.create(body.name);
        json(response, 201, { playlists: playlistsSnapshot() });
        return;
      }

      const playlistMatch = url.pathname.match(/^\/api\/playlists\/([^/]+)$/);
      if (request.method === "PATCH" && playlistMatch) {
        const body = await readJson(request);
        await playlistStore.rename(playlistMatch[1], body.name);
        json(response, 200, { playlists: playlistsSnapshot() });
        return;
      }
      if (request.method === "DELETE" && playlistMatch) {
        await playlistStore.remove(playlistMatch[1]);
        json(response, 200, { playlists: playlistsSnapshot() });
        return;
      }

      const playlistItemsMatch = url.pathname.match(/^\/api\/playlists\/([^/]+)\/items$/);
      if (request.method === "POST" && playlistItemsMatch) {
        const body = await readJson(request);
        videoStore.getReadyVideo(body.videoId);
        await playlistStore.addItem(playlistItemsMatch[1], body.videoId);
        json(response, 201, { playlists: playlistsSnapshot() });
        return;
      }

      const playlistItemMatch = url.pathname.match(/^\/api\/playlists\/([^/]+)\/items\/([^/]+)$/);
      if (request.method === "DELETE" && playlistItemMatch) {
        await playlistStore.removeItem(playlistItemMatch[1], playlistItemMatch[2]);
        json(response, 200, { playlists: playlistsSnapshot() });
        return;
      }

      const playlistReorderMatch = url.pathname.match(/^\/api\/playlists\/([^/]+)\/reorder$/);
      if (request.method === "POST" && playlistReorderMatch) {
        const body = await readJson(request);
        await playlistStore.reorder(playlistReorderMatch[1], body.itemIds);
        json(response, 200, { playlists: playlistsSnapshot() });
        return;
      }

      const playlistLoadMatch = url.pathname.match(/^\/api\/playlists\/([^/]+)\/load$/);
      if (request.method === "POST" && playlistLoadMatch) {
        if (streamIsActive()) {
          throw new ApiError(409, "STREAM_ACTIVE", "Завантажити плейлист у чергу можна після зупинки ефіру.");
        }
        const playlist = playlistStore.require(playlistLoadMatch[1]);
        for (const item of playlist.items) videoStore.getReadyVideo(item.videoId);
        await liveQueue.replace(playlist.items.map((item) => item.videoId));
        json(response, 200, { queue: queueSnapshot() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/queue/items") {
        const body = await readJson(request);
        if (deletingVideoIds.has(body.videoId)) {
          throw new ApiError(409, "VIDEO_DELETE_IN_PROGRESS", "Відео вже видаляється.");
        }
        videoStore.getReadyVideo(body.videoId);
        await liveQueue.add(body.videoId);
        json(response, 201, { queue: queueSnapshot() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/queue/reorder") {
        const body = await readJson(request);
        await liveQueue.reorder(body.itemIds);
        json(response, 200, { queue: queueSnapshot() });
        return;
      }

      const queueItemMatch = url.pathname.match(/^\/api\/queue\/items\/([^/]+)$/);
      if (request.method === "DELETE" && queueItemMatch) {
        if (streamController.isCurrentQueueItem?.(queueItemMatch[1])) {
          throw new ApiError(
            409,
            "QUEUE_ITEM_PLAYING",
            "Поточне відео не можна видалити з черги під час відтворення.",
          );
        }
        await liveQueue.remove(queueItemMatch[1]);
        json(response, 200, { queue: queueSnapshot() });
        return;
      }

      const playNextMatch = url.pathname.match(/^\/api\/queue\/items\/([^/]+)\/play-next$/);
      if (request.method === "POST" && playNextMatch) {
        if (streamController.isCurrentQueueItem?.(playNextMatch[1])) {
          throw new ApiError(409, "QUEUE_ITEM_PLAYING", "Це відео вже відтворюється.");
        }
        await liveQueue.moveNext(
          playNextMatch[1],
          streamIsActive() ? streamController.snapshot().queueItemId : null,
        );
        json(response, 200, { queue: queueSnapshot() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/uploads") {
        const body = await readJson(request);
        const upload = await videoStore.createUpload({
          ...body,
          compressionProfile: body.compressionProfile || settingsStore.snapshot().compressionProfile,
        });
        json(response, 201, { upload });
        return;
      }

      const chunkMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/chunks$/);
      if (request.method === "PUT" && chunkMatch) {
        const offset = Number(url.searchParams.get("offset"));
        const upload = await videoStore.appendChunk(chunkMatch[1], offset, request);
        json(response, 200, { upload });
        return;
      }

      const completeMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/complete$/);
      if (request.method === "POST" && completeMatch) {
        const video = await videoStore.completeUpload(completeMatch[1]);
        if (["ANALYZING", "PROCESSING"].includes(video.status)) mediaProcessor.enqueue(video.id);
        json(response, video.status === "READY" ? 200 : 202, { video });
        return;
      }

      const retryProcessingMatch = url.pathname.match(/^\/api\/videos\/([^/]+)\/process$/);
      if (request.method === "POST" && retryProcessingMatch) {
        if (deletingVideoIds.has(retryProcessingMatch[1])) {
          throw new ApiError(409, "VIDEO_DELETE_IN_PROGRESS", "Відео вже видаляється.");
        }
        const video = await videoStore.retryProcessing(retryProcessingMatch[1]);
        mediaProcessor.enqueue(video.id);
        json(response, 202, { video });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/stream/status") {
        json(response, 200, { stream: streamController.snapshot() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/stream/start") {
        if (streamStartInProgress) {
          throw new ApiError(409, "STREAM_ALREADY_RUNNING", "Трансляція вже запускається.");
        }
        const body = await readJson(request);
        if (
          liveQueue.snapshot().items.length === 0 &&
          !settingsStore.snapshot().fallbackVideoId
        ) {
          throw new ApiError(
            409,
            "QUEUE_EMPTY",
            "Додайте готове відео до черги або виберіть резервне відео.",
          );
        }
        const target = buildTarget(body.streamUrl, body.streamKey);
        streamStartInProgress = true;
        try {
          const stream = await streamController.start({
            target,
            streamKey: body.streamKey.trim(),
            videoBitrateKbps: settingsStore.snapshot().videoBitrateKbps,
          });
          await captureMonitoring();
          json(response, 202, { stream });
        } finally {
          streamStartInProgress = false;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/stream/stop") {
        const stream = await streamController.stop();
        await captureMonitoring();
        json(response, 200, { stream });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/stream/skip") {
        const stream = await streamController.skip();
        await captureMonitoring();
        json(response, 200, { stream });
        return;
      }

      throw new ApiError(404, "NOT_FOUND", "Маршрут не знайдено.");
    } catch (error) {
      const normalizedError = normalizeServerError(error);
      if (normalizedError.retryAfter) {
        response.setHeader("Retry-After", String(normalizedError.retryAfter));
      }
      if (!(error instanceof ApiError)) console.error(error);
      json(response, normalizedError.status, {
        error: { code: normalizedError.code, message: normalizedError.message },
      });
    }
  });

  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/events" || !ownerAuth.authenticate(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  });
  webSocketServer.on("connection", (client) => {
    client.send(JSON.stringify({ type: "READY", occurredAt: new Date().toISOString() }));
    const unsubscribe = realtimeHub.subscribe((event) => {
      if (client.readyState === 1) client.send(JSON.stringify(event));
    });
    client.once("close", unsubscribe);
    client.once("error", unsubscribe);
  });

  return {
    server,
    store: videoStore,
    controller: streamController,
    processor: mediaProcessor,
    queue: liveQueue,
    settings: settingsStore,
    presets: streamPresetStore,
    youtube: youtubeIntegration,
    monitoring: monitoringService,
    telegram: telegramIntegration,
    playlists: playlistStore,
    audit: auditStore,
    realtime: realtimeHub,
    database: databaseService,
    listen(port = 8788, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      await monitoringService.stop?.();
      youtubeIntegration.stop?.();
      await mediaProcessor.shutdown?.();
      if (streamController.shutdown) await streamController.shutdown();
      else await streamController.stop();
      for (const response of streamEventClients) response.end();
      streamEventClients.clear();
      for (const response of realtimeEventClients) response.end();
      realtimeEventClients.clear();
      for (const client of webSocketServer.clients) client.close();
      webSocketServer.close();
      await auditStore.close?.();
      await realtimeHub.close?.();
      await databaseService.close?.();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const host = process.env.MEDIA_API_HOST || "127.0.0.1";
  const port = Number(process.env.MEDIA_API_PORT || 8788);
  const app = await createMvpServer();
  const address = await app.listen(port, host);
  console.log(`StreamLab media server: http://${address.address}:${address.port}`);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
