import { spawn } from "node:child_process";
import { compressionProfile } from "./compression-profiles.mjs";

const MAX_TOOL_OUTPUT_BYTES = 8 * 1024 * 1024;
const ALLOWED_PRESETS = new Set([
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
]);

class MediaProcessingError extends Error {
  constructor(message, publicMessage = message) {
    super(message);
    this.name = "MediaProcessingError";
    this.publicMessage = publicMessage;
  }
}

function collectProcess(command, args, { spawnImpl = spawn, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const abort = () => child.kill("SIGTERM");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_TOOL_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_TOOL_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.once("error", (error) => {
      signal?.removeEventListener?.("abort", abort);
      reject(error);
    });
    child.once("close", (code, processSignal) => {
      signal?.removeEventListener?.("abort", abort);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (signal?.aborted) {
        const error = new Error("Аналіз відео зупинено.");
        error.name = "AbortError";
        reject(error);
        return;
      }
      if (code === 0) {
        resolve({ stdout: output, stderr: errorOutput });
        return;
      }
      reject(
        new MediaProcessingError(
          `${command} завершився з кодом ${code ?? "null"}${processSignal ? ` (${processSignal})` : ""}: ${errorOutput}`,
          "Не вдалося прочитати структуру відеофайлу.",
        ),
      );
    });
  });
}

function parseRate(value) {
  if (typeof value !== "string") return null;
  const [numerator, denominator = "1"] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? Number(result.toFixed(3)) : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function parseProbeResult(payload) {
  const video = payload?.streams?.find((stream) => stream.codec_type === "video");
  const audio = payload?.streams?.find((stream) => stream.codec_type === "audio");
  const durationSeconds = finiteNumber(payload?.format?.duration ?? video?.duration);

  if (!video || !durationSeconds || durationSeconds <= 0) {
    throw new MediaProcessingError(
      "ffprobe не знайшов валідний відеопотік або тривалість.",
      "Файл не містить коректного відеопотоку.",
    );
  }
  if (!audio) {
    throw new MediaProcessingError(
      "ffprobe не знайшов аудіопотік.",
      "Файл не містить аудіодоріжки, необхідної для музичної трансляції.",
    );
  }

  return {
    durationSeconds: Number(durationSeconds.toFixed(3)),
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    fps: parseRate(video.avg_frame_rate || video.r_frame_rate),
    videoCodec: video.codec_name || null,
    audioCodec: audio.codec_name || null,
    audioSampleRate: finiteNumber(audio.sample_rate),
    bitrate: finiteNumber(payload?.format?.bit_rate),
    format: payload?.format?.format_name || null,
  };
}

export async function probeMedia(inputPath, {
  ffprobePath = "ffprobe",
  spawnImpl = spawn,
  signal,
} = {}) {
  const { stdout } = await collectProcess(
    ffprobePath,
    [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      inputPath,
    ],
    { spawnImpl, signal },
  );
  try {
    return parseProbeResult(JSON.parse(stdout));
  } catch (error) {
    if (error instanceof MediaProcessingError) throw error;
    throw new MediaProcessingError(
      `Некоректна відповідь ffprobe: ${error.message}`,
      "Не вдалося прочитати метадані відеофайлу.",
    );
  }
}

export function validateStreamMedia(media) {
  if (
    media.videoCodec !== "h264" ||
    media.audioCodec !== "aac" ||
    media.width !== 1920 ||
    media.height !== 1080 ||
    !media.fps ||
    Math.abs(media.fps - 30) > 0.2
  ) {
    throw new MediaProcessingError(
      `Вихідний профіль не пройшов перевірку: ${JSON.stringify(media)}`,
      "Створена stream-версія не пройшла перевірку профілю 1080p30 H.264/AAC.",
    );
  }
  return media;
}

export function buildTranscodeArgs({
  inputPath,
  outputPath,
  videoBitrate = "8M",
  audioBitrate = "128k",
  preset = "veryfast",
}) {
  const safePreset = ALLOWED_PRESETS.has(preset) ? preset : "veryfast";
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
    "-r",
    "30",
    "-fps_mode",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    safePreset,
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-b:v",
    videoBitrate,
    "-maxrate",
    videoBitrate,
    "-bufsize",
    "20M",
    "-g",
    "60",
    "-keyint_min",
    "60",
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
    "-ar",
    "44100",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    outputPath,
  ];
}

export function buildThumbnailArgs({ inputPath, outputPath, durationSeconds = 0 }) {
  const seekSeconds = Math.max(0, Math.min(10, Number(durationSeconds) * 0.1 || 1));
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    seekSeconds.toFixed(3),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=480:-2:force_original_aspect_ratio=decrease",
    "-q:v",
    "3",
    outputPath,
  ];
}

