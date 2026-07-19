import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./api-error.mjs";

const MAX_PLAYLISTS = 100;
const MAX_ITEMS = 1_000;

function normalizePlaylist(value) {
  if (typeof value?.id !== "string" || !value.id || typeof value?.name !== "string") return null;
  const items = (Array.isArray(value.items) ? value.items : [])
    .filter((item) => typeof item?.id === "string" && typeof item?.videoId === "string")
    .slice(0, MAX_ITEMS)
    .map((item) => ({
      id: item.id,
      videoId: item.videoId,
      addedAt: typeof item.addedAt === "string" ? item.addedAt : new Date(0).toISOString(),
    }));
  return {
    id: value.id,
    name: value.name.trim().slice(0, 120) || "Без назви",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    items,
  };
}

export class PlaylistStore {
  constructor({ rootDir, repository = null } = {}) {
    if (!rootDir) throw new Error("PlaylistStore requires rootDir.");
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "playlists.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.repository = repository;
    this.documentKey = "playlists";
    this.playlists = [];
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
      }
    }
    this.playlists = (Array.isArray(parsed?.playlists) ? parsed.playlists : [])
      .map(normalizePlaylist)
      .filter(Boolean)
      .slice(0, MAX_PLAYLISTS);
    await this.persist();
    return this.list();
  }

  payload() {
    return { schemaVersion: 1, playlists: this.playlists };
  }

  async persist() {
    const state = this.payload();
    const payload = JSON.stringify(state, null, 2);
    await writeFile(this.tempPath, payload, "utf8");
    await rename(this.tempPath, this.filePath);
    await this.repository?.writeDocument?.(this.documentKey, state);
  }

  mutate(action) {
    const operation = this.mutationQueue.catch(() => {}).then(async () => {
      const result = action();
      await this.persist();
      return result;
    });
    this.mutationQueue = operation;
    return operation;
  }

  list() {
    return this.playlists.map((playlist) => ({
      ...playlist,
      items: playlist.items.map((item, position) => ({ ...item, position })),
    }));
  }

  require(id) {
    const playlist = this.playlists.find((item) => item.id === id);
    if (!playlist) throw new ApiError(404, "PLAYLIST_NOT_FOUND", "Плейлист не знайдено.");
    return playlist;
  }

  create(name) {
    const cleanName = typeof name === "string" ? name.trim().slice(0, 120) : "";
    if (!cleanName) throw new ApiError(400, "PLAYLIST_NAME_REQUIRED", "Вкажіть назву плейлиста.");
    return this.mutate(() => {
      if (this.playlists.length >= MAX_PLAYLISTS) {
        throw new ApiError(409, "PLAYLIST_LIMIT_REACHED", "Досягнуто ліміт у 100 плейлистів.");
      }
      const now = new Date().toISOString();
      const playlist = { id: randomUUID(), name: cleanName, createdAt: now, updatedAt: now, items: [] };
      this.playlists.push(playlist);
      return { ...playlist, items: [] };
    });
  }

  rename(id, name) {
    const cleanName = typeof name === "string" ? name.trim().slice(0, 120) : "";
    if (!cleanName) throw new ApiError(400, "PLAYLIST_NAME_REQUIRED", "Вкажіть назву плейлиста.");
    return this.mutate(() => {
      const playlist = this.require(id);
      playlist.name = cleanName;
      playlist.updatedAt = new Date().toISOString();
      return { ...playlist };
    });
  }

  remove(id) {
    return this.mutate(() => {
      const index = this.playlists.findIndex((item) => item.id === id);
      if (index < 0) throw new ApiError(404, "PLAYLIST_NOT_FOUND", "Плейлист не знайдено.");
      return this.playlists.splice(index, 1)[0];
    });
  }

  addItem(id, videoId) {
    if (typeof videoId !== "string" || !videoId) {
      throw new ApiError(400, "VIDEO_ID_REQUIRED", "Не вказано відео.");
    }
    return this.mutate(() => {
      const playlist = this.require(id);
      if (playlist.items.length >= MAX_ITEMS) {
        throw new ApiError(409, "PLAYLIST_ITEM_LIMIT_REACHED", "Плейлист уже містить 1000 відео.");
      }
      const item = { id: randomUUID(), videoId, addedAt: new Date().toISOString() };
      playlist.items.push(item);
      playlist.updatedAt = new Date().toISOString();
      return { ...item, position: playlist.items.length - 1 };
    });
  }

  removeItem(id, itemId) {
    return this.mutate(() => {
      const playlist = this.require(id);
      const index = playlist.items.findIndex((item) => item.id === itemId);
      if (index < 0) throw new ApiError(404, "PLAYLIST_ITEM_NOT_FOUND", "Відео у плейлисті не знайдено.");
      playlist.updatedAt = new Date().toISOString();
      return playlist.items.splice(index, 1)[0];
    });
  }

  reorder(id, itemIds) {
    return this.mutate(() => {
      const playlist = this.require(id);
      if (!Array.isArray(itemIds) || itemIds.length !== playlist.items.length) {
        throw new ApiError(400, "INVALID_PLAYLIST_ORDER", "Новий порядок не відповідає плейлисту.");
      }
      const byId = new Map(playlist.items.map((item) => [item.id, item]));
      if (new Set(itemIds).size !== playlist.items.length || itemIds.some((itemId) => !byId.has(itemId))) {
        throw new ApiError(400, "INVALID_PLAYLIST_ORDER", "Новий порядок містить невідомі елементи.");
      }
      playlist.items = itemIds.map((itemId) => byId.get(itemId));
      playlist.updatedAt = new Date().toISOString();
      return playlist.items.map((item, position) => ({ ...item, position }));
    });
  }

  removeVideo(videoId) {
    return this.mutate(() => {
      let removed = 0;
      for (const playlist of this.playlists) {
        const before = playlist.items.length;
        playlist.items = playlist.items.filter((item) => item.videoId !== videoId);
        if (playlist.items.length !== before) playlist.updatedAt = new Date().toISOString();
        removed += before - playlist.items.length;
      }
      return removed;
    });
  }
}
