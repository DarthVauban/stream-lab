import { spawn, spawnSync } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
import { ApiError } from "./api-error.mjs";

export function buildFfmpegArgs({
  inputPath,
  playlistPath,
  target,
  videoBitrate = "10M",
  audioBitrate = "128k",
}) {
  const inputArgs = playlistPath
    ? ["-stream_loop", "-1", "-f", "concat", "-safe", "0", "-i", playlistPath]
    : ["-stream_loop", "-1", "-i", inputPath];
  return [
    "-hide_banner",
    "-loglevel",
    "info",
    "-re",
    ...inputArgs,
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-b:v",
    videoBitrate,
    "-minrate",
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
    "-af",
    "aresample=async=1:first_pts=0",
    "-f",
    "flv",
    target,
  ];
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}

export function buildConcatPlaylist(videos) {
  if (!Array.isArray(videos) || videos.length === 0) {
    throw new ApiError(409, "QUEUE_EMPTY", "Додайте хоча б одне готове відео до черги.");
  }
  return [
    "ffconcat version 1.0",
    ...videos.map((video) => `file '${escapeConcatPath(video.filePath)}'`),
    "",
  ].join("\n");
}

function redact(text, secrets) {
  return secrets.reduce(
    (result, secret) => (secret ? result.split(secret).join("[REDACTED]") : result),
    text,
  );
}