export async function generateThumbnail({
  inputPath,
  outputPath,
  durationSeconds,
  ffmpegPath = "ffmpeg",
  spawnImpl = spawn,
  signal,
}) {
  await collectProcess(
    ffmpegPath,
    buildThumbnailArgs({ inputPath, outputPath, durationSeconds }),
    { spawnImpl, signal },
  );
}

export function transcodeMedia({
  inputPath,
  outputPath,
  durationSeconds,
  ffmpegPath = "ffmpeg",
  videoBitrate = "8M",
  audioBitrate = "128k",
  preset = "veryfast",
  spawnImpl = spawn,
  signal,
  onProgress = () => {},
}) {
  const args = buildTranscodeArgs({
    inputPath,
    outputPath,
    videoBitrate,
    audioBitrate,
    preset,
  });

  return new Promise((resolve, reject) => {
    const child = spawnImpl(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let bufferedProgress = "";
    let stderr = "";
    let lastProgress = -1;

    const abort = () => child.kill("SIGTERM");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk) => {
      bufferedProgress += chunk.toString("utf8");
      const lines = bufferedProgress.split(/\r?\n/);
      bufferedProgress = lines.pop() || "";
      for (const line of lines) {
        const separator = line.indexOf("=");
        if (separator === -1) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (!["out_time_us", "out_time_ms"].includes(key)) continue;
        const elapsedSeconds = Number(value) / 1_000_000;
        const progress = Math.min(99, Math.max(0, Math.floor((elapsedSeconds / durationSeconds) * 100)));
        if (Number.isFinite(progress) && progress > lastProgress) {
          lastProgress = progress;
          onProgress(progress);
        }
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    child.once("error", reject);
    child.once("close", (code, processSignal) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        const error = new Error("Обробку відео зупинено.");
        error.name = "AbortError";
        reject(error);
        return;
      }
      if (code === 0) {
        onProgress(100);
        resolve();
        return;
      }
      reject(
        new MediaProcessingError(
          `FFmpeg завершився з кодом ${code ?? "null"}${processSignal ? ` (${processSignal})` : ""}: ${stderr.trim()}`,
          "FFmpeg не зміг створити stream-версію відео.",
        ),
      );
    });
  });
}

export class MediaProcessor {
  constructor({
    store,
    ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
    ffprobePath = process.env.FFPROBE_PATH || "ffprobe",
    videoBitrate = process.env.MEDIA_TRANSCODE_VIDEO_BITRATE || "8M",
    audioBitrate = process.env.MVP_AUDIO_BITRATE || "128k",
    preset = process.env.MEDIA_TRANSCODE_PRESET || "veryfast",
    keepOriginalUploads = process.env.MEDIA_KEEP_ORIGINAL_UPLOADS === "true",
    probeImpl = probeMedia,
    transcodeImpl = transcodeMedia,
    thumbnailImpl = generateThumbnail,
    onEvent = () => {},
    logger = console,
  } = {}) {
    if (!store) throw new Error("MediaProcessor потребує VideoStore.");
    this.store = store;
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.videoBitrate = videoBitrate;
    this.audioBitrate = audioBitrate;
    this.preset = preset;
    this.keepOriginalUploads = keepOriginalUploads;
    this.probeImpl = probeImpl;
    this.transcodeImpl = transcodeImpl;
    this.thumbnailImpl = thumbnailImpl;
    this.onEvent = onEvent;
    this.logger = logger;
    this.queue = [];
    this.queued = new Set();
    this.activeVideoId = null;
    this.abortController = null;
    this.drainPromise = null;
    this.idleWaiters = [];
    this.shuttingDown = false;
    this.lastError = null;
  }

  async init() {
    for (const videoId of this.store.listPendingProcessingIds()) this.enqueue(videoId);
    for (const videoId of this.store.listMissingThumbnailIds?.() || []) this.enqueueThumbnail(videoId);
  }

  enqueue(videoId) {
    if (this.shuttingDown || this.queued.has(videoId) || this.activeVideoId === videoId) return;
    this.queue.push({ videoId, thumbnailOnly: false });
    this.queued.add(videoId);
    if (!this.drainPromise) {
      this.drainPromise = Promise.resolve().then(() => this.drain());
    }
  }

