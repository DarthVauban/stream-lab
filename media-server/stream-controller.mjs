import { spawn, spawnSync } from "node:child_process";
import { ApiError } from "./api-error.mjs";

const ACTIVE_STATUSES = new Set(["STARTING", "LIVE", "DEGRADED", "RECONNECTING", "STOPPING"]);
const MIN_VIDEO_BITRATE_KBPS = 3_000;
const MAX_VIDEO_BITRATE_KBPS = 12_000;

export function normalizeVideoBitrateKbps(value, fallback = 8_000) {
  const bitrate = Number(value);
  if (!Number.isInteger(bitrate)) return fallback;
  if (bitrate < MIN_VIDEO_BITRATE_KBPS || bitrate > MAX_VIDEO_BITRATE_KBPS) {
    throw new ApiError(
      400,
      "INVALID_VIDEO_BITRATE",
      "Відеобітрейт має бути від 3000 до 12000 Кбіт/с.",
    );
  }
  return bitrate;
}

export function buildUplinkFfmpegArgs({
  inputUrl,
  target,
  videoBitrateKbps = 8_000,
  audioBitrate = "128k",
  inputFormat = null,
  networkTimeoutMs = 15_000,
}) {
  normalizeVideoBitrateKbps(videoBitrateKbps);
  const timeoutMicroseconds = Math.max(1_000, Number(networkTimeoutMs) || 15_000) * 1_000;
  return [
    "-hide_banner",
    "-loglevel",
    "info",
    "-nostats",
    "-progress",
    "pipe:1",
    "-fflags",
    "+genpts+discardcorrupt",
    "-thread_queue_size",
    "8192",
    ...(inputFormat ? ["-f", inputFormat] : []),
    // Keep one real-time clock for the whole broadcast. Playout workers are
    // allowed to stay slightly ahead behind pipe backpressure, so this
    // long-lived process can bridge file boundaries and catch up after jitter.
    "-re",
    "-i",
    inputUrl,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    audioBitrate,
    "-ar",
    "44100",
    "-ac",
    "2",
    "-af",
    "aresample=async=1000:min_hard_comp=0.100:first_pts=0",
    "-max_muxing_queue_size",
    "4096",
    "-max_interleave_delta",
    "1000000",
    "-rw_timeout",
    String(Math.round(timeoutMicroseconds)),
    "-tcp_nodelay",
    "1",
    "-flvflags",
    "no_duration_filesize",
    "-flush_packets",
    "1",
    "-f",
    "flv",
    target,
  ];
}

function finiteNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export class FfmpegProgressParser {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.buffer = "";
    this.values = {};
  }

  push(chunk) {
    this.buffer += String(chunk);
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    const snapshots = [];
    for (const line of lines) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      this.values[key] = value;
      if (key === "progress") {
        snapshots.push(this.snapshot());
        this.values = {};
      }
    }
    return snapshots;
  }

  snapshot() {
    const bitrateKbps = this.values.bitrate === "N/A"
      ? null
      : finiteNumber(String(this.values.bitrate ?? "").replace(/kbits\/s$/i, ""));
    const outTimeMicroseconds = finiteInteger(
      this.values.out_time_us ?? this.values.out_time_ms,
    );
    return {
      capturedAt: new Date(this.now()).toISOString(),
      frame: finiteInteger(this.values.frame),
      fps: finiteNumber(this.values.fps),
      bitrateKbps,
      totalSizeBytes: finiteInteger(this.values.total_size),
      outTimeMs: outTimeMicroseconds === null ? null : Math.round(outTimeMicroseconds / 1_000),
      duplicateFrames: finiteInteger(this.values.dup_frames),
      droppedFrames: finiteInteger(this.values.drop_frames),
      speed: finiteNumber(String(this.values.speed ?? "").replace(/x$/i, "")),
    };
  }
}

