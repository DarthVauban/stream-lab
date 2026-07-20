import { spawn } from "node:child_process";
import { ApiError } from "./api-error.mjs";
import { compressionProfile } from "./compression-profiles.mjs";
import { convertImageToWebp } from "./image-processor.mjs";
import { hashFileSha256 } from "./store.mjs";

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
const HARDWARE_ENCODERS = Object.freeze([
  { id: "NVIDIA_NVENC", codec: "h264_nvenc", label: "NVIDIA NVENC" },
  { id: "INTEL_QSV", codec: "h264_qsv", label: "Intel Quick Sync" },
  { id: "AMD_AMF", codec: "h264_amf", label: "AMD AMF" },
  { id: "APPLE_VIDEOTOOLBOX", codec: "h264_videotoolbox", label: "Apple VideoToolbox" },
]);

export function normalizeEncoderMode(value, fallback = "AUTO") {
  const mode = typeof value === "string" ? value.trim().toUpperCase() : "";
  return ["AUTO", "CPU", "GPU"].includes(mode) ? mode : fallback;
}

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
    videoBitrate: finiteNumber(video.bit_rate),
    audioCodec: audio.codec_name || null,
    audioBitrate: finiteNumber(audio.bit_rate),
    audioSampleRate: finiteNumber(audio.sample_rate),
    audioChannels: finiteNumber(audio.channels),
    audioChannelLayout: audio.channel_layout || null,
    pixelFormat: video.pix_fmt || null,
    fieldOrder: video.field_order || null,
    progressive: !video.field_order || ["progressive", "unknown"].includes(video.field_order),
    rotation: finiteNumber(
      Math.abs(Number(video.tags?.rotate)) ||
      Math.abs(Number(video.side_data_list?.find((item) => Number.isFinite(Number(item.rotation)))?.rotation)),
    ) ?? 0,
    colorSpace: video.color_space || null,
    colorPrimaries: video.color_primaries || null,
    colorTransfer: video.color_transfer || null,
    sizeBytes: finiteNumber(payload?.format?.size),
    bitrate: finiteNumber(payload?.format?.bit_rate),
    format: payload?.format?.format_name || null,
  };
}

export function parseVolumeDetect(output) {
  const meanMatch = String(output).match(/mean_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/i);
  const peakMatch = String(output).match(/max_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/i);
  const number = (match) => {
    if (!match) return null;
    if (match[1].toLowerCase().includes("inf")) return Number.NEGATIVE_INFINITY;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  };
  return { audioMeanVolumeDb: number(meanMatch), audioPeakDb: number(peakMatch) };
}

export async function analyzeAudioLevels(inputPath, {
  ffmpegPath = "ffmpeg",
  spawnImpl = spawn,
  signal,
} = {}) {
  const { stderr } = await collectProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { spawnImpl, signal },
  );
  return parseVolumeDetect(stderr);
}

export function buildDecodeValidationArgs(inputPath, {
  startSeconds = null,
  durationSeconds = null,
} = {}) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-xerror",
    "-err_detect",
    "explode",
    ...(Number.isFinite(startSeconds) ? ["-ss", Math.max(0, startSeconds).toFixed(3)] : []),
    "-i",
    inputPath,
    ...(Number.isFinite(durationSeconds) ? ["-t", Math.max(0.1, durationSeconds).toFixed(3)] : []),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-sn",
    "-dn",
    "-f",
    "null",
    "-",
  ];
}

function decodeSegments(durationSeconds, segmentSeconds = 5) {
  const duration = Math.max(0.1, Number(durationSeconds) || 0.1);
  const length = Math.min(segmentSeconds, duration);
  const starts = [0, Math.max(0, duration / 2 - length / 2), Math.max(0, duration - length)];
  return [...new Set(starts.map((value) => Number(value.toFixed(3))))]
    .map((startSeconds) => ({ startSeconds, durationSeconds: length }));
}