  enqueueThumbnail(videoId) {
    if (this.shuttingDown || this.queued.has(videoId) || this.activeVideoId === videoId) return;
    this.queue.push({ videoId, thumbnailOnly: true });
    this.queued.add(videoId);
    if (!this.drainPromise) this.drainPromise = Promise.resolve().then(() => this.drain());
  }

  async drain() {
    try {
      while (!this.shuttingDown && this.queue.length) {
        const task = this.queue.shift();
        const videoId = task.videoId;
        this.queued.delete(videoId);
        this.activeVideoId = videoId;
        this.abortController = new AbortController();
        if (task.thumbnailOnly) await this.processThumbnail(videoId, this.abortController.signal);
        else await this.processOne(videoId, this.abortController.signal);
        this.activeVideoId = null;
        this.abortController = null;
      }
    } finally {
      this.activeVideoId = null;
      this.abortController = null;
      this.drainPromise = null;
      if (!this.queue.length) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      } else if (!this.shuttingDown) {
        this.drainPromise = Promise.resolve().then(() => this.drain());
      }
    }
  }

  async processOne(videoId, signal) {
    try {
      await this.onEvent("VIDEO_PROCESSING_STARTED", { videoId });
      await this.store.beginAnalysis(videoId);
      const paths = this.store.getProcessingPaths(videoId);
      const profile = compressionProfile(paths.compressionProfile);
      const sourceMedia = await this.probeImpl(paths.sourcePath, {
        ffprobePath: this.ffprobePath,
        signal,
      });
      await this.store.beginTranscode(videoId, sourceMedia);
      await this.transcodeImpl({
        inputPath: paths.sourcePath,
        outputPath: paths.tempOutputPath,
        durationSeconds: sourceMedia.durationSeconds,
        ffmpegPath: this.ffmpegPath,
        videoBitrate: profile?.videoBitrate || this.videoBitrate,
        audioBitrate: profile?.audioBitrate || this.audioBitrate,
        preset: profile?.preset || this.preset,
        signal,
        onProgress: (progress) => void this.store.updateProcessingProgress(videoId, progress),
      });
      const streamMedia = validateStreamMedia(
        await this.probeImpl(paths.tempOutputPath, {
          ffprobePath: this.ffprobePath,
          signal,
        }),
      );
      await this.thumbnailImpl({
        inputPath: paths.tempOutputPath,
        outputPath: paths.tempThumbnailPath,
        durationSeconds: streamMedia.durationSeconds,
        ffmpegPath: this.ffmpegPath,
        signal,
      });
      await this.store.completeProcessing(videoId, streamMedia, {
        keepOriginal: this.keepOriginalUploads,
      });
      await this.onEvent("VIDEO_READY", { videoId });
      this.lastError = null;
    } catch (error) {
      if (this.shuttingDown && (signal.aborted || error?.name === "AbortError")) return;
      const publicMessage =
        error instanceof MediaProcessingError
          ? error.publicMessage
          : "Не вдалося підготувати відео до трансляції.";
      this.lastError = publicMessage;
      this.logger.error(`Помилка обробки відео ${videoId}:`, error);
      await this.store.failProcessing(videoId, publicMessage).catch((storeError) => {
        this.logger.error(`Не вдалося зберегти помилку обробки ${videoId}:`, storeError);
      });
      await this.onEvent("VIDEO_PROCESSING_FAILED", { videoId, message: publicMessage });
    }
  }

  async processThumbnail(videoId, signal) {
    try {
      const paths = this.store.getThumbnailBackfillPaths(videoId);
      await this.thumbnailImpl({
        inputPath: paths.inputPath,
        outputPath: paths.tempThumbnailPath,
        durationSeconds: paths.durationSeconds,
        ffmpegPath: this.ffmpegPath,
        signal,
      });
      await this.store.completeThumbnail(videoId);
      await this.onEvent("VIDEO_THUMBNAIL_READY", { videoId });
    } catch (error) {
      if (this.shuttingDown && (signal.aborted || error?.name === "AbortError")) return;
      this.logger.error(`Помилка створення прев’ю відео ${videoId}:`, error);
      await this.store.failThumbnail?.(videoId);
      await this.onEvent("VIDEO_THUMBNAIL_FAILED", { videoId });
    }
  }

  waitForIdle() {
    if (!this.queue.length && !this.activeVideoId && !this.drainPromise) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  snapshot() {
    return {
      activeVideoId: this.activeVideoId,
      queued: this.queue.length,
      lastError: this.lastError,
    };
  }

  async shutdown() {
    this.shuttingDown = true;
    this.queue = [];
    this.queued.clear();
    this.abortController?.abort();
    await this.drainPromise?.catch(() => {});
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
