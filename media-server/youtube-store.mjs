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
const RAW_STATS_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_RECENT_SUBSCRIBERS = 500;

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
    subscriberCount: Number.isFinite(Number(value.subscriberCount))
      ? Math.max(0, Number(value.subscriberCount))
      : null,
    videoId: typeof value.videoId === "string" && value.videoId ? value.videoId : null,
    videoName: typeof value.videoName === "string" && value.videoName ? value.videoName.slice(0, 255) : null,
    queueItemId: typeof value.queueItemId === "string" && value.queueItemId ? value.queueItemId : null,
    positionMs: Math.max(0, Number(value.positionMs) || 0),
    bitrateKbps: Math.max(0, Number(value.bitrateKbps) || 0),
    fps: Math.max(0, Number(value.fps) || 0),
    droppedFrames: Math.max(0, Number(value.droppedFrames) || 0),
    cpuPercent: Math.max(0, Math.min(100, Number(value.cpuPercent) || 0)),
    memoryPercent: Math.max(0, Math.min(100, Number(value.memoryPercent) || 0)),
    networkOutputBytesPerSecond: Math.max(0, Number(value.networkOutputBytesPerSecond) || 0),
    promoImpressions: Math.max(0, Number(value.promoImpressions) || 0),
    streamStatus: typeof value.streamStatus === "string" ? value.streamStatus : "STOPPED",
    playbackError: Boolean(value.playbackError),
    activePromoIds: [...new Set(
      (Array.isArray(value.activePromoIds) ? value.activePromoIds : [])
        .filter((id) => typeof id === "string" && id)
        .map((id) => id.slice(0, 100)),
    )],
  };
}

function normalizeSubscriber(value) {
  if (!value || typeof value.subscriptionId !== "string" || !value.subscriptionId) return null;
  return {
    subscriptionId: value.subscriptionId.slice(0, 200),
    subscriberChannelId: typeof value.subscriberChannelId === "string"
      ? value.subscriberChannelId.slice(0, 200)
      : "",
    subscriberName: typeof value.subscriberName === "string"
      ? value.subscriberName.slice(0, 255)
      : "Невідомий підписник",
    thumbnailUrl: typeof value.thumbnailUrl === "string" ? value.thumbnailUrl.slice(0, 2_000) : null,
    subscribedAt: typeof value.subscribedAt === "string" ? value.subscribedAt : null,
    detectedAt: typeof value.detectedAt === "string" ? value.detectedAt : new Date().toISOString(),
    telegramSentAt: typeof value.telegramSentAt === "string" ? value.telegramSentAt : null,
  };
}

