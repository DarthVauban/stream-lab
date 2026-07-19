import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE_VERSION = 1;
const AAD = Buffer.from("streamlab-youtube-oauth-v1", "utf8");
const MAX_STATS_SNAPSHOTS = 10_080;

function emptyState() {
  return {
    tokens: null,
    pendingAuth: null,
    selectedBroadcastId: null,
    connectedAt: null,
    quota: null,
    runtimeCache: null,
  };
}

function normalizeState(value) {
  const state = emptyState();
  if (value?.tokens && typeof value.tokens === "object") {
    state.tokens = {
      accessToken: typeof value.tokens.accessToken === "string" ? value.tokens.accessToken : "",
      refreshToken: typeof value.tokens.refreshToken === "string" ? value.tokens.refreshToken : "",
      expiryDate: Number(value.tokens.expiryDate) || 0,
      scope: typeof value.tokens.scope === "string" ? value.tokens.scope : "",
      tokenType: typeof value.tokens.tokenType === "string" ? value.tokens.tokenType : "Bearer",
    };
    if (!state.tokens.refreshToken) state.tokens = null;
  }
  if (
    value?.pendingAuth &&
    typeof value.pendingAuth.state === "string" &&
    Number.isFinite(Number(value.pendingAuth.expiresAt))
  ) {
    state.pendingAuth = {
      state: value.pendingAuth.state,
      expiresAt: Number(value.pendingAuth.expiresAt),
    };
  }
  state.selectedBroadcastId =
    typeof value?.selectedBroadcastId === "string" && value.selectedBroadcastId
      ? value.selectedBroadcastId
      : null;
  state.connectedAt = typeof value?.connectedAt === "string" ? value.connectedAt : null;
  if (value?.quota && typeof value.quota.date === "string") {
    state.quota = {
      date: value.quota.date,
      used: Math.max(0, Number(value.quota.used) || 0),
      updatedAt: typeof value.quota.updatedAt === "string" ? value.quota.updatedAt : null,
    };
  }
  if (value?.runtimeCache && typeof value.runtimeCache === "object") {
    state.runtimeCache = structuredClone(value.runtimeCache);
  }
  return state;
}

export class EncryptedYouTubeStore {
  constructor({ rootDir, secret = process.env.YOUTUBE_TOKEN_SECRET || process.env.STREAM_CONFIG_SECRET } = {}) {
    if (!rootDir) throw new Error("Для інтеграції YouTube не вказано rootDir.");
    if (typeof secret !== "string" || secret.length < 32) {
      throw new Error("YOUTUBE_TOKEN_SECRET або STREAM_CONFIG_SECRET повинен містити щонайменше 32 символи.");
    }
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "youtube-oauth.enc.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.key = createHash("sha256").update(secret, "utf8").digest();
    this.state = emptyState();
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
    try {
      const envelope = JSON.parse(await readFile(this.filePath, "utf8"));
      if (envelope?.version !== FILE_VERSION) throw new Error("Unsupported version");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      this.state = normalizeState(JSON.parse(plaintext.toString("utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(
          "Не вдалося розшифрувати YouTube OAuth. Перевірте YOUTUBE_TOKEN_SECRET або STREAM_CONFIG_SECRET.",
          { cause: error },
        );
      }
      await this.persist();
    }
    return this.read();
  }

  read() {
    return structuredClone(this.state);
  }

  async persist() {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(this.state), "utf8"),
      cipher.final(),
    ]);
    const envelope = JSON.stringify(
      {
        version: FILE_VERSION,
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      },
      null,
      2,
    );
    await writeFile(this.tempPath, envelope, { encoding: "utf8", mode: 0o600 });
    await rename(this.tempPath, this.filePath);
  }

  mutate(action) {
    const operation = this.mutationQueue.catch(() => {}).then(async () => {
      const result = action(this.state);
      await this.persist();
      return result;
    });
    this.mutationQueue = operation;
    return operation;
  }

  setPendingAuth(pendingAuth) {
    return this.mutate((state) => {
      state.pendingAuth = { ...pendingAuth };
    });
  }

  clearPendingAuth() {
    return this.mutate((state) => {
      state.pendingAuth = null;
    });
  }

  saveTokens(tokens) {
    return this.mutate((state) => {
      state.tokens = { ...tokens };
      state.pendingAuth = null;
      state.connectedAt ??= new Date().toISOString();
    });
  }

  setSelectedBroadcast(selectedBroadcastId) {
    return this.mutate((state) => {
      state.selectedBroadcastId = selectedBroadcastId;
    });
  }

  setQuota(quota) {
    return this.mutate((state) => {
      state.quota = { ...quota };
    });
  }

  setRuntimeCache(runtimeCache) {
    return this.mutate((state) => {
      state.runtimeCache = runtimeCache ? structuredClone(runtimeCache) : null;
    });
  }

  clearConnection() {
    return this.mutate((state) => {
      const quota = state.quota;
      this.state = { ...emptyState(), quota };
    });
  }
}

function normalizeStat(value) {
  if (!value || typeof value.capturedAt !== "string" || typeof value.broadcastId !== "string") {
    return null;
  }
  return {
    capturedAt: value.capturedAt,
    broadcastId: value.broadcastId,
    viewers: Math.max(0, Number(value.viewers) || 0),
    views: Math.max(0, Number(value.views) || 0),
    likes: Math.max(0, Number(value.likes) || 0),
    health: typeof value.health === "string" ? value.health : "noData",
  };
}

export class YouTubeStatsStore {
  constructor({ rootDir, repository = null } = {}) {
    if (!rootDir) throw new Error("Для статистики YouTube не вказано rootDir.");
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "youtube-stats.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.repository = repository;
    this.documentKey = "youtube-stats";
    this.items = [];
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
      this.items = (Array.isArray(parsed?.items) ? parsed.items : [])
        .map(normalizeStat)
        .filter(Boolean)
        .slice(-MAX_STATS_SNAPSHOTS);
    }
    await this.persist();
  }

  async persist() {
    const payload = JSON.stringify({ schemaVersion: 1, items: this.items }, null, 2);
    const operation = this.persistQueue.catch(() => {}).then(async () => {
      await writeFile(this.tempPath, payload, "utf8");
      await rename(this.tempPath, this.filePath);
      await this.repository?.writeDocument?.(this.documentKey, JSON.parse(payload));
    });
    this.persistQueue = operation;
    await operation;
  }

  async append(input) {
    const item = normalizeStat(input);
    if (!item) return;
    const previous = this.items.at(-1);
    if (
      previous &&
      previous.broadcastId === item.broadcastId &&
      new Date(item.capturedAt).getTime() - new Date(previous.capturedAt).getTime() < 45_000
    ) {
      this.items[this.items.length - 1] = item;
    } else {
      this.items.push(item);
    }
    this.items = this.items.slice(-MAX_STATS_SNAPSHOTS);
    await this.persist();
  }

  list({ hours = 24, limit = 120, broadcastId = null } = {}) {
    const since = Date.now() - Math.max(1, Math.min(168, Number(hours) || 24)) * 3_600_000;
    const filtered = this.items.filter(
      (item) =>
        new Date(item.capturedAt).getTime() >= since &&
        (!broadcastId || item.broadcastId === broadcastId),
    );
    if (filtered.length <= limit) return structuredClone(filtered);
    const step = filtered.length / limit;
    return Array.from({ length: limit }, (_, index) => filtered[Math.floor(index * step)]).map(
      (item) => ({ ...item }),
    );
  }
}