export function buildPlayoutFfmpegArgs({
  inputPath,
  outputUrl,
  timestampOffsetSeconds = 0,
  startSeconds = 0,
  videoBitrateKbps = 8_000,
  overlays = [],
}) {
  const safeStart = Math.max(0, Number(startSeconds) || 0);
  const safeOverlays = (Array.isArray(overlays) ? overlays : [])
    .filter((overlay) => overlay?.filePath && overlay?.placement)
    .sort((left, right) => (left.placement.zIndex || 0) - (right.placement.zIndex || 0));
  const args = [
    "-hide_banner",
    "-loglevel",
    "info",
    ...(safeStart > 0 ? ["-ss", safeStart.toFixed(3)] : []),
    "-i",
    inputPath,
  ];

  for (const overlay of safeOverlays) args.push("-loop", "1", "-i", overlay.filePath);

  if (safeOverlays.length) {
    const overlayBitrate = normalizeVideoBitrateKbps(videoBitrateKbps);
    const filters = [];
    let previous = "0:v";
    safeOverlays.forEach((overlay, index) => {
      const placement = overlay.placement;
      const layer = `promo${index}`;
      const output = `promoout${index}`;
      const opacity = Math.min(1, Math.max(0.05, Number(placement.opacity) || 1));
      filters.push(
        `[${index + 1}:v]scale=${Math.round(placement.width)}:${Math.round(placement.height)},format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}[${layer}]`,
      );
      filters.push(
        `[${previous}][${layer}]overlay=${Math.round(placement.x)}:${Math.round(placement.y)}:shortest=1:eof_action=pass[${output}]`,
      );
      previous = output;
    });
    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      `[${previous}]`,
      "-map",
      "0:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "high",
      "-level:v",
      "4.1",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-fps_mode",
      "cfr",
      "-b:v",
      `${overlayBitrate}k`,
      "-minrate",
      `${overlayBitrate}k`,
      "-maxrate",
      `${overlayBitrate}k`,
      "-bufsize",
      `${overlayBitrate * 2}k`,
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-bf",
      "0",
      "-x264-params",
      "nal-hrd=cbr:force-cfr=1:open-gop=0",
      "-c:a",
      "copy",
      "-shortest",
    );
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0", "-c", "copy");
  }

  args.push(
    "-output_ts_offset",
    Math.max(0, timestampOffsetSeconds + safeStart).toFixed(3),
    "-mpegts_flags",
    "+resend_headers+initial_discontinuity",
    "-pat_period",
    "0.1",
    "-sdt_period",
    "0.5",
    "-muxdelay",
    "0",
    "-muxpreload",
    "0",
    "-flush_packets",
    "1",
    "-f",
    "mpegts",
    outputUrl,
  );
  return args;
}

// Backwards-compatible export for integrations that still import the old helper.
export function buildFfmpegArgs(options) {
  return buildUplinkFfmpegArgs({
    inputUrl: options.inputUrl ?? options.playlistPath ?? options.inputPath,
    target: options.target,
    videoBitrateKbps: options.videoBitrateKbps ?? Number.parseInt(options.videoBitrate, 10) * 1_000,
    audioBitrate: options.audioBitrate,
  });
}

function redact(text, secrets) {
  return secrets.reduce(
    (result, secret) => (secret ? result.split(secret).join("[REDACTED]") : result),
    text,
  );
}

function durationMs(item) {
  const seconds = Number(item?.media?.durationSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1_000) : 0;
}

function sourceBitrateKbps(item) {
  const bitsPerSecond = Number(item?.media?.bitrate);
  return Number.isFinite(bitsPerSecond) && bitsPerSecond > 0
    ? Math.max(1, Math.round(bitsPerSecond / 1_000))
    : null;
}

function playoutVideoBitrateKbps(item, fallback) {
  return Math.min(
    MAX_VIDEO_BITRATE_KBPS,
    Math.max(MIN_VIDEO_BITRATE_KBPS, sourceBitrateKbps(item) ?? fallback),
  );
}

export class StreamController {
  constructor({
    ffmpegPath = "ffmpeg",
    videoBitrateKbps = 8_000,
    audioBitrate = "128k",
    networkTimeoutMs = Number(process.env.STREAM_NETWORK_TIMEOUT_MS || 15_000),
    spawnImpl = spawn,
    spawnSyncImpl = spawnSync,
    stateStore = null,
    reconnectBaseMs = Number(process.env.STREAM_RECONNECT_BASE_MS || 2_000),
    reconnectMaxMs = Number(process.env.STREAM_RECONNECT_MAX_MS || 300_000),
    stableRunMs = Number(process.env.STREAM_STABLE_RUN_MS || 60_000),
    prewarmLeadMs = Number(process.env.PLAYOUT_PREWARM_LEAD_MS || 1_500),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    now = () => Date.now(),
  } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.defaultVideoBitrateKbps = normalizeVideoBitrateKbps(videoBitrateKbps);
    this.audioBitrate = audioBitrate;
    this.networkTimeoutMs = Math.max(1_000, Number(networkTimeoutMs) || 15_000);
    // Node relays MPEG-TS through OS pipes. Unlike local UDP, pipe backpressure
    // cannot silently discard packets when the encoder or host is briefly busy.
    this.playoutInputUrl = "pipe:0";
    this.playoutOutputUrl = "pipe:1";
    this.spawnImpl = spawnImpl;
    this.spawnSyncImpl = spawnSyncImpl;
    this.stateStore = stateStore;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.stableRunMs = stableRunMs;
    this.prewarmLeadMs = Math.max(250, Number(prewarmLeadMs) || 1_500);
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.now = now;
    this.uplinkChild = null;
    this.playoutChild = null;
    this.uplinkRunId = 0;
    this.playoutRunId = 0;
    this.desired = null;
    this.currentItem = null;
    this.currentStartedAtMs = null;
    this.playoutClockSeconds = 0;
    this.skipRequested = false;
    this.skipCompletion = null;
    this.getQueue = () => [];
    this.getFallback = () => null;
    this.getOverlays = () => [];
    this.resolveVideo = null;
    this.reconnectTimer = null;
    this.playoutRetryTimer = null;
    this.prewarmTimer = null;
    this.prewarmedPlayout = null;
    this.failureStreak = 0;
    this.uplinkAttemptStartedAt = null;
    this.shuttingDown = false;
    this.secrets = [];
    this.logs = [];
    this.history = [];
    this.ffmpegHealth = null;
    this.ffmpegHealthCheckedAt = 0;
    this.outputMetrics = null;
    this.deliveryClock = null;
    this.playoutPausedForBackpressure = null;
    this.state = {
      status: "STOPPED",
      startedAt: null,
      stoppedAt: null,
      lastError: null,
      lastFailure: null,
      reconnectAttempt: 0,
      nextRetryAt: null,
      autoResumeEnabled: false,
      restoredAfterRestart: false,
    };
  }