export async function validateMediaDecode(inputPath, {
  ffmpegPath = "ffmpeg",
  durationSeconds = null,
  mode = "FULL",
  spawnImpl = spawn,
  signal,
} = {}) {
  const normalizedMode = String(mode).toUpperCase() === "SAMPLE" ? "SAMPLE" : "FULL";
  const segments = normalizedMode === "SAMPLE"
    ? decodeSegments(durationSeconds)
    : [{ startSeconds: null, durationSeconds: null }];
  for (const segment of segments) {
    await collectProcess(
      ffmpegPath,
      buildDecodeValidationArgs(inputPath, segment),
      { spawnImpl, signal },
    );
  }
  return {
    status: "PASSED",
    mode: normalizedMode,
    checkedAt: new Date().toISOString(),
    segments: segments.map((segment) => ({ ...segment })),
  };
}

export async function detectHardwareEncoders({
  ffmpegPath = "ffmpeg",
  spawnImpl = spawn,
  signal,
} = {}) {
  const available = [];
  for (const candidate of HARDWARE_ENCODERS) {
    try {
      await collectProcess(
        ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=128x128:r=1:d=0.1",
          "-frames:v",
          "1",
          "-an",
          "-c:v",
          candidate.codec,
          "-f",
          "null",
          "-",
        ],
        { spawnImpl, signal },
      );
      available.push({ ...candidate });
    } catch {
      // A compiled encoder is only advertised when a real one-frame encode
      // also succeeds with the GPU/device exposed to this process.
    }
  }
  return available;
}

export function selectVideoEncoder(mode, available = []) {
  const normalizedMode = normalizeEncoderMode(mode);
  if (normalizedMode === "CPU") return { id: "CPU", codec: "libx264", label: "CPU · libx264" };
  if (available.length) return { ...available[0] };
  if (normalizedMode === "GPU") {
    throw new MediaProcessingError(
      "GPU encoder requested, but no hardware encoder passed the runtime test.",
      "Обрано GPU, але доступний апаратний H.264 encoder не знайдено.",
    );
  }
  return { id: "CPU", codec: "libx264", label: "CPU · libx264" };
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

export function validateStreamMedia(media, { sourceDurationSeconds = null } = {}) {
  const durationTolerance = sourceDurationSeconds
    ? Math.max(1, Number(sourceDurationSeconds) * 0.005)
    : null;
  if (
    media.videoCodec !== "h264" ||
    media.audioCodec !== "aac" ||
    media.width !== 1920 ||
    media.height !== 1080 ||
    !media.fps ||
    Math.abs(media.fps - 30) > 0.2 ||
    media.pixelFormat !== "yuv420p" ||
    media.audioSampleRate !== 48_000 ||
    media.audioChannels !== 2 ||
    !media.sizeBytes ||
    (durationTolerance !== null && Math.abs(media.durationSeconds - sourceDurationSeconds) > durationTolerance)
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
  encoder = { id: "CPU", codec: "libx264" },
}) {
  const safePreset = ALLOWED_PRESETS.has(preset) ? preset : "veryfast";
  const encoderId = encoder?.id || "CPU";
  const codec = encoder?.codec || "libx264";
  const codecArgs = encoderId === "NVIDIA_NVENC"
    ? ["-c:v", codec, "-preset", "p4", "-rc", "cbr"]
    : encoderId === "INTEL_QSV"
      ? ["-c:v", codec, "-preset", "medium"]
      : encoderId === "AMD_AMF"
        ? ["-c:v", codec, "-quality", "speed", "-rc", "cbr"]
        : encoderId === "APPLE_VIDEOTOOLBOX"
          ? ["-c:v", codec, "-realtime", "0"]
          : ["-c:v", "libx264", "-preset", safePreset];
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
    ...codecArgs,
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
    "48000",
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

export function normalizeThumbnailPosition(positionSeconds, durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ApiError(409, "VIDEO_DURATION_UNAVAILABLE", "Не вдалося визначити тривалість відео.");
  }
  const maximum = Math.max(0, duration - 0.05);
  const hasExplicitPosition = positionSeconds !== null && positionSeconds !== undefined && positionSeconds !== "";
  const requested = hasExplicitPosition
    ? Number(positionSeconds)
    : Math.min(10, duration * 0.1 || 1);
  if (!Number.isFinite(requested) || requested < 0 || requested > maximum + 0.001) {
    throw new ApiError(
      400,
      "INVALID_THUMBNAIL_POSITION",
      `Оберіть момент від 0 до ${maximum.toFixed(1)} секунди.`,
    );
  }
  return Number(Math.min(maximum, requested).toFixed(3));
}

export function buildThumbnailArgs({
  inputPath,
  outputPath,
  durationSeconds = 0,
  positionSeconds = null,
}) {
  const seekSeconds = normalizeThumbnailPosition(positionSeconds, durationSeconds);
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
    "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2",
    "-q:v",
    "3",
    outputPath,
  ];
}

