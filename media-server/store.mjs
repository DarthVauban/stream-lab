import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, truncate, writeFile } from "node:fs/promises";
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
    uploadedBytes: record.uploadedBytes,
    status: record.status,
    createdAt: record.createdAt,
    completedAt: record.completedAt ?? null,
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
    this.persistQueue = this.persistQueue.then(async () => {
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
      storedName: `${id}${validated.extension}`,
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
    if (record.status === "READY") return publicRecord(record);
    if (record.uploadedBytes !== record.size) {
      throw new ApiError(
        409,
        "UPLOAD_INCOMPLETE",
        `Завантажено ${record.uploadedBytes} із ${record.size} байтів.`,
      );
    }

    await rename(this.partialPath(record), this.videoPath(record));
    record.status = "READY";
    record.completedAt = new Date().toISOString();
    await this.persist();
    return publicRecord(record);
  }

  listVideos() {
    return this.records
      .filter((record) => record.status === "READY")
      .map(publicRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getReadyVideo(id) {
    const record = this.find(id);
    if (!record || record.status !== "READY") {
      throw new ApiError(404, "VIDEO_NOT_FOUND", "Готове відео не знайдено.");
    }
    return { ...publicRecord(record), filePath: this.videoPath(record) };
  }

  partialPath(record) {
    return path.join(this.uploadsDir, `${record.id}.part`);
  }

  videoPath(record) {
    return path.join(this.uploadsDir, record.storedName);
  }
}
