import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { ApiError } from "./api-error.mjs";

export function buildFfmpegArgs({
  inputPath,
  target,
  videoBitrate = "10M",
  audioBitrate = "128k",
}) {
  return [
    "-hide_banner",
    "-loglevel",
    "info",
    "-re",
    "-stream_loop",
    "-1",
    "-i",
    inputPath,
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
    spawnImpl = spawn,
    spawnSyncImpl = spawnSync,
  } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.videoBitrate = videoBitrate;
    this.audioBitrate = audioBitrate;
    this.spawnImpl = spawnImpl;
    this.spawnSyncImpl = spawnSyncImpl;
    this.child = null;
    this.runId = 0;
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
    };
  }

  checkFfmpeg(force = false) {
    if (!force && this.ffmpegHealth && Date.now() - this.ffmpegHealthCheckedAt < 30_000) {
      return this.ffmpegHealth;
    }
    const result = this.spawnSyncImpl(this.ffmpegPath, ["-version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.error) {
      this.ffmpegHealth = { available: false, version: null, message: "FFmpeg не знайдено." };
      this.ffmpegHealthCheckedAt = Date.now();
      return this.ffmpegHealth;
    }
    const version = String(result.stdout ?? "").split(/\r?\n/, 1)[0] || "FFmpeg";
    this.ffmpegHealth = { available: result.status === 0, version, message: null };
    this.ffmpegHealthCheckedAt = Date.now();
    return this.ffmpegHealth;
  }

  snapshot() {
    return {
      ...this.state,
      pid: this.child?.pid ?? null,
      logs: [...this.logs],
    };
  }

  async start({ video, target, streamKey }) {
    if (this.child) {
      throw new ApiError(409, "STREAM_ALREADY_RUNNING", "Трансляція вже запущена.");
    }

    const ffmpeg = this.checkFfmpeg(true);
    if (!ffmpeg.available) {
      throw new ApiError(503, "FFMPEG_UNAVAILABLE", ffmpeg.message);
    }

    this.runId += 1;
    const currentRunId = this.runId;
    this.secrets = [target, streamKey];
    this.logs = [];
    this.state = {
      status: "STARTING",
      videoId: video.id,
      videoName: video.name,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      lastError: null,
    };

    const args = buildFfmpegArgs({
      inputPath: video.filePath,
      target,
      videoBitrate: this.videoBitrate,
      audioBitrate: this.audioBitrate,
    });
    const child = this.spawnImpl(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;

    child.stderr?.on("data", (chunk) => {
      if (currentRunId !== this.runId) return;
      const lines = redact(String(chunk), this.secrets)
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.some((line) => line.includes("frame="))) {
        this.state.status = "LIVE";
      }
      this.logs.push(...lines);
      this.logs = this.logs.slice(-24);
    });

    child.once("exit", (code, signal) => {
      if (currentRunId !== this.runId) return;
      const expectedStop = this.state.status === "STOPPING";
      this.child = null;
      this.secrets = [];
      this.state.status = expectedStop ? "STOPPED" : "ERROR";
      this.state.stoppedAt = new Date().toISOString();
      this.state.lastError = expectedStop
        ? null
        : `FFmpeg завершився (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
    });

    try {
      await Promise.race([
        once(child, "spawn"),
        once(child, "error").then(([error]) => Promise.reject(error)),
      ]);
    } catch (error) {
      this.child = null;
      this.secrets = [];
      this.state.status = "ERROR";
      this.state.lastError = "Не вдалося запустити FFmpeg.";
      throw new ApiError(503, "FFMPEG_START_FAILED", this.state.lastError, { cause: error });
    }

    return this.snapshot();
  }

  async stop() {
    const child = this.child;
    if (!child) {
      this.state.status = "STOPPED";
      return this.snapshot();
    }

    this.state.status = "STOPPING";
    child.kill("SIGTERM");
    const exited = once(child, "exit").then(() => true);
    const timedOut = new Promise((resolve) => setTimeout(() => resolve(false), 8000));
    if (!(await Promise.race([exited, timedOut])) && this.child === child) {
      child.kill("SIGKILL");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    return this.snapshot();
  }
}