export async function generateThumbnail({
  inputPath,
  outputPath,
  durationSeconds,
  positionSeconds = null,
  ffmpegPath = "ffmpeg",
  spawnImpl = spawn,
  signal,
}) {
  await collectProcess(
    ffmpegPath,
    buildThumbnailArgs({ inputPath, outputPath, durationSeconds, positionSeconds }),
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
  encoder,
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
    encoder,
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
    detectEncodersImpl = detectHardwareEncoders,
    audioAnalysisImpl = analyzeAudioLevels,
    decodeValidationImpl = validateMediaDecode,
    hashFileImpl = hashFileSha256,
    probeImpl = probeMedia,
    transcodeImpl = transcodeMedia,
    thumbnailImpl = generateThumbnail,
    customThumbnailImpl = convertImageToWebp,
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
    this.detectEncodersImpl = detectEncodersImpl;
    this.audioAnalysisImpl = audioAnalysisImpl;
    this.decodeValidationImpl = decodeValidationImpl;
    this.hashFileImpl = hashFileImpl;
    this.probeImpl = probeImpl;
    this.transcodeImpl = transcodeImpl;
    this.thumbnailImpl = thumbnailImpl;
    this.customThumbnailImpl = customThumbnailImpl;
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
    this.hardwareEncoders = [];
    this.encoderDetectionError = null;
  }

  async init() {
    try {
      this.hardwareEncoders = await this.detectEncodersImpl({
        ffmpegPath: this.ffmpegPath,
      });
      this.encoderDetectionError = null;
    } catch (error) {
      this.hardwareEncoders = [];
      this.encoderDetectionError = String(error?.message || error);
    }
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
    this.queue.push({ videoId, thumbnailOnly: true, positionSeconds: null });
    this.queued.add(videoId);
    if (!this.drainPromise) this.drainPromise = Promise.resolve().then(() => this.drain());
  }

  requestThumbnail(videoId, positionSeconds) {
    if (this.shuttingDown) {
      throw new ApiError(503, "PROCESSOR_STOPPING", "Медіапроцесор зупиняється.");
    }
    if (this.queued.has(videoId) || this.activeVideoId === videoId) {
      throw new ApiError(409, "VIDEO_PROCESSING_BUSY", "Для цього відео вже виконується медіаоперація.");
    }
    const paths = this.store.getThumbnailBackfillPaths(videoId);
    const normalizedPosition = normalizeThumbnailPosition(positionSeconds, paths.durationSeconds);
    this.queue.push({ videoId, thumbnailOnly: true, positionSeconds: normalizedPosition });
    this.queued.add(videoId);
    if (!this.drainPromise) this.drainPromise = Promise.resolve().then(() => this.drain());
    return { videoId, positionSeconds: normalizedPosition };
  }

  replaceThumbnail(videoId, buffer) {
    if (this.shuttingDown) {
      throw new ApiError(503, "PROCESSOR_STOPPING", "Медіапроцесор зупиняється.");
    }
    if (this.queued.has(videoId) || this.activeVideoId === videoId) {
      throw new ApiError(409, "VIDEO_PROCESSING_BUSY", "Для цього відео вже виконується медіаоперація.");
    }
    this.store.getThumbnailBackfillPaths(videoId);
    const operation = new Promise((resolve, reject) => {
      this.queue.push({ videoId, customThumbnailBuffer: buffer, resolve, reject });
      this.queued.add(videoId);
      if (!this.drainPromise) this.drainPromise = Promise.resolve().then(() => this.drain());
    });
    return operation;
  }

  async drain() {
    try {
      while (!this.shuttingDown && this.queue.length) {
        const task = this.queue.shift();
        const videoId = task.videoId;
        this.queued.delete(videoId);
        this.activeVideoId = videoId;
        this.abortController = new AbortController();
        try {
          if (task.customThumbnailBuffer) {
            const result = await this.processCustomThumbnail(
              videoId,
              task.customThumbnailBuffer,
              this.abortController.signal,
            );
            task.resolve?.(result);
          } else if (task.thumbnailOnly) {
            await this.processThumbnail(videoId, this.abortController.signal, task.positionSeconds);
          } else {
            await this.processOne(videoId, this.abortController.signal);
          }
        } catch (error) {
          task.reject?.(error);
          if (!task.reject) throw error;
        }
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
    const processingStartedAt = Date.now();
    try {
      await this.onEvent("VIDEO_PROCESSING_STARTED", { videoId });
      await this.store.beginAnalysis(videoId);
      const paths = this.store.getProcessingPaths(videoId);
      const profile = compressionProfile(paths.compressionProfile);
      const probedSourceMedia = await this.probeImpl(paths.sourcePath, {
        ffprobePath: this.ffprobePath,
        signal,
      });
      const [audioLevels, sourceDecodeValidation] = await Promise.all([
        this.audioAnalysisImpl(paths.sourcePath, {
          ffmpegPath: this.ffmpegPath,
          signal,
        }),
        this.decodeValidationImpl(paths.sourcePath, {
          ffmpegPath: this.ffmpegPath,
          durationSeconds: probedSourceMedia.durationSeconds,
          mode: "SAMPLE",
          signal,
        }),
      ]);
      const sourceMedia = {
        ...probedSourceMedia,
        ...audioLevels,
        corruptionDetected: false,
        decodeValidation: sourceDecodeValidation,
      };
      await this.store.beginTranscode(videoId, sourceMedia);
      let encoder = selectVideoEncoder(paths.encoderMode, this.hardwareEncoders);
      const transcode = () => this.transcodeImpl({
        inputPath: paths.sourcePath,
        outputPath: paths.tempOutputPath,
        durationSeconds: sourceMedia.durationSeconds,
        ffmpegPath: this.ffmpegPath,
        videoBitrate: profile?.videoBitrate || this.videoBitrate,
        audioBitrate: profile?.audioBitrate || this.audioBitrate,
        preset: profile?.preset || this.preset,
        encoder,
        signal,
        onProgress: (progress) => void this.store.updateProcessingProgress(videoId, progress),
      });
      try {
        await transcode();
      } catch (error) {
        if (normalizeEncoderMode(paths.encoderMode) !== "AUTO" || encoder.id === "CPU" || signal.aborted) {
          throw error;
        }
        this.logger.warn?.(`Апаратний encoder ${encoder.label} не зміг обробити ${videoId}; повторюємо через CPU.`);
        await this.onEvent("VIDEO_ENCODER_FALLBACK", {
          videoId,
          failedEncoder: encoder.label,
          fallbackEncoder: "CPU · libx264",
        });
        encoder = selectVideoEncoder("CPU", []);
        await transcode();
      }
      await this.store.beginValidation(videoId, { encoder: encoder.label });
      const streamMedia = validateStreamMedia(
        await this.probeImpl(paths.tempOutputPath, {
          ffprobePath: this.ffprobePath,
          signal,
        }),
        { sourceDurationSeconds: sourceMedia.durationSeconds },
      );
      const validation = await this.decodeValidationImpl(paths.tempOutputPath, {
        ffmpegPath: this.ffmpegPath,
        durationSeconds: streamMedia.durationSeconds,
        mode: "FULL",
        signal,
      });
      const preparedChecksumSha256 = await this.hashFileImpl(paths.tempOutputPath);
      await this.thumbnailImpl({
        inputPath: paths.tempOutputPath,
        outputPath: paths.tempThumbnailPath,
        durationSeconds: streamMedia.durationSeconds,
        ffmpegPath: this.ffmpegPath,
        signal,
      });
      await this.store.completeProcessing(videoId, streamMedia, {
        keepOriginal: this.keepOriginalUploads || !paths.deleteOriginal,
        encoder: encoder.label,
        validation,
        preparedChecksumSha256,
        processingResult: {
          durationSeconds: Number(((Date.now() - processingStartedAt) / 1_000).toFixed(3)),
          encoder: encoder.label,
          profile: paths.compressionProfile,
          sourceSize: sourceMedia.sizeBytes,
          preparedSize: streamMedia.sizeBytes,
          warnings: [],
        },
      });
      await this.onEvent("VIDEO_READY", { videoId, encoder: encoder.label });
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

  async processThumbnail(videoId, signal, requestedPositionSeconds = null) {
    try {
      const paths = this.store.getThumbnailBackfillPaths(videoId);
      const positionSeconds = normalizeThumbnailPosition(
        requestedPositionSeconds,
        paths.durationSeconds,
      );
      await this.store.beginThumbnailGeneration(videoId, positionSeconds);
      await this.onEvent("VIDEO_THUMBNAIL_STARTED", { videoId, positionSeconds });
      await this.thumbnailImpl({
        inputPath: paths.inputPath,
        outputPath: paths.tempThumbnailPath,
        durationSeconds: paths.durationSeconds,
        positionSeconds,
        ffmpegPath: this.ffmpegPath,
        signal,
      });
      await this.store.completeThumbnail(videoId, positionSeconds);
      await this.onEvent("VIDEO_THUMBNAIL_READY", { videoId, positionSeconds });
    } catch (error) {
      if (this.shuttingDown && (signal.aborted || error?.name === "AbortError")) return;
      this.logger.error(`Помилка створення прев’ю відео ${videoId}:`, error);
      const message = error instanceof Error ? error.message : "Не вдалося створити прев’ю.";
      await this.store.failThumbnail?.(videoId, message);
      await this.onEvent("VIDEO_THUMBNAIL_FAILED", { videoId, message });
    }
  }

  async processCustomThumbnail(videoId, buffer, signal) {
    try {
      const paths = await this.store.beginCustomThumbnail(videoId, buffer);
      await this.onEvent("VIDEO_THUMBNAIL_STARTED", { videoId, source: "UPLOAD" });
      await this.customThumbnailImpl({
        inputPath: paths.inputPath,
        outputPath: paths.outputPath,
        mode: "thumbnail",
        ffmpegPath: this.ffmpegPath,
        signal,
      });
      const video = await this.store.completeCustomThumbnail(videoId);
      await this.onEvent("VIDEO_THUMBNAIL_READY", { videoId, source: "UPLOAD" });
      return video;
    } catch (error) {
      if (this.shuttingDown && (signal.aborted || error?.name === "AbortError")) throw error;
      this.logger.error(`Помилка завантаженого прев’ю відео ${videoId}:`, error);
      const message = "Не вдалося конвертувати PNG-прев’ю у WebP.";
      await this.store.failCustomThumbnail?.(videoId, message);
      await this.onEvent("VIDEO_THUMBNAIL_FAILED", { videoId, source: "UPLOAD", message });
      throw new ApiError(422, "THUMBNAIL_CONVERSION_FAILED", message);
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
      encoders: {
        modes: ["AUTO", "CPU", "GPU"],
        cpu: { id: "CPU", codec: "libx264", label: "CPU · libx264" },
        hardware: this.hardwareEncoders.map((encoder) => ({ ...encoder })),
        detectionError: this.encoderDetectionError,
      },
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
