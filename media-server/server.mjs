import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ApiError } from "./api-error.mjs";
import { createOwnerAuth } from "./auth.mjs";
import { VideoStore } from "./store.mjs";
import { StreamController } from "./stream-controller.mjs";
import { EncryptedStreamStateStore } from "./stream-state-store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const DEFAULT_ALLOWED_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
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
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,X-CSRF-Token");
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
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
} = {}) {
  const videoStore = store ?? new VideoStore({ rootDir: dataDir });
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
      videoBitrate: process.env.MVP_VIDEO_BITRATE || "10M",
      audioBitrate: process.env.MVP_AUDIO_BITRATE || "128k",
      stateStore: encryptedStateStore,
    });
  const corsOrigins = allowedOrigins.length ? allowedOrigins : DEFAULT_ALLOWED_ORIGINS;
  const ownerAuth = auth ?? createOwnerAuth();
  await videoStore.init();
  await encryptedStateStore?.init();
  await streamController.init?.({
    resolveVideo: (videoId) => videoStore.getReadyVideo(videoId),
  });

  const server = createServer(async (request, response) => {
    setCommonHeaders(request, response, corsOrigins);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, {
          ok: true,
          service: "streamlab-media",
          ffmpeg: streamController.checkFfmpeg(),
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

      ownerAuth.assertAuthenticated(request, {
        requireCsrf: !["GET", "HEAD"].includes(request.method || "GET"),
      });

      if (request.method === "GET" && url.pathname === "/api/videos") {
        json(response, 200, { videos: videoStore.listVideos() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/uploads") {
        const upload = await videoStore.createUpload(await readJson(request));
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
        json(response, 200, { video });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/stream/status") {
        json(response, 200, { stream: streamController.snapshot() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/stream/start") {
        const body = await readJson(request);
        const video = videoStore.getReadyVideo(body.videoId);
        const target = buildTarget(body.streamUrl, body.streamKey);
        const stream = await streamController.start({
          video,
          target,
          streamKey: body.streamKey.trim(),
        });
        json(response, 202, { stream });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/stream/stop") {
        const stream = await streamController.stop();
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

  return {
    server,
    store: videoStore,
    controller: streamController,
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
      if (streamController.shutdown) await streamController.shutdown();
      else await streamController.stop();
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