function normalizeAnalyticsStat(value) {
  if (!value || typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return null;
  return {
    date: value.date,
    views: Math.max(0, Number(value.views) || 0),
    estimatedMinutesWatched: Math.max(0, Number(value.estimatedMinutesWatched) || 0),
    averageViewDurationSeconds: Math.max(0, Number(value.averageViewDurationSeconds) || 0),
    likes: Math.max(0, Number(value.likes) || 0),
    subscribersGained: Math.max(0, Number(value.subscribersGained) || 0),
    subscribersLost: Math.max(0, Number(value.subscribersLost) || 0),
    estimatedRevenue: value.estimatedRevenue !== null
      && value.estimatedRevenue !== undefined
      && Number.isFinite(Number(value.estimatedRevenue))
      ? Math.max(0, Number(value.estimatedRevenue))
      : null,
  };
}

function compactStats(items, now = Date.now()) {
  const cutoff = now - RAW_STATS_RETENTION_MS;
  const hourly = new Map();
  const recent = [];
  for (const item of items) {
    const timestamp = Date.parse(item.capturedAt);
    if (!Number.isFinite(timestamp) || timestamp >= cutoff) {
      recent.push(item);
      continue;
    }
    const hour = new Date(timestamp).toISOString().slice(0, 13);
    hourly.set(`${item.broadcastId}:${hour}`, item);
  }
  return [...hourly.values(), ...recent].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
    this.subscribers = [];
    this.subscribersInitializedAt = null;
    this.analyticsHistory = [];
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
        .filter(Boolean);
      this.subscribers = (Array.isArray(parsed?.subscribers) ? parsed.subscribers : [])
        .map(normalizeSubscriber)
        .filter(Boolean)
        .slice(-MAX_RECENT_SUBSCRIBERS);
      this.subscribersInitializedAt = typeof parsed?.subscribersInitializedAt === "string"
        ? parsed.subscribersInitializedAt
        : null;
      this.analyticsHistory = (Array.isArray(parsed?.analyticsHistory) ? parsed.analyticsHistory : [])
        .map(normalizeAnalyticsStat)
        .filter(Boolean)
        .sort((left, right) => left.date.localeCompare(right.date));
    }
    await this.persist();
  }

  async persist() {
    const payload = JSON.stringify({
      schemaVersion: 2,
      items: this.items,
      subscribers: this.subscribers,
      subscribersInitializedAt: this.subscribersInitializedAt,
      analyticsHistory: this.analyticsHistory,
    }, null, 2);
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
    this.items = compactStats(this.items, Date.parse(item.capturedAt) || Date.now());
    await this.persist();
  }

  list({
    hours = 24,
    limit = 240,
    broadcastId = null,
    since = null,
    until = null,
    all = false,
    referenceTime = Date.now(),
  } = {}) {
    const explicitSince = Date.parse(since);
    const explicitUntil = Date.parse(until);
    const currentTime = Number.isFinite(Number(referenceTime)) ? Number(referenceTime) : Date.now();
    const lowerBound = all
      ? Number.NEGATIVE_INFINITY
      : Number.isFinite(explicitSince)
        ? explicitSince
        : currentTime - Math.max(1, Math.min(24 * 365, Number(hours) || 24)) * 3_600_000;
    const upperBound = Number.isFinite(explicitUntil) ? explicitUntil : Number.POSITIVE_INFINITY;
    const filtered = this.items.filter(
      (item) =>
        new Date(item.capturedAt).getTime() >= lowerBound &&
        new Date(item.capturedAt).getTime() <= upperBound &&
        (!broadcastId || item.broadcastId === broadcastId),
    );
    if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) return structuredClone(filtered);
    if (filtered.length <= limit) return structuredClone(filtered);
    const step = filtered.length / limit;
    return Array.from({ length: limit }, (_, index) => filtered[Math.floor(index * step)]).map(
      (item) => ({ ...item }),
    );
  }

  async mergeSubscribers(values, { detectedAt = new Date().toISOString() } = {}) {
    const initialized = Boolean(this.subscribersInitializedAt);
    const known = new Map(this.subscribers.map((item) => [item.subscriptionId, item]));
    const added = [];
    for (const value of values) {
      const normalized = normalizeSubscriber({ ...value, detectedAt });
      if (!normalized || known.has(normalized.subscriptionId)) continue;
      known.set(normalized.subscriptionId, normalized);
      added.push(normalized);
    }
    this.subscribers = [...known.values()]
      .sort((left, right) => String(left.subscribedAt || left.detectedAt).localeCompare(String(right.subscribedAt || right.detectedAt)))
      .slice(-MAX_RECENT_SUBSCRIBERS);
    this.subscribersInitializedAt ??= detectedAt;
    await this.persist();
    return {
      initialized,
      added: initialized ? structuredClone(added) : [],
      subscribers: this.listSubscribers(),
    };
  }

  listSubscribers({ limit = 50 } = {}) {
    return structuredClone(this.subscribers.slice(-Math.max(1, Math.min(500, Number(limit) || 50))).reverse());
  }

  async markSubscriberTelegramSent(subscriptionId, sentAt = new Date().toISOString()) {
    const subscriber = this.subscribers.find((item) => item.subscriptionId === subscriptionId);
    if (!subscriber || subscriber.telegramSentAt) return subscriber ? structuredClone(subscriber) : null;
    subscriber.telegramSentAt = sentAt;
    await this.persist();
    return structuredClone(subscriber);
  }

  async replaceAnalyticsHistory(values) {
    const incoming = values.map(normalizeAnalyticsStat).filter(Boolean);
    const byDate = new Map(this.analyticsHistory.map((item) => [item.date, item]));
    for (const item of incoming) byDate.set(item.date, item);
    this.analyticsHistory = [...byDate.values()]
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-366);
    await this.persist();
    return this.listAnalyticsHistory();
  }

  listAnalyticsHistory({ days = 30 } = {}) {
    return structuredClone(this.analyticsHistory.slice(-Math.max(1, Math.min(366, Number(days) || 30))));
  }

  videoStatistics(options = {}) {
    const items = this.list({ ...options, limit: 0 }).filter((item) => item.videoId);
    const sessions = [];
    let session = null;
    for (const item of items) {
      const timestamp = Date.parse(item.capturedAt);
      const previous = session?.samples.at(-1);
      const gap = previous ? timestamp - Date.parse(previous.capturedAt) : 0;
      const changed = !session ||
        session.videoId !== item.videoId ||
        (session.queueItemId && item.queueItemId && session.queueItemId !== item.queueItemId) ||
        (previous && item.positionMs + 5_000 < previous.positionMs) ||
        gap > 120_000;
      if (changed) {
        session = {
          videoId: item.videoId,
          videoName: item.videoName || item.videoId,
          queueItemId: item.queueItemId,
          samples: [],
        };
        sessions.push(session);
      }
      session.samples.push(item);
    }
    const byVideo = new Map();
    for (const item of sessions) {
      const first = item.samples[0];
      const last = item.samples.at(-1);
      const current = byVideo.get(item.videoId) || {
        videoId: item.videoId,
        videoName: item.videoName,
        sessions: [],
      };
      current.sessions.push({
        startedAt: first.capturedAt,
        endedAt: last.capturedAt,
        startViewers: first.viewers,
        endViewers: last.viewers,
        peakViewers: Math.max(...item.samples.map((sample) => sample.viewers)),
        watchIntervalSeconds: Math.max(0, (Date.parse(last.capturedAt) - Date.parse(first.capturedAt)) / 1_000),
        promoIds: [...new Set(item.samples.flatMap((sample) => sample.activePromoIds))],
        playbackErrors: item.samples.filter((sample) => sample.playbackError).length,
      });
      byVideo.set(item.videoId, current);
    }
    return [...byVideo.values()].map((item) => ({
      videoId: item.videoId,
      videoName: item.videoName,
      playCount: item.sessions.length,
      averageStartViewers: Number(average(item.sessions.map((sessionItem) => sessionItem.startViewers)).toFixed(2)),
      averageEndViewers: Number(average(item.sessions.map((sessionItem) => sessionItem.endViewers)).toFixed(2)),
      audienceChange: Number(average(item.sessions.map((sessionItem) => sessionItem.endViewers - sessionItem.startViewers)).toFixed(2)),
      localPeakViewers: Math.max(...item.sessions.map((sessionItem) => sessionItem.peakViewers)),
      averageWatchIntervalSeconds: Number(average(item.sessions.map((sessionItem) => sessionItem.watchIntervalSeconds)).toFixed(2)),
      promoIds: [...new Set(item.sessions.flatMap((sessionItem) => sessionItem.promoIds))],
      playbackErrors: item.sessions.reduce((sum, sessionItem) => sum + sessionItem.playbackErrors, 0),
      officialYouTubeMetric: false,
    })).sort((left, right) => right.playCount - left.playCount || left.videoName.localeCompare(right.videoName));
  }
}
