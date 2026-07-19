import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError } from "./api-error.mjs";

const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;

function publicRecord(record) {
  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    preparedSize: record.preparedSize ?? null,
    uploadedBytes: record.uploadedBytes,
    status: record.status,
    createdAt: record.createdAt,
    completedAt: record.completedAt ?? null,
    processingProgress: record.processingProgress ?? (record.status === "READY" ? 100 : 0),
    processingError: record.processingError ?? null,
    processingStartedAt: record.processingStartedAt ?? null,
    processedAt: record.processedAt ?? null,
    media: record.mediaInfo ?? record.sourceMediaInfo ?? null,
  };
}

function validateUpload(input, maxUploadBytes) {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const size = Number(input?.size);
  const mimeType = typeof input?.mimeType === "string" ? input.mimeType.slice(0, 120) : "";
  const extension = path.extname(name).toLowerCase();

  if (!name || name.length > 255) {
    throw new ApiError(400, "INVALID_FILE_NAME", "Некоректна назва файлу.");
  }
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new ApiError(400, "UNSUPPORTED_FILE_TYPE", "Підтримуються MP4, MOV, MKV, WEBM і M4V.");
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxUploadBytes) {
    throw new ApiError(400, "INVALID_FILE_SIZE", "Некоректний розмір файлу або перевищено ліміт.");
  }

  return { name, size, mimeType, extension };
}