  async init({ resolveVideo, getQueue, getFallback, getOverlays } = {}) {
    this.resolveVideo = resolveVideo ?? this.resolveVideo;
    this.getQueue = getQueue ?? this.getQueue;
    this.getFallback = getFallback ?? this.getFallback;
    this.getOverlays = getOverlays ?? this.getOverlays;
    if (!this.stateStore) return this.snapshot();

    let persisted;
    try {
      persisted = await this.stateStore.load();
    } catch (error) {
      this.state.status = "ERROR";
      this.state.lastError = error.message;
      this.state.lastFailure = error.message;
      return this.snapshot();
    }
    if (!persisted) return this.snapshot();

    try {
      const queue = this.safeQueue();
      const persistedQueueItemId = persisted.queueItemIds?.[0] ?? null;
      let current = persistedQueueItemId
        ? queue.find((item) => item.queueItemId === persistedQueueItemId) ?? null
        : null;
      const fallback = this.fallbackItem();
      if (!current && fallback?.id === persisted.videoId) current = fallback;
      if (!current) current = queue.find((item) => item.id === persisted.videoId) ?? null;
      if (!current && this.resolveVideo) {
        current = { ...this.resolveVideo(persisted.videoId), queueItemId: persistedQueueItemId };
      }
      if (!current) throw new Error("Збережене відео не знайдено.");

      this.currentItem = current;
      this.desired = {
        target: persisted.target,
        streamKey: persisted.streamKey,
        startedAt: persisted.startedAt,
        videoBitrateKbps: normalizeVideoBitrateKbps(
          persisted.videoBitrateKbps,
          this.defaultVideoBitrateKbps,
        ),
      };
      this.secrets = [persisted.target, persisted.streamKey];
      this.state = {
        status: "RECONNECTING",
        startedAt: persisted.startedAt,
        stoppedAt: null,
        lastError: "Відновлюємо трансляцію після перезапуску сервісу.",
        lastFailure: null,
        reconnectAttempt: 0,
        nextRetryAt: null,
        autoResumeEnabled: true,
        restoredAfterRestart: true,
      };
      await this.launchUplink({ initial: false });
      await this.launchPlayout(current, { initial: false });
    } catch (error) {
      this.desired = null;
      this.currentItem = null;
      this.state.status = "ERROR";
      this.state.lastError = error instanceof Error ? error.message : "Не вдалося відновити ефір.";
      this.state.lastFailure = this.state.lastError;
      await this.stateStore.clear().catch(() => {});
    }
    return this.snapshot();
  }