export class StreamController {
  constructor({
    ffmpegPath = "ffmpeg",
    videoBitrate = "10M",
    audioBitrate = "128k",
    playlistPath = null,
    spawnImpl = spawn,
    spawnSyncImpl = spawnSync,
    stateStore = null,
    reconnectBaseMs = Number(process.env.STREAM_RECONNECT_BASE_MS || 2000),
    reconnectMaxMs = Number(process.env.STREAM_RECONNECT_MAX_MS || 300_000),
    stableRunMs = Number(process.env.STREAM_STABLE_RUN_MS || 60_000),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    now = () => Date.now(),
  } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.videoBitrate = videoBitrate;
    this.audioBitrate = audioBitrate;
    this.playlistPath = playlistPath;
    this.spawnImpl = spawnImpl;
    this.spawnSyncImpl = spawnSyncImpl;
    this.stateStore = stateStore;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.stableRunMs = stableRunMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.now = now;
    this.child = null;
    this.runId = 0;
    this.desired = null;
    this.resolveVideo = null;
    this.reconnectTimer = null;
    this.failureStreak = 0;
    this.currentAttemptStartedAt = null;
    this.shuttingDown = false;
    this.secrets = [];
    this.logs = [];
    this.ffmpegHealth = null;
    this.ffmpegHealthCheckedAt = 0;
    this.state = {
      status: "STOPPED",
      videoId: null,
      videoName: null,
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

  async init({ resolveVideo }) {
    this.resolveVideo = resolveVideo;
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
      const videoIds = persisted.videoIds ?? [persisted.videoId];
      const videos = videoIds.map((videoId, index) => ({
        ...resolveVideo(videoId),
        queueItemId: persisted.queueItemIds?.[index] ?? null,
      }));
      const video = videos[0];
      await this.preparePlaylist(videos);
      this.desired = { ...persisted, video, videos };
      this.secrets = [persisted.target, persisted.streamKey];
      this.state = {
        status: "RECONNECTING",
        videoId: video.id,
        videoName: video.name,
        startedAt: persisted.startedAt,
        stoppedAt: null,
        lastError: "Відновлюємо трансляцію після перезапуску сервісу.",
        lastFailure: null,
        reconnectAttempt: 0,
        nextRetryAt: null,
        autoResumeEnabled: true,
        restoredAfterRestart: true,
      };
      await this.launch({ initial: false });
    } catch (error) {
      if (this.desired) {
        this.scheduleReconnect(error instanceof Error ? error.message : "Не вдалося відновити FFmpeg.");
      } else {
        this.state.status = "ERROR";
        this.state.lastError = "Збережене відео для автоматичного відновлення не знайдено.";
        this.state.lastFailure = this.state.lastError;
        await this.stateStore.clear().catch(() => {});
      }
    }
    return this.snapshot();
  }

  checkFfmpeg(force = false) {
    if (!force && this.ffmpegHealth && this.now() - this.ffmpegHealthCheckedAt < 30_000) {
      return this.ffmpegHealth;
    }
    const result = this.spawnSyncImpl(this.ffmpegPath, ["-version"], {
      encoding: "utf8",
      timeout: 5000,
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

  snapshot() {
    const currentVideo = this.currentPlaylistVideo();
    return {
      ...this.state,
      videoId: currentVideo?.id ?? this.state.videoId,
      videoName: currentVideo?.name ?? this.state.videoName,
      queueItemId: currentVideo?.queueItemId ?? null,
      playlistLength: this.desired?.videos?.length ?? 0,
      pid: this.child?.pid ?? null,
      logs: [...this.logs],
    };
  }

  currentPlaylistVideo() {
    const videos = this.desired?.videos;
    if (!videos?.length) return null;
    if (!this.currentAttemptStartedAt) return videos[0];
    const durations = videos.map((video) => Number(video.media?.durationSeconds));
    if (durations.some((duration) => !Number.isFinite(duration) || duration <= 0)) return videos[0];
    const cycleDuration = durations.reduce((sum, duration) => sum + duration, 0);
    let offset = Math.max(0, (this.now() - this.currentAttemptStartedAt) / 1000) % cycleDuration;
    for (let index = 0; index < videos.length; index += 1) {
      if (offset < durations[index]) return videos[index];
      offset -= durations[index];
    }
    return videos[0];
  }

  usesVideo(videoId) {
    return Boolean(this.desired?.videos?.some((video) => video.id === videoId));
  }

  async preparePlaylist(videos) {
    if (!this.playlistPath) {
      if (videos.length === 1) return null;
      throw new Error("Не налаштовано файл плейлиста FFmpeg.");
    }
    const tempPath = `${this.playlistPath}.tmp`;
    await writeFile(tempPath, buildConcatPlaylist(videos), "utf8");
    await rename(tempPath, this.playlistPath);
    return this.playlistPath;
  }

  async cleanupPlaylist() {
    if (!this.playlistPath) return;
    await rm(`${this.playlistPath}.tmp`, { force: true }).catch(() => {});
    await rm(this.playlistPath, { force: true }).catch(() => {});
  }

  async start({ video, videos, target, streamKey }) {
    if (this.child || this.desired || this.reconnectTimer) {
      throw new ApiError(409, "STREAM_ALREADY_RUNNING", "Трансляція вже запущена.");
    }

    const ffmpeg = this.checkFfmpeg(true);
    if (!ffmpeg.available) {
      throw new ApiError(503, "FFMPEG_UNAVAILABLE", ffmpeg.message);
    }

    const playlist = videos ?? (video ? [video] : []);
    buildConcatPlaylist(playlist);
    const firstVideo = playlist[0];
    const startedAt = new Date(this.now()).toISOString();
    const desired = {
      video: firstVideo,
      videos: playlist,
      videoId: firstVideo.id,
      target,
      streamKey,
      startedAt,
    };
    try {
      await this.preparePlaylist(playlist);
      const queueItemIds = playlist.map((item) => item.queueItemId).filter(Boolean);
      await this.stateStore?.saveActive({
        videoId: firstVideo.id,
        videoIds: playlist.map((item) => item.id),
        ...(queueItemIds.length === playlist.length ? { queueItemIds } : {}),
        target,
        streamKey,
        startedAt,
      });
    } catch {
      await this.cleanupPlaylist();
      throw new ApiError(
        500,
        "STREAM_STATE_PERSIST_FAILED",
        "Не вдалося підготувати плейлист або безпечно зберегти конфігурацію ефіру.",
      );
    }

    this.desired = desired;
    this.failureStreak = 0;
    this.secrets = [target, streamKey];
    this.logs = [];
    this.state = {
      status: "STARTING",
      videoId: firstVideo.id,
      videoName: firstVideo.name,
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
      await this.launch({ initial: true });
    } catch (error) {
      this.desired = null;
      this.secrets = [];
      await this.stateStore?.clear().catch(() => {});
      await this.cleanupPlaylist();
      this.state.status = "ERROR";
      this.state.autoResumeEnabled = false;
      this.state.lastError = "Не вдалося запустити FFmpeg.";
      this.state.lastFailure = this.state.lastError;
      throw new ApiError(503, "FFMPEG_START_FAILED", this.state.lastError, { cause: error });
    }

    return this.snapshot();
  }

  async launch({ initial }) {
    if (!this.desired || this.shuttingDown) return this.snapshot();
    const ffmpeg = this.checkFfmpeg(true);
    if (!ffmpeg.available) {
      if (initial) throw new Error(ffmpeg.message);
      this.scheduleReconnect(ffmpeg.message);
      return this.snapshot();
    }

    this.runId += 1;
    const currentRunId = this.runId;
    const { video, target } = this.desired;
    this.state.status = initial ? "STARTING" : "RECONNECTING";
    this.state.nextRetryAt = null;

    const args = buildFfmpegArgs({
      inputPath: video.filePath,
      playlistPath: this.playlistPath,
      target,
      videoBitrate: this.videoBitrate,
      audioBitrate: this.audioBitrate,
    });
    let child;
    try {
      child = this.spawnImpl(this.ffmpegPath, args, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      if (initial) throw error;
      this.scheduleReconnect("Не вдалося запустити процес FFmpeg.");
      return this.snapshot();
    }
    this.child = child;
    this.currentAttemptStartedAt = this.now();
    let spawned = false;
    let terminalHandled = false;

    child.stderr?.on("data", (chunk) => {
      if (currentRunId !== this.runId) return;
      const lines = redact(String(chunk), this.secrets)
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.some((line) => line.includes("frame="))) {
        this.state.status = "LIVE";
        this.state.lastError = null;
        this.state.nextRetryAt = null;
      }
      this.logs.push(...lines);
      this.logs = this.logs.slice(-24);
    });

    const handleTerminal = (reason) => {
      if (terminalHandled || currentRunId !== this.runId) return;
      terminalHandled = true;
      const ranFor = this.currentAttemptStartedAt === null ? 0 : this.now() - this.currentAttemptStartedAt;
      this.child = null;
      this.currentAttemptStartedAt = null;
      if (!this.desired || this.shuttingDown || this.state.status === "STOPPING") {
        this.state.status = "STOPPED";
        this.state.stoppedAt = new Date(this.now()).toISOString();
        this.state.lastError = null;
        this.state.nextRetryAt = null;
        return;
      }
      if (ranFor >= this.stableRunMs) this.failureStreak = 0;
      this.scheduleReconnect(reason);
    };

    child.once("exit", (code, signal) => {
      handleTerminal(`FFmpeg завершився (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
    });

    return await new Promise((resolve, reject) => {
      child.once("spawn", () => {
        spawned = true;
        resolve(this.snapshot());
      });
      child.once("error", (error) => {
        if (!spawned && initial) {
          terminalHandled = true;
          this.child = null;
          this.currentAttemptStartedAt = null;
          reject(error);
          return;
        }
        handleTerminal("Процес FFmpeg завершився через системну помилку.");
        if (!spawned) resolve(this.snapshot());
      });
    });
  }

  scheduleReconnect(reason) {
    if (!this.desired || this.shuttingDown) return;
    if (this.reconnectTimer) this.clearTimeoutImpl(this.reconnectTimer);
    this.failureStreak += 1;
    const exponent = Math.min(this.failureStreak - 1, 16);
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** exponent);
    const nextRetryAt = new Date(this.now() + delay).toISOString();
    this.state.status = "RECONNECTING";
    this.state.lastError = reason;
    this.state.lastFailure = reason;
    this.state.reconnectAttempt = this.failureStreak;
    this.state.nextRetryAt = nextRetryAt;
    this.state.autoResumeEnabled = true;

    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      void this.launch({ initial: false }).catch((error) => {
        this.scheduleReconnect(error instanceof Error ? error.message : "Не вдалося перезапустити FFmpeg.");
      });
    }, delay);
    this.reconnectTimer?.unref?.();
  }

  waitForExit(child, timeoutMs) {
    return new Promise((resolve) => {
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

    this.desired = null;
    this.secrets = [];
    this.failureStreak = 0;
    if (this.reconnectTimer) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.state.autoResumeEnabled = false;
    this.state.reconnectAttempt = 0;
    this.state.nextRetryAt = null;
    const child = this.child;
    if (!child) {
      this.state.status = "STOPPED";
      this.state.stoppedAt = new Date(this.now()).toISOString();
      this.state.lastError = null;
      await this.cleanupPlaylist();
      return this.snapshot();
    }

    this.state.status = "STOPPING";
    const exited = this.waitForExit(child, 8000);
    child.kill("SIGTERM");
    if (!(await exited) && this.child === child) {
      const killed = this.waitForExit(child, 2000);
      child.kill("SIGKILL");
      await killed;
    }
    await this.cleanupPlaylist();
    return this.snapshot();
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const child = this.child;
    if (!child) return this.snapshot();
    this.state.status = "STOPPING";
    const exited = this.waitForExit(child, 8000);
    child.kill("SIGTERM");
    if (!(await exited) && this.child === child) {
      const killed = this.waitForExit(child, 2000);
      child.kill("SIGKILL");
      await killed;
    }
    return this.snapshot();
  }
}