export class VideoStore {
  constructor({ rootDir, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES }) {
    this.rootDir = rootDir;
    this.uploadsDir = path.join(rootDir, "uploads");
    this.catalogPath = path.join(rootDir, "videos.json");
    this.maxUploadBytes = maxUploadBytes;
    this.records = [];
    this.activeWrites = new Set();
    this.persistQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.uploadsDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.catalogPath, "utf8"));
      this.records = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.records = [];
      await this.persist();
    }
  }

  async persist() {
    const snapshot = JSON.stringify(this.records, null, 2);
    const tempPath = `${this.catalogPath}.tmp`;
    this.persistQueue = this.persistQueue.catch(() => {}).then(async () => {
      await writeFile(tempPath, snapshot, "utf8");
      await rename(tempPath, this.catalogPath);
    });
    await this.persistQueue;
  }

  find(id) {
    return this.records.find((record) => record.id === id);
  }

  requireUpload(id) {
    const record = this.find(id);
    if (!record) {
      throw new ApiError(404, "UPLOAD_NOT_FOUND", "Завантаження не знайдено.");
    }
    return record;
  }

  async createUpload(input) {
    const validated = validateUpload(input, this.maxUploadBytes);
    const id = randomUUID();
    const now = new Date().toISOString();
    const record = {
      id,
      name: validated.name,
      mimeType: validated.mimeType,
      size: validated.size,
      uploadedBytes: 0,
      status: "UPLOADING",
      extension: validated.extension,
      storedName: null,
      sourceStoredName: `${id}.source${validated.extension}`,
      streamStoredName: `${id}.stream.mp4`,
      processingProgress: 0,
      processingError: null,
      createdAt: now,
    };

    const handle = await open(this.partialPath(record), "wx");
    await handle.close();
    this.records.push(record);
    await this.persist();
    return publicRecord(record);
  }

  async appendChunk(id, requestedOffset, readable) {
    const record = this.requireUpload(id);
    if (record.status !== "UPLOADING") {
      throw new ApiError(409, "UPLOAD_NOT_ACTIVE", "Завантаження вже завершено.");
    }
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset !== record.uploadedBytes) {
      throw new ApiError(
        409,
        "OFFSET_MISMATCH",
        `Очікуваний offset: ${record.uploadedBytes}.`,
      );
    }
    if (this.activeWrites.has(id)) {
      throw new ApiError(409, "CHUNK_IN_PROGRESS", "Попередній блок ще записується.");
    }

    const actualSize = (await stat(this.partialPath(record))).size;
    if (actualSize < record.uploadedBytes) {
      record.uploadedBytes = actualSize;
      await this.persist();
      throw new ApiError(409, "OFFSET_MISMATCH", `Очікуваний offset: ${actualSize}.`);
    }
    if (actualSize > record.uploadedBytes) {
      await truncate(this.partialPath(record), record.uploadedBytes);
    }

    this.activeWrites.add(id);
    let received = 0;
    const limiter = new Transform({
      transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        if (requestedOffset + received > record.size) {
          callback(new ApiError(413, "UPLOAD_TOO_LARGE", "Отримано більше байтів, ніж заявлено."));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        readable,
        limiter,
        createWriteStream(this.partialPath(record), { flags: "a" }),
      );
      if (received === 0) {
        throw new ApiError(400, "EMPTY_CHUNK", "Порожній блок завантаження.");
      }
      record.uploadedBytes = requestedOffset + received;
      await this.persist();
      return publicRecord(record);
    } catch (error) {
      await truncate(this.partialPath(record), requestedOffset).catch(() => {});
      throw error;
    } finally {
      this.activeWrites.delete(id);
    }
  }

  async completeUpload(id) {
    const record = this.requireUpload(id);
    if (record.status !== "UPLOADING") return publicRecord(record);
    if (record.uploadedBytes !== record.size) {
      throw new ApiError(
        409,
        "UPLOAD_INCOMPLETE",
        `Завантажено ${record.uploadedBytes} із ${record.size} байтів.`,
      );
    }

    await rename(this.partialPath(record), this.sourcePath(record));
    record.status = "ANALYZING";
    record.completedAt = new Date().toISOString();
    record.processingProgress = 0;
    record.processingError = null;
    await this.persist();
    return publicRecord(record);
  }

  listVideos() {
    return this.records
      .filter((record) => record.status !== "UPLOADING")
      .map(publicRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listPendingProcessingIds() {
    return this.records
      .filter((record) => ["ANALYZING", "PROCESSING"].includes(record.status))
      .map((record) => record.id);
  }

  async beginAnalysis(id) {
    const record = this.requireUpload(id);
    if (!["ANALYZING", "PROCESSING"].includes(record.status)) {
      throw new ApiError(409, "VIDEO_NOT_PROCESSABLE", "Відео не очікує обробки.");
    }
    record.status = "ANALYZING";
    record.processingProgress = 0;
    record.processingError = null;
    record.processingStartedAt = new Date().toISOString();
    await rm(this.tempOutputPath(record), { force: true }).catch(() => {});
    await this.persist();
    return publicRecord(record);
  }

  async beginTranscode(id, sourceMediaInfo) {
    const record = this.requireUpload(id);
    if (record.status !== "ANALYZING") {
      throw new ApiError(409, "VIDEO_NOT_ANALYZING", "Аналіз відео ще не завершено.");
    }
    record.status = "PROCESSING";
    record.sourceMediaInfo = sourceMediaInfo;
    record.processingProgress = 0;
    await this.persist();
    return publicRecord(record);
  }

  async updateProcessingProgress(id, progress) {
    const record = this.find(id);
    if (!record || record.status !== "PROCESSING") return;
    const normalized = Math.min(99, Math.max(0, Math.floor(Number(progress) || 0)));
    if (normalized <= (record.processingProgress ?? 0)) return;
    record.processingProgress = normalized;
    await this.persist();
  }

  async completeProcessing(id, mediaInfo, { keepOriginal = false } = {}) {
    const record = this.requireUpload(id);
    if (record.status !== "PROCESSING") {
      throw new ApiError(409, "VIDEO_NOT_PROCESSING", "Відео зараз не обробляється.");
    }
    await rm(this.outputPath(record), { force: true }).catch(() => {});
    await rename(this.tempOutputPath(record), this.outputPath(record));
    record.preparedSize = (await stat(this.outputPath(record))).size;
    record.storedName = record.streamStoredName;
    record.mediaInfo = mediaInfo;
    record.status = "READY";
    record.processingProgress = 100;
    record.processingError = null;
    record.processedAt = new Date().toISOString();
    await this.persist();
    if (!keepOriginal) {
      try {
        await rm(this.sourcePath(record), { force: true });
        record.sourceStoredName = null;
        await this.persist();
      } catch {
        // The verified stream copy remains READY even if source cleanup must be retried later.
      }
    }
    return publicRecord(record);
  }

  async failProcessing(id, message) {
    const record = this.requireUpload(id);
    await rm(this.tempOutputPath(record), { force: true }).catch(() => {});
    record.status = "FAILED";
    record.processingError = String(message || "Не вдалося обробити відео.").slice(0, 500);
    await this.persist();
    return publicRecord(record);
  }

  async retryProcessing(id) {
    const record = this.requireUpload(id);
    if (record.status !== "FAILED" || !record.sourceStoredName) {
      throw new ApiError(409, "VIDEO_NOT_RETRYABLE", "Це відео неможливо обробити повторно.");
    }
    record.status = "ANALYZING";
    record.processingProgress = 0;
    record.processingError = null;
    await this.persist();
    return publicRecord(record);
  }

  getProcessingPaths(id) {
    const record = this.requireUpload(id);
    if (!record.sourceStoredName) {
      throw new ApiError(409, "VIDEO_SOURCE_MISSING", "Оригінальний файл відео не знайдено.");
    }
    return {
      sourcePath: this.sourcePath(record),
      tempOutputPath: this.tempOutputPath(record),
      outputPath: this.outputPath(record),
    };
  }

  getReadyVideo(id) {
    const record = this.find(id);
    if (!record || record.status !== "READY") {
      throw new ApiError(404, "VIDEO_NOT_FOUND", "Готове відео не знайдено.");
    }
    return { ...publicRecord(record), filePath: this.videoPath(record) };
  }

  getVideo(id) {
    const record = this.find(id);
    return record ? publicRecord(record) : null;
  }

  partialPath(record) {
    return path.join(this.uploadsDir, `${record.id}.part`);
  }

  videoPath(record) {
    return path.join(this.uploadsDir, record.storedName);
  }

  sourcePath(record) {
    return path.join(this.uploadsDir, record.sourceStoredName);
  }

  tempOutputPath(record) {
    return path.join(this.uploadsDir, `${record.id}.processing.tmp.mp4`);
  }

  outputPath(record) {
    return path.join(this.uploadsDir, record.streamStoredName || `${record.id}.stream.mp4`);
  }
}