  checkFfmpeg(force = false) {
    if (!force && this.ffmpegHealth && this.now() - this.ffmpegHealthCheckedAt < 30_000) {
      return this.ffmpegHealth;
    }
    const result = this.spawnSyncImpl(this.ffmpegPath, ["-version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.error) {
      this.ffmpegHealth = { available: false, version: null, message: "FFmpeg не знайдено." };
      this.ffmpegHealthCheckedAt = this.now();
      return this.ffmpegHealth;
    }
    const version = String(result.stdout ?? "").split(/\r?\n/, 1)[0] || "FFmpeg";
    this.ffmpegHealth = { available: result.status === 0, version, message: null };
    this.ffmpegHealthCheckedAt = this.now();
    return this.ffmpegHealth;
  }

  safeQueue() {
    const queue = this.getQueue?.();
    return Array.isArray(queue) ? queue.filter((item) => item?.id && item?.filePath) : [];
  }

  fallbackItem() {
    try {
      const fallback = this.getFallback?.();
      return fallback?.id && fallback?.filePath
        ? { ...fallback, queueItemId: fallback.queueItemId ?? `fallback:${fallback.id}`, isFallback: true }
        : null;
    } catch {
      return null;
    }
  }

  nextItem({ after = this.currentItem, failed = false } = {}) {
    const queue = this.safeQueue();
    if (queue.length === 0) return this.fallbackItem();
    if (failed) {
      const fallback = this.fallbackItem();
      if (fallback && fallback.id !== after?.id) return fallback;
    }
    if (!after || after.isFallback) return queue[0];
    const currentIndex = queue.findIndex((item) => item.queueItemId === after.queueItemId);
    if (currentIndex === -1) return queue[0];
    if (queue.length === 1) {
      return queue[0];
    }
    return queue[(currentIndex + 1) % queue.length];
  }

  snapshot() {
    const currentDurationMs = durationMs(this.currentItem);
    const positionMs = this.currentStartedAtMs === null
      ? 0
      : Math.max(0, Math.min(currentDurationMs || Number.MAX_SAFE_INTEGER, this.now() - this.currentStartedAtMs));
    const next = this.nextItem();
    const queue = this.safeQueue();
    const configuredVideoBitrateKbps = this.desired?.videoBitrateKbps ?? this.defaultVideoBitrateKbps;
    const currentSourceBitrateKbps = sourceBitrateKbps(this.currentItem);
    return {
      ...this.state,
      videoId: this.currentItem?.id ?? null,
      videoName: this.currentItem?.name ?? null,
      queueItemId: this.currentItem?.queueItemId ?? null,
      playlistLength: queue.length,
      positionMs,
      durationMs: currentDurationMs,
      remainingMs: currentDurationMs ? Math.max(0, currentDurationMs - positionMs) : null,
      nextQueueItemId: next?.queueItemId ?? null,
      nextVideoName: next?.name ?? null,
      isFallback: Boolean(this.currentItem?.isFallback),
      // The prepared asset is remuxed instead of encoded live. Report its
      // measured bitrate as the active expectation so monitoring compares
      // like-for-like rather than flagging the saved encoder preference.
      videoBitrateKbps: currentSourceBitrateKbps ?? configuredVideoBitrateKbps,
      configuredVideoBitrateKbps,
      sourceBitrateKbps: currentSourceBitrateKbps,
      transportMode: "REMUX",
      pid: this.uplinkChild?.pid ?? null,
      uplinkPid: this.uplinkChild?.pid ?? null,
      playoutPid: this.playoutChild?.pid ?? null,
      history: this.history.map((item) => ({ ...item })),
      logs: [...this.logs],
      outputMetrics: this.outputMetrics ? { ...this.outputMetrics } : null,
    };
  }

  isActive() {
    return ACTIVE_STATUSES.has(this.state.status);
  }

  usesVideo(videoId) {
    return this.currentItem?.id === videoId;
  }

  isCurrentQueueItem(itemId) {
    return this.currentItem?.queueItemId === itemId;
  }

  async persistCurrent() {
    if (!this.desired || !this.currentItem) return;
    await this.stateStore?.saveActive({
      videoId: this.currentItem.id,
      videoIds: [this.currentItem.id],
      ...(this.currentItem.queueItemId ? { queueItemIds: [this.currentItem.queueItemId] } : {}),
      target: this.desired.target,
      streamKey: this.desired.streamKey,
      startedAt: this.desired.startedAt,
      videoBitrateKbps: this.desired.videoBitrateKbps,
    });
  }

  async start({ target, streamKey, videoBitrateKbps = this.defaultVideoBitrateKbps }) {
    if (this.uplinkChild || this.playoutChild || this.desired || this.reconnectTimer) {
      throw new ApiError(409, "STREAM_ALREADY_RUNNING", "Трансляція вже запущена.");
    }
    const ffmpeg = this.checkFfmpeg(true);
    if (!ffmpeg.available) throw new ApiError(503, "FFMPEG_UNAVAILABLE", ffmpeg.message);

    const first = this.safeQueue()[0] ?? this.fallbackItem();
    if (!first) {
      throw new ApiError(409, "QUEUE_EMPTY", "Додайте відео до черги або налаштуйте резервне відео.");
    }
    const startedAt = new Date(this.now()).toISOString();
    this.currentItem = first;
    this.desired = {
      target,
      streamKey,
      startedAt,
      videoBitrateKbps: normalizeVideoBitrateKbps(videoBitrateKbps, this.defaultVideoBitrateKbps),
    };
    this.failureStreak = 0;
    this.playoutClockSeconds = 0;
    this.secrets = [target, streamKey];
    this.logs = [];
    this.history = [];
    this.outputMetrics = null;
    this.deliveryClock = null;
    this.state = {
      status: "STARTING",
      startedAt,
      stoppedAt: null,
      lastError: null,
      lastFailure: null,
      reconnectAttempt: 0,
      nextRetryAt: null,
      autoResumeEnabled: true,
      restoredAfterRestart: false,
    };

    try {
      await this.persistCurrent();
      await this.launchUplink({ initial: true });
      await this.launchPlayout(first, { initial: true });
    } catch (error) {
      this.desired = null;
      this.currentItem = null;
      this.secrets = [];
      await this.stateStore?.clear().catch(() => {});
      await this.stopChild(this.playoutChild);
      await this.stopChild(this.uplinkChild);
      this.state.status = "ERROR";
      this.state.autoResumeEnabled = false;
      this.state.lastError = "Не вдалося запустити Playout Engine або RTMPS uplink.";
      this.state.lastFailure = this.state.lastError;
      throw new ApiError(503, "STREAM_START_FAILED", this.state.lastError, { cause: error });
    }
    return this.snapshot();
  }

  pushLogs(chunk, role) {
    const lines = redact(String(chunk), this.secrets)
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `[${role}] ${line}`);
    this.logs.push(...lines);
    this.logs = this.logs.slice(-40);
    return lines;
  }

