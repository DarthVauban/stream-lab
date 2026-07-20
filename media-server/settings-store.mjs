import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeCompressionProfile } from "./compression-profiles.mjs";
import { normalizeVideoBitrateKbps } from "./stream-controller.mjs";

function parseEnvironmentBitrate(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (/^\d+(?:\.\d+)?m$/.test(text)) return Math.round(Number.parseFloat(text) * 1_000);
  if (/^\d+k$/.test(text)) return Number.parseInt(text, 10);
  const numeric = Number(text);
  return Number.isFinite(numeric) ? Math.round(numeric) : 8_000;
}

function normalizeEncoderMode(value, fallback = "AUTO") {
  const mode = typeof value === "string" ? value.trim().toUpperCase() : "";
  return ["AUTO", "CPU", "GPU"].includes(mode) ? mode : fallback;
}

export class SettingsStore {
  constructor({
    rootDir,
    defaultVideoBitrate = process.env.MVP_VIDEO_BITRATE || "8M",
    repository = null,
  } = {}) {
    if (!rootDir) throw new Error("Для налаштувань не вказано rootDir.");
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "settings.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.repository = repository;
    this.documentKey = "settings";
    this.state = {
      videoBitrateKbps: normalizeVideoBitrateKbps(parseEnvironmentBitrate(defaultVideoBitrate)),
      fallbackVideoId: null,
      compressionProfile: normalizeCompressionProfile(process.env.MEDIA_COMPRESSION_PROFILE),
      encoderMode: normalizeEncoderMode(process.env.MEDIA_ENCODER_MODE),
      updatedAt: null,
    };
    this.persistQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
    let parsed = await this.repository?.readDocument?.(this.documentKey);
    if (!parsed) {
      try {
        parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        parsed = null;
      }
    }
    if (parsed) {
      this.state = {
        videoBitrateKbps: normalizeVideoBitrateKbps(
          parsed?.videoBitrateKbps,
          this.state.videoBitrateKbps,
        ),
        fallbackVideoId:
          typeof parsed?.fallbackVideoId === "string" && parsed.fallbackVideoId
            ? parsed.fallbackVideoId
            : null,
        compressionProfile: normalizeCompressionProfile(
          parsed?.compressionProfile,
          this.state.compressionProfile,
        ),
        encoderMode: normalizeEncoderMode(parsed?.encoderMode, this.state.encoderMode),
        updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null,
      };
    }
    await this.persist();
    return this.snapshot();
  }

  snapshot() {
    return { ...this.state };
  }

  async persist() {
    const payload = JSON.stringify({ schemaVersion: 1, ...this.state }, null, 2);
    const operation = this.persistQueue.catch(() => {}).then(async () => {
      await writeFile(this.tempPath, payload, "utf8");
      await rename(this.tempPath, this.filePath);
      await this.repository?.writeDocument?.(this.documentKey, {
        schemaVersion: 2,
        ...this.state,
      });
    });
    this.persistQueue = operation;
    await operation;
  }

  async updateStream({
    videoBitrateKbps = this.state.videoBitrateKbps,
    fallbackVideoId = this.state.fallbackVideoId,
    compressionProfile = this.state.compressionProfile,
    encoderMode = this.state.encoderMode,
  }) {
    const bitrate = Number(videoBitrateKbps);
    if (!Number.isInteger(bitrate)) {
      normalizeVideoBitrateKbps(0);
    }
    if (fallbackVideoId !== null && (typeof fallbackVideoId !== "string" || !fallbackVideoId)) {
      throw new TypeError("Некоректне резервне відео.");
    }
    const normalizedBitrate = normalizeVideoBitrateKbps(bitrate);
    this.state.videoBitrateKbps = normalizedBitrate;
    this.state.fallbackVideoId = fallbackVideoId;
    this.state.compressionProfile = normalizeCompressionProfile(
      compressionProfile,
      this.state.compressionProfile,
    );
    this.state.encoderMode = normalizeEncoderMode(encoderMode, this.state.encoderMode);
    this.state.updatedAt = new Date().toISOString();
    await this.persist();
    return this.snapshot();
  }
}
