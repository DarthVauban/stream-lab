import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./api-error.mjs";

const MAX_QUEUE_ITEMS = 1_000;

function normalizeItem(item) {
  if (
    typeof item?.id !== "string" ||
    !item.id ||
    typeof item?.videoId !== "string" ||
    !item.videoId
  ) {
    return null;
  }
  return {
    id: item.id,
    videoId: item.videoId,
    addedAt: typeof item.addedAt === "string" ? item.addedAt : new Date(0).toISOString(),
  };
}

export class QueueStore {
  constructor({ rootDir, repository = null } = {}) {
    if (!rootDir) throw new Error("Для черги не вказано rootDir.");
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "queue.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.repository = repository;
    this.documentKey = "queue";
    this.items = [];
    this.mode = "LOOP_ALL";
    this.version = 0;
    this.updatedAt = null;
    this.mutationQueue = Promise.resolve();
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
      const items = Array.isArray(parsed?.items)
        ? parsed.items.map(normalizeItem).filter(Boolean).slice(0, MAX_QUEUE_ITEMS)
        : [];
      const uniqueIds = new Set();
      this.items = items.filter((item) => {
        if (uniqueIds.has(item.id)) return false;
        uniqueIds.add(item.id);
        return true;
      });
      this.version = Number.isSafeInteger(parsed?.version) ? parsed.version : 0;
      this.updatedAt = typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null;
    }
    await this.persist();
    return this.snapshot();
  }

  snapshot() {
    return {
      mode: this.mode,
      version: this.version,
      updatedAt: this.updatedAt,
      items: this.items.map((item, index) => ({ ...item, position: index })),
    };
  }

  async persist() {
    const payload = JSON.stringify(
      {
        schemaVersion: 1,
        mode: this.mode,
        version: this.version,
        updatedAt: this.updatedAt,
        items: this.items,
      },
      null,
      2,
    );
    await writeFile(this.tempPath, payload, "utf8");
    await rename(this.tempPath, this.filePath);
    await this.repository?.writeDocument?.(this.documentKey, JSON.parse(payload));
  }

  mutate(action) {
    const operation = this.mutationQueue.catch(() => {}).then(async () => {
      const result = action();
      this.version += 1;
      this.updatedAt = new Date().toISOString();
      await this.persist();
      return result;
    });
    this.mutationQueue = operation;
    return operation;
  }

  add(videoId) {
    if (typeof videoId !== "string" || !videoId) {
      throw new ApiError(400, "VIDEO_ID_REQUIRED", "Не вказано відео для черги.");
    }
    return this.mutate(() => {
      if (this.items.length >= MAX_QUEUE_ITEMS) {
        throw new ApiError(409, "QUEUE_LIMIT_REACHED", "Черга вже містить 1000 елементів.");
      }
      const item = { id: randomUUID(), videoId, addedAt: new Date().toISOString() };
      this.items.push(item);
      return { ...item, position: this.items.length - 1 };
    });
  }

  remove(itemId) {
    return this.mutate(() => {
      const index = this.items.findIndex((item) => item.id === itemId);
      if (index === -1) {
        throw new ApiError(404, "QUEUE_ITEM_NOT_FOUND", "Елемент черги не знайдено.");
      }
      return this.items.splice(index, 1)[0];
    });
  }

  removeVideo(videoId) {
    return this.mutate(() => {
      const previousLength = this.items.length;
      this.items = this.items.filter((item) => item.videoId !== videoId);
      return previousLength - this.items.length;
    });
  }

  moveNext(itemId, afterItemId = null) {
    return this.mutate(() => {
      const index = this.items.findIndex((item) => item.id === itemId);
      if (index === -1) {
        throw new ApiError(404, "QUEUE_ITEM_NOT_FOUND", "Елемент черги не знайдено.");
      }
      const [item] = this.items.splice(index, 1);
      const afterIndex = afterItemId
        ? this.items.findIndex((candidate) => candidate.id === afterItemId)
        : -1;
      const position = afterIndex >= 0 ? afterIndex + 1 : 0;
      this.items.splice(position, 0, item);
      return { ...item, position };
    });
  }

  reorder(itemIds) {
    return this.mutate(() => {
      if (!Array.isArray(itemIds) || itemIds.length !== this.items.length) {
        throw new ApiError(400, "INVALID_QUEUE_ORDER", "Новий порядок не відповідає черзі.");
      }
      const requestedIds = new Set(itemIds);
      if (requestedIds.size !== this.items.length || this.items.some((item) => !requestedIds.has(item.id))) {
        throw new ApiError(400, "INVALID_QUEUE_ORDER", "Новий порядок містить невідомі елементи.");
      }
      const byId = new Map(this.items.map((item) => [item.id, item]));
      this.items = itemIds.map((id) => byId.get(id));
      return this.snapshot().items;
    });
  }

  replace(videoIds) {
    if (!Array.isArray(videoIds) || videoIds.length > MAX_QUEUE_ITEMS) {
      throw new ApiError(400, "INVALID_QUEUE_ITEMS", "Некоректний список відео для черги.");
    }
    if (videoIds.some((videoId) => typeof videoId !== "string" || !videoId)) {
      throw new ApiError(400, "INVALID_QUEUE_ITEMS", "Список черги містить невідоме відео.");
    }
    return this.mutate(() => {
      const now = new Date().toISOString();
      this.items = videoIds.map((videoId) => ({ id: randomUUID(), videoId, addedAt: now }));
      return this.snapshot().items;
    });
  }
}