  resumePlayoutAfterBackpressure() {
    const source = this.playoutPausedForBackpressure;
    this.playoutPausedForBackpressure = null;
    source?.stdout?.resume?.();
  }

  pausePlayoutForBackpressure(source = this.playoutChild) {
    if (!source || source !== this.playoutChild) return;
    this.playoutPausedForBackpressure = source;
    source.stdout?.pause?.();
  }

  relayPlayoutChunk(chunk, source, runId) {
    if (runId !== this.playoutRunId || source !== this.playoutChild) return;
    const destination = this.uplinkChild?.stdin;
    if (!destination || destination.destroyed || destination.writableEnded) {
      this.pausePlayoutForBackpressure(source);
      return;
    }
    if (destination.write(chunk) || this.playoutPausedForBackpressure === source) return;

    this.playoutPausedForBackpressure = source;
    source.stdout?.pause?.();
    destination.once("drain", () => {
      if (this.playoutPausedForBackpressure !== source) return;
      if (this.uplinkChild?.stdin !== destination) return;
      this.playoutPausedForBackpressure = null;
      if (runId === this.playoutRunId && source === this.playoutChild) source.stdout?.resume?.();
    });
  }

  async launchUplink({ initial }) {
    if (!this.desired || this.shuttingDown || this.uplinkChild) return this.snapshot();
    const ffmpeg = this.checkFfmpeg(true);
    if (!ffmpeg.available) {
      if (initial) throw new Error(ffmpeg.message);
      this.scheduleReconnect(ffmpeg.message);
      return this.snapshot();
    }

    this.uplinkRunId += 1;
    const runId = this.uplinkRunId;
    const progressParser = new FfmpegProgressParser({ now: this.now });
    this.outputMetrics = null;
    this.deliveryClock = null;
    this.state.status = initial ? "STARTING" : "RECONNECTING";
    this.state.nextRetryAt = null;
    const args = buildUplinkFfmpegArgs({
      inputUrl: this.playoutInputUrl,
      inputFormat: "mpegts",
      target: this.desired.target,
      videoBitrateKbps: this.desired.videoBitrateKbps,
      audioBitrate: this.audioBitrate,
      networkTimeoutMs: this.networkTimeoutMs,
    });
    let child;
    try {
      child = this.spawnImpl(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      if (initial) throw error;
      this.scheduleReconnect("Не вдалося запустити RTMPS uplink.");
      return this.snapshot();
    }
    this.uplinkChild = child;
    child.stdin?.on("error", () => {
      this.pausePlayoutForBackpressure();
    });
    this.uplinkAttemptStartedAt = this.now();
    let spawned = false;
    let terminalHandled = false;

    child.stderr?.on("data", (chunk) => {
      if (runId !== this.uplinkRunId) return;
      const lines = this.pushLogs(chunk, "uplink");
      if (lines.some((line) => line.includes("frame="))) {
        this.state.status = "LIVE";
        this.state.lastError = null;
        this.state.nextRetryAt = null;
      }
    });

    child.stdout?.on("data", (chunk) => {
      if (runId !== this.uplinkRunId) return;
      for (const metrics of progressParser.push(chunk)) {
        const capturedAtMs = Date.parse(metrics.capturedAt);
        const outTimeMs = metrics.outTimeMs;
        if (!this.deliveryClock || (
          outTimeMs !== null &&
          outTimeMs < this.deliveryClock.lastOutTimeMs - 1_000
        )) {
          const timelineResets = (this.deliveryClock?.timelineResets || 0) + (this.deliveryClock ? 1 : 0);
          this.deliveryClock = {
            baseWallTimeMs: capturedAtMs,
            baseOutTimeMs: outTimeMs ?? 0,
            lastOutTimeMs: outTimeMs ?? 0,
            timelineResets,
          };
        }
        if (outTimeMs !== null) this.deliveryClock.lastOutTimeMs = outTimeMs;
        const wallElapsedMs = Math.max(0, capturedAtMs - this.deliveryClock.baseWallTimeMs);
        const outputElapsedMs = outTimeMs === null
          ? 0
          : Math.max(0, outTimeMs - this.deliveryClock.baseOutTimeMs);
        this.outputMetrics = {
          ...metrics,
          deliveryLagMs: Math.max(0, wallElapsedMs - outputElapsedMs),
          deliveryRate: wallElapsedMs >= 1_000 ? outputElapsedMs / wallElapsedMs : null,
          timelineResets: this.deliveryClock.timelineResets,
        };
        this.state.status = "LIVE";
        this.state.lastError = null;
        this.state.nextRetryAt = null;
      }
    });

    const handleTerminal = (reason) => {
      if (terminalHandled || runId !== this.uplinkRunId) return;
      terminalHandled = true;
      const ranFor = this.uplinkAttemptStartedAt === null ? 0 : this.now() - this.uplinkAttemptStartedAt;
      this.uplinkChild = null;
      this.uplinkAttemptStartedAt = null;
      this.pausePlayoutForBackpressure();
      if (!this.desired || this.shuttingDown || this.state.status === "STOPPING") return;
      if (ranFor >= this.stableRunMs) this.failureStreak = 0;
      this.scheduleReconnect(reason);
    };

    child.once("exit", (code, signal) => {
      handleTerminal(`RTMPS uplink завершився (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
    });

    return await new Promise((resolve, reject) => {
      child.once("spawn", () => {
        spawned = true;
        this.resumePlayoutAfterBackpressure();
        resolve(this.snapshot());
      });
      child.once("error", (error) => {
        if (!spawned && initial) {
          terminalHandled = true;
          this.uplinkChild = null;
          this.uplinkAttemptStartedAt = null;
          reject(error);
          return;
        }
        handleTerminal("RTMPS uplink завершився через системну помилку.");
        if (!spawned) resolve(this.snapshot());
      });
    });
  }

  samePlayoutItem(left, right) {
    if (!left || !right) return false;
    if (left.queueItemId && right.queueItemId) return left.queueItemId === right.queueItemId;
    return left.id === right.id && Boolean(left.isFallback) === Boolean(right.isFallback);
  }

  discardPrewarmedPlayout() {
    if (this.prewarmTimer) this.clearTimeoutImpl(this.prewarmTimer);
    this.prewarmTimer = null;
    const candidate = this.prewarmedPlayout;
    this.prewarmedPlayout = null;
    candidate?.child?.kill?.("SIGTERM");
  }

  schedulePlayoutPrewarm() {
    if (this.prewarmTimer) this.clearTimeoutImpl(this.prewarmTimer);
    this.prewarmTimer = null;
    if (!this.desired || !this.playoutChild || !this.currentItem || this.prewarmedPlayout) return;
    const currentDurationMs = durationMs(this.currentItem);
    if (!currentDurationMs || !this.nextItem()) return;
    const elapsedMs = Math.max(0, this.now() - (this.currentStartedAtMs ?? this.now()));
    const delayMs = Math.max(0, currentDurationMs - elapsedMs - this.prewarmLeadMs);
    this.prewarmTimer = this.setTimeoutImpl(() => {
      this.prewarmTimer = null;
      this.prewarmNextPlayout();
    }, delayMs);
    this.prewarmTimer?.unref?.();
  }

  prewarmNextPlayout() {
    if (!this.desired || this.shuttingDown || !this.playoutChild || this.prewarmedPlayout) return;
    const next = this.nextItem();
    if (!next) return;
    const args = buildPlayoutFfmpegArgs({
      inputPath: next.filePath,
      outputUrl: this.playoutOutputUrl,
      timestampOffsetSeconds: this.playoutClockSeconds + durationMs(this.currentItem) / 1_000,
      videoBitrateKbps: playoutVideoBitrateKbps(next, this.desired.videoBitrateKbps),
      overlays: this.getOverlays?.() || [],
    });
    let child;
    try {
      child = this.spawnImpl(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.pushLogs(`Next playout prewarm failed: ${String(error?.message || error)}`, "controller");
      return;
    }
    const candidate = {
      child,
      item: next,
      bufferedChunks: [],
      bufferedBytes: 0,
      spawned: false,
    };
    this.prewarmedPlayout = candidate;
    child.stdout?.on("data", (chunk) => {
      if (this.prewarmedPlayout !== candidate) return;
      // Keep the first muxed packets in memory and stop the producer before
      // it can advance past the active item. One Node stream read is usually
      // enough, but accept any already queued reads up to a small hard limit.
      if (candidate.bufferedBytes < 2 * 1024 * 1024) {
        candidate.bufferedChunks.push(chunk);
        candidate.bufferedBytes += chunk.length;
      }
      child.stdout.pause?.();
    });
    child.stderr?.on("data", (chunk) => {
      if (this.prewarmedPlayout === candidate) this.pushLogs(chunk, "prewarm");
    });
    child.once("spawn", () => {
      candidate.spawned = true;
    });
    const abandon = (reason) => {
      if (this.prewarmedPlayout !== candidate) return;
      this.prewarmedPlayout = null;
      this.pushLogs(reason, "controller");
    };
    child.once("exit", (code, signal) => {
      abandon(`Prewarmed playout exited early (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
    });
    child.once("error", () => {
      abandon("Prewarmed playout failed before promotion.");
    });
  }

  async activatePlayoutChild(child, item, {
    initial = false,
    resumeSeconds = 0,
    alreadySpawned = false,
  } = {}) {
    this.playoutRunId += 1;
    const runId = this.playoutRunId;
    this.currentItem = item;
    this.currentStartedAtMs = this.now() - Math.max(0, Number(resumeSeconds) || 0) * 1_000;
    this.skipRequested = false;
    this.playoutChild = child;
    child.stdout?.on("data", (chunk) => {
      this.relayPlayoutChunk(chunk, child, runId);
    });
    let spawned = alreadySpawned;
    let terminalHandled = false;

    child.stderr?.on("data", (chunk) => {
      if (runId === this.playoutRunId) this.pushLogs(chunk, "playout");
    });

    const handleTerminal = (code, signal, reason) => {
      if (terminalHandled || runId !== this.playoutRunId) return;
      terminalHandled = true;
      this.playoutChild = null;
      if (this.playoutPausedForBackpressure === child) this.resumePlayoutAfterBackpressure();
      if (!this.desired || this.shuttingDown || this.state.status === "STOPPING") {
        this.skipCompletion?.();
        this.skipCompletion = null;
        return;
      }
      const outcome = this.skipRequested ? "SKIPPED" : code === 0 ? "COMPLETED" : "FAILED";
      void this.advancePlayout(outcome, reason ?? `Playout завершився (code=${code}, signal=${signal}).`)
        .finally(() => {
          this.skipCompletion?.();
          this.skipCompletion = null;
        });
    };

    child.once("exit", (code, signal) => handleTerminal(code, signal));

    return await new Promise((resolve, reject) => {
      if (alreadySpawned) {
        child.once("error", () => {
          handleTerminal(null, null, "Playout Engine завершився через системну помилку.");
        });
        this.schedulePlayoutPrewarm();
        resolve(this.snapshot());
        return;
      }
      child.once("spawn", () => {
        spawned = true;
        this.schedulePlayoutPrewarm();
        resolve(this.snapshot());
      });
      child.once("error", (error) => {
        if (!spawned && initial) {
          terminalHandled = true;
          this.playoutChild = null;
          reject(error);
          return;
        }
        handleTerminal(null, null, "Playout Engine завершився через системну помилку.");
        if (!spawned) resolve(this.snapshot());
      });
    });
  }

  async promotePrewarmedPlayout(item) {
    const candidate = this.prewarmedPlayout;
    if (!candidate?.spawned || !this.samePlayoutItem(candidate.item, item)) return false;
    this.prewarmedPlayout = null;
    await this.activatePlayoutChild(candidate.child, item, { alreadySpawned: true });
    if (candidate.bufferedChunks.length) {
      this.relayPlayoutChunk(Buffer.concat(candidate.bufferedChunks), candidate.child, this.playoutRunId);
    }
    if (this.playoutPausedForBackpressure !== candidate.child) candidate.child.stdout?.resume?.();
    return true;
  }

  async launchPlayout(item, { initial = false, resumeSeconds = 0 } = {}) {
    if (!this.desired || this.shuttingDown || !item) return this.snapshot();
    this.discardPrewarmedPlayout();
    const args = buildPlayoutFfmpegArgs({
      inputPath: item.filePath,
      outputUrl: this.playoutOutputUrl,
      timestampOffsetSeconds: this.playoutClockSeconds,
      startSeconds: resumeSeconds,
      videoBitrateKbps: playoutVideoBitrateKbps(item, this.desired.videoBitrateKbps),
      overlays: this.getOverlays?.() || [],
    });
    let child;
    try {
      child = this.spawnImpl(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (initial) throw error;
      await this.advancePlayout("FAILED", String(error?.message || error));
      return this.snapshot();
    }
    return this.activatePlayoutChild(child, item, { initial, resumeSeconds });
  }

  async advancePlayout(outcome, reason) {
    if (!this.desired || !this.currentItem) return;
    const endedAtMs = this.now();
    const elapsedMs = Math.max(0, endedAtMs - (this.currentStartedAtMs ?? endedAtMs));
    const itemDurationMs = durationMs(this.currentItem);
    const playedMs = outcome === "COMPLETED" && itemDurationMs ? itemDurationMs : elapsedMs;
    this.playoutClockSeconds += Math.max(playedMs / 1_000, 1 / 30);
    this.history.push({
      queueItemId: this.currentItem.queueItemId ?? null,
      videoId: this.currentItem.id,
      videoName: this.currentItem.name,
      status: outcome,
      startedAt: new Date(this.currentStartedAtMs ?? endedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
    });
    this.history = this.history.slice(-20);
    const next = this.nextItem({ failed: outcome === "FAILED" });
    this.currentStartedAtMs = null;

    if (!next) {
      this.discardPrewarmedPlayout();
      this.state.status = "DEGRADED";
      this.state.lastError = "Черга порожня, а резервне відео не налаштоване.";
      this.state.lastFailure = reason;
      return;
    }

    if (outcome === "FAILED") {
      this.state.status = "DEGRADED";
      this.state.lastError = reason;
      this.state.lastFailure = reason;
    }
    try {
      const promoted = outcome === "COMPLETED"
        ? await this.promotePrewarmedPlayout(next)
        : false;
      if (!promoted) {
        this.discardPrewarmedPlayout();
        await this.launchPlayout(next);
      }
    } catch (error) {
      this.state.status = "DEGRADED";
      this.state.lastError = error instanceof Error ? error.message : "Не вдалося відкрити наступне відео.";
      this.state.lastFailure = this.state.lastError;
      this.playoutRetryTimer = this.setTimeoutImpl(() => {
        this.playoutRetryTimer = null;
        void this.launchPlayout(this.nextItem({ failed: true }) ?? this.currentItem);
      }, 2_000);
      this.playoutRetryTimer?.unref?.();
      return;
    }
    try {
      await this.persistCurrent();
    } catch (error) {
      // Persistence must never create or extend an on-air gap. The active
      // playout continues and the next successful transition retries the save.
      const message = error instanceof Error ? error.message : "Не вдалося зберегти стан ефіру.";
      this.state.lastFailure = message;
      this.pushLogs(`Stream state persistence delayed: ${message}`, "controller");
    }
  }

  scheduleReconnect(reason) {
    if (!this.desired || this.shuttingDown) return;
    if (this.reconnectTimer) this.clearTimeoutImpl(this.reconnectTimer);
    this.failureStreak += 1;
    const exponent = Math.min(this.failureStreak - 1, 16);
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** exponent);
    this.state.status = "RECONNECTING";
    this.state.lastError = reason;
    this.state.lastFailure = reason;
    this.state.reconnectAttempt = this.failureStreak;
    this.state.nextRetryAt = new Date(this.now() + delay).toISOString();
    this.state.autoResumeEnabled = true;
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      void this.launchUplink({ initial: false }).catch((error) => {
        this.scheduleReconnect(error instanceof Error ? error.message : "Не вдалося відновити uplink.");
      });
    }, delay);
    this.reconnectTimer?.unref?.();
  }

  async skip() {
    if (!this.desired || !this.playoutChild) {
      throw new ApiError(409, "PLAYOUT_NOT_ACTIVE", "Немає активного відео для пропуску.");
    }
    if (this.skipRequested) return this.snapshot();
    this.discardPrewarmedPlayout();
    this.skipRequested = true;
    const completion = new Promise((resolve) => {
      this.skipCompletion = resolve;
    });
    this.playoutChild.kill("SIGTERM");
    await Promise.race([
      completion,
      new Promise((resolve) => this.setTimeoutImpl(resolve, 5_000)),
    ]);
    return this.snapshot();
  }

  async refreshPlayout() {
    if (!this.desired || !this.currentItem || !this.playoutChild) return this.snapshot();
    this.discardPrewarmedPlayout();
    const currentDuration = durationMs(this.currentItem) / 1_000;
    const positionSeconds = Math.min(
      Math.max(0, currentDuration - 0.1),
      Math.max(0, (this.now() - (this.currentStartedAtMs ?? this.now())) / 1_000),
    );
    const previousChild = this.playoutChild;
    this.playoutRunId += 1;
    this.playoutChild = null;
    await this.stopChild(previousChild);
    await this.launchPlayout(this.currentItem, { resumeSeconds: positionSeconds });
    return this.snapshot();
  }

  waitForExit(child, timeoutMs) {
    return new Promise((resolve) => {
      if (!child) return resolve(true);
      let settled = false;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        this.clearTimeoutImpl(timer);
        child.removeListener("exit", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timer = this.setTimeoutImpl(() => finish(false), timeoutMs);
      timer?.unref?.();
      child.once("exit", onExit);
    });
  }

  async stopChild(child) {
    if (!child) return;
    const exited = this.waitForExit(child, 5_000);
    child.kill("SIGTERM");
    if (!(await exited)) {
      const killed = this.waitForExit(child, 2_000);
      child.kill("SIGKILL");
      await killed;
    }
  }

  clearTimers() {
    if (this.reconnectTimer) this.clearTimeoutImpl(this.reconnectTimer);
    if (this.playoutRetryTimer) this.clearTimeoutImpl(this.playoutRetryTimer);
    this.reconnectTimer = null;
    this.playoutRetryTimer = null;
    this.discardPrewarmedPlayout();
  }

  async stop() {
    try {
      await this.stateStore?.clear();
    } catch {
      throw new ApiError(
        500,
        "STREAM_STATE_CLEAR_FAILED",
        "Не вдалося вимкнути автоматичне відновлення. Спробуйте ще раз.",
      );
    }
    this.state.status = "STOPPING";
    this.desired = null;
    this.secrets = [];
    this.failureStreak = 0;
    this.clearTimers();
    await this.stopChild(this.playoutChild);
    await this.stopChild(this.uplinkChild);
    this.playoutChild = null;
    this.uplinkChild = null;
    this.currentItem = null;
    this.currentStartedAtMs = null;
    this.outputMetrics = null;
    this.deliveryClock = null;
    this.resumePlayoutAfterBackpressure();
    this.state = {
      ...this.state,
      status: "STOPPED",
      stoppedAt: new Date(this.now()).toISOString(),
      lastError: null,
      reconnectAttempt: 0,
      nextRetryAt: null,
      autoResumeEnabled: false,
      restoredAfterRestart: false,
    };
    return this.snapshot();
  }

  async shutdown() {
    this.shuttingDown = true;
    this.clearTimers();
    this.state.status = "STOPPING";
    await this.stopChild(this.playoutChild);
    await this.stopChild(this.uplinkChild);
    this.playoutChild = null;
    this.uplinkChild = null;
    this.resumePlayoutAfterBackpressure();
    return this.snapshot();
  }
}
