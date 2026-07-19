import { randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "./api-error.mjs";

const YOUTUBE_API_ROOT = "https://www.googleapis.com/youtube/v3";
const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
];

const POLL_INTERVALS = {
  channel: 10 * 60_000,
  broadcasts: 2 * 60_000,
  stream: 30_000,
  metrics: 60_000,
};

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function integer(value) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function quotaDate(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function cleanIssue(issue) {
  return {
    type: typeof issue?.type === "string" ? issue.type : "unknown",
    severity: typeof issue?.severity === "string" ? issue.severity : "info",
    reason: typeof issue?.reason === "string" ? issue.reason : "",
    description: typeof issue?.description === "string" ? issue.description : "",
  };
}

function publicBroadcast(item) {
  return {
    id: item.id,
    title: item.snippet?.title || "Трансляція без назви",
    scheduledStartAt: item.snippet?.scheduledStartTime || null,
    actualStartAt: item.snippet?.actualStartTime || null,
    lifeCycleStatus: item.status?.lifeCycleStatus || "unknown",
    privacyStatus: item.status?.privacyStatus || "unknown",
    boundStreamId: item.contentDetails?.boundStreamId || null,
    liveChatId: item.snippet?.liveChatId || null,
  };
}

function emptyRuntime() {
  return {
    channel: null,
    broadcasts: [],
    selected: null,
    stream: null,
    metrics: null,
    history: [],
    lastUpdatedAt: null,
    lastError: null,
  };
}

export class YouTubeService {
  constructor({
    clientId = process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI,
    dailyQuota = Number(process.env.YOUTUBE_DAILY_QUOTA || 10_000),
    store = null,
    statsStore = null,
    fetchImpl = fetch,
    now = () => Date.now(),
  } = {}) {
    this.clientId = typeof clientId === "string" ? clientId.trim() : "";
    this.clientSecret = typeof clientSecret === "string" ? clientSecret.trim() : "";
    this.redirectUri = typeof redirectUri === "string" ? redirectUri.trim() : "";
    this.configured = Boolean(this.clientId && this.clientSecret && this.redirectUri);
    this.dailyQuota = Number.isFinite(dailyQuota) && dailyQuota > 0 ? Math.round(dailyQuota) : 10_000;
    this.store = store;
    this.statsStore = statsStore;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.runtime = emptyRuntime();
    this.quota = { date: quotaDate(this.now()), used: 0, updatedAt: null };
    this.lastPoll = { channel: 0, broadcasts: 0, stream: 0, metrics: 0 };
    this.refreshPromise = null;
    this.tokenRefreshPromise = null;
    this.pollTimer = null;
    this.ingestion = null;
  }

  async init() {
    if (!this.configured) return this.snapshot();
    if (!this.store || !this.statsStore) {
      throw new Error("Для налаштованої YouTube інтеграції потрібні OAuth і stats store.");
    }
    await this.store.init();
    await this.statsStore.init();
    const saved = this.store.read();
    if (saved.quota?.date === quotaDate(this.now())) this.quota = { ...saved.quota };
    this.runtime.history = this.statsStore.list({
      hours: 24,
      broadcastId: saved.selectedBroadcastId,
    });
    return this.snapshot();
  }

  start() {
    if (!this.configured || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.refreshDue().catch(() => {});
    }, 15_000);
    this.pollTimer.unref?.();
    if (this.store.read().tokens) void this.refreshAll().catch(() => {});
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  assertConfigured() {
    if (!this.configured) {
      throw new ApiError(
        503,
        "YOUTUBE_NOT_CONFIGURED",
        "Додайте GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET і GOOGLE_OAUTH_REDIRECT_URI.",
      );
    }
  }

  assertConnected() {
    this.assertConfigured();
    if (!this.store.read().tokens) {
      throw new ApiError(409, "YOUTUBE_NOT_CONNECTED", "Спочатку підключіть YouTube-канал.");
    }
  }

  resetQuotaIfNeeded() {
    const date = quotaDate(this.now());
    if (this.quota.date !== date) this.quota = { date, used: 0, updatedAt: null };
  }

  addQuota(units = 1) {
    this.resetQuotaIfNeeded();
    this.quota.used += units;
    this.quota.updatedAt = new Date(this.now()).toISOString();
  }

  async persistQuota() {
    if (this.store) await this.store.setQuota(this.quota);
  }

  async beginOAuth() {
    this.assertConfigured();
    const state = randomBytes(32).toString("base64url");
    await this.store.setPendingAuth({
      state,
      expiresAt: this.now() + 10 * 60_000,
    });
    const url = new URL(OAUTH_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: OAUTH_SCOPES.join(" "),
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      state,
    }).toString();
    return url.toString();
  }

  async completeOAuth({ code, state, error }) {
    this.assertConfigured();
    if (error) {
      await this.store.clearPendingAuth();
      throw new ApiError(400, "YOUTUBE_OAUTH_DENIED", "Підключення YouTube було скасовано.");
    }
    const saved = this.store.read();
    const pending = saved.pendingAuth;
    if (
      !pending ||
      pending.expiresAt < this.now() ||
      !safeEqual(pending.state, state) ||
      typeof code !== "string" ||
      !code
    ) {
      await this.store.clearPendingAuth();
      throw new ApiError(400, "YOUTUBE_OAUTH_STATE_INVALID", "Спроба підключення застаріла. Почніть ще раз.");
    }
    await this.store.clearPendingAuth();
    const body = await this.fetchToken({
      grant_type: "authorization_code",
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
    });
    const refreshToken = body.refresh_token || saved.tokens?.refreshToken;
    if (!refreshToken) {
      throw new ApiError(
        502,
        "YOUTUBE_REFRESH_TOKEN_MISSING",
        "Google не повернув довготривалий доступ. Відкличте доступ застосунку й підключіть канал ще раз.",
      );
    }
    await this.store.saveTokens({
      accessToken: body.access_token || "",
      refreshToken,
      expiryDate: this.now() + Math.max(60, Number(body.expires_in) || 3_600) * 1_000,
      scope: body.scope || OAUTH_SCOPES.join(" "),
      tokenType: body.token_type || "Bearer",
    });
    this.runtime = emptyRuntime();
    this.lastPoll = { channel: 0, broadcasts: 0, stream: 0, metrics: 0 };
    try {
      await this.refreshAll();
    } catch {
      // OAuth itself succeeded. Keep the connection and show the API refresh error in the dashboard.
    }
    return this.snapshot();
  }

  async fetchToken(parameters) {
    let response;
    try {
      response = await this.fetchImpl(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(parameters),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError(502, "YOUTUBE_OAUTH_UNAVAILABLE", "Google OAuth тимчасово недоступний.");
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(502, "YOUTUBE_OAUTH_FAILED", "Google не підтвердив підключення каналу.");
    }
    return body;
  }

  async getAccessToken({ force = false } = {}) {
    this.assertConnected();
    const tokens = this.store.read().tokens;
    if (!force && tokens.accessToken && tokens.expiryDate > this.now() + 60_000) {
      return tokens.accessToken;
    }
    if (!this.tokenRefreshPromise) {
      this.tokenRefreshPromise = (async () => {
        const current = this.store.read().tokens;
        const body = await this.fetchToken({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: this.clientId,
          client_secret: this.clientSecret,
        });
        await this.store.saveTokens({
          accessToken: body.access_token || "",
          refreshToken: current.refreshToken,
          expiryDate: this.now() + Math.max(60, Number(body.expires_in) || 3_600) * 1_000,
          scope: body.scope || current.scope,
          tokenType: body.token_type || current.tokenType || "Bearer",
        });
        return body.access_token;
      })().finally(() => {
        this.tokenRefreshPromise = null;
      });
    }
    return this.tokenRefreshPromise;
  }

  async googleApi(resource, parameters, { retry = true, units = 1 } = {}) {
    const token = await this.getAccessToken();
    const url = new URL(`${YOUTUBE_API_ROOT}/${resource}`);
    url.search = new URLSearchParams(
      Object.entries(parameters).filter(([, value]) => value !== null && value !== undefined),
    ).toString();
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError(502, "YOUTUBE_API_UNAVAILABLE", "YouTube API тимчасово недоступний.");
    } finally {
      this.addQuota(units);
    }
    if (response.status === 401 && retry) {
      await this.getAccessToken({ force: true });
      return this.googleApi(resource, parameters, { retry: false, units });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = body?.error?.errors?.[0]?.reason;
      if (reason === "quotaExceeded") {
        throw new ApiError(429, "YOUTUBE_QUOTA_EXCEEDED", "Денну квоту YouTube API вичерпано.");
      }
      if (reason === "liveStreamingNotEnabled") {
        throw new ApiError(403, "YOUTUBE_LIVE_DISABLED", "Для цього каналу не ввімкнені прямі трансляції.");
      }
      if (["insufficientLivePermissions", "insufficientPermissions"].includes(reason)) {
        throw new ApiError(
          403,
          "YOUTUBE_LIVE_PERMISSION_MISSING",
          "YouTube не дозволив читати прямі трансляції цього каналу. Перевірте доступ до live streaming.",
        );
      }
      if (["accessNotConfigured", "serviceDisabled"].includes(reason)) {
        throw new ApiError(
          503,
          "YOUTUBE_API_DISABLED",
          "У Google Cloud потрібно ввімкнути YouTube Data API v3 для цього OAuth-проєкту.",
        );
      }
      if (reason === "invalidFilters") {
        throw new ApiError(502, "YOUTUBE_INVALID_FILTERS", "Некоректний запит списку трансляцій YouTube.");
      }
      throw new ApiError(502, "YOUTUBE_API_FAILED", "YouTube API не зміг оновити дані каналу.");
    }
    return body;
  }

  async refreshChannel() {
    const body = await this.googleApi("channels", {
      part: "snippet,statistics",
      mine: "true",
      maxResults: "1",
    });
    const channel = body.items?.[0];
    if (!channel) {
      throw new ApiError(404, "YOUTUBE_CHANNEL_NOT_FOUND", "У підключеному Google-акаунті не знайдено YouTube-канал.");
    }
    this.runtime.channel = {
      id: channel.id,
      title: channel.snippet?.title || "YouTube-канал",
      thumbnailUrl:
        channel.snippet?.thumbnails?.high?.url ||
        channel.snippet?.thumbnails?.medium?.url ||
        channel.snippet?.thumbnails?.default?.url ||
        null,
      subscribers: channel.statistics?.hiddenSubscriberCount
        ? null
        : integer(channel.statistics?.subscriberCount),
      totalViews: integer(channel.statistics?.viewCount),
      videos: integer(channel.statistics?.videoCount),
    };
    this.lastPoll.channel = this.now();
  }

  async refreshBroadcasts() {
    const body = await this.googleApi("liveBroadcasts", {
      part: "id,snippet,status,contentDetails",
      mine: "true",
      broadcastType: "all",
      maxResults: "50",
    });
    const broadcasts = (body.items || [])
      .map(publicBroadcast)
      .filter((item) => !["complete", "revoked"].includes(item.lifeCycleStatus))
      .sort((left, right) => {
        const rank = (item) => (["live", "liveStarting", "testing", "testStarting"].includes(item.lifeCycleStatus) ? 0 : 1);
        return rank(left) - rank(right) || String(left.scheduledStartAt).localeCompare(String(right.scheduledStartAt));
      });
    this.runtime.broadcasts = broadcasts;
    const savedId = this.store.read().selectedBroadcastId;
    const selected = broadcasts.find((item) => item.id === savedId) || broadcasts[0] || null;
    this.runtime.selected = selected;
    if (selected?.id !== savedId) await this.store.setSelectedBroadcast(selected?.id ?? null);
    this.lastPoll.broadcasts = this.now();
  }

  async refreshStream() {
    const streamId = this.runtime.selected?.boundStreamId;
    if (!streamId) {
      this.runtime.stream = null;
      this.ingestion = null;
      this.lastPoll.stream = this.now();
      return;
    }
    const body = await this.googleApi("liveStreams", {
      part: "id,snippet,cdn,status",
      id: streamId,
      maxResults: "1",
    });
    const stream = body.items?.[0];
    if (!stream) {
      this.runtime.stream = null;
      this.ingestion = null;
      this.lastPoll.stream = this.now();
      return;
    }
    const health = stream.status?.healthStatus;
    this.runtime.stream = {
      id: stream.id,
      title: stream.snippet?.title || "YouTube stream",
      streamStatus: stream.status?.streamStatus || "unknown",
      healthStatus: health?.status || "noData",
      lastHealthUpdateAt: health?.lastUpdateTimeSeconds
        ? new Date(Number(health.lastUpdateTimeSeconds) * 1_000).toISOString()
        : null,
      configurationIssues: (health?.configurationIssues || []).map(cleanIssue),
      resolution: stream.cdn?.resolution || null,
      frameRate: stream.cdn?.frameRate || null,
      ingestionReady: Boolean(
        stream.cdn?.ingestionInfo?.rtmpsIngestionAddress && stream.cdn?.ingestionInfo?.streamName,
      ),
    };
    this.ingestion = this.runtime.stream.ingestionReady
      ? {
          streamUrl: stream.cdn.ingestionInfo.rtmpsIngestionAddress,
          streamKey: stream.cdn.ingestionInfo.streamName,
        }
      : null;
    this.lastPoll.stream = this.now();
  }

  async refreshMetrics() {
    const videoId = this.runtime.selected?.id;
    if (!videoId) {
      this.runtime.metrics = null;
      this.lastPoll.metrics = this.now();
      return;
    }
    const body = await this.googleApi("videos", {
      part: "statistics,liveStreamingDetails",
      id: videoId,
      maxResults: "1",
    });
    const video = body.items?.[0];
    this.runtime.metrics = video
      ? {
          viewers: integer(video.liveStreamingDetails?.concurrentViewers),
          views: integer(video.statistics?.viewCount),
          likes: integer(video.statistics?.likeCount),
          actualStartAt: video.liveStreamingDetails?.actualStartTime || this.runtime.selected?.actualStartAt || null,
          scheduledStartAt: video.liveStreamingDetails?.scheduledStartTime || this.runtime.selected?.scheduledStartAt || null,
        }
      : null;
    this.lastPoll.metrics = this.now();
    if (this.runtime.metrics) {
      await this.statsStore.append({
        capturedAt: new Date(this.now()).toISOString(),
        broadcastId: videoId,
        viewers: this.runtime.metrics.viewers,
        views: this.runtime.metrics.views,
        likes: this.runtime.metrics.likes,
        health: this.runtime.stream?.healthStatus || "noData",
      });
      this.runtime.history = this.statsStore.list({ hours: 24, broadcastId: videoId });
    }
  }

  async runRefresh(tasks) {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      this.assertConnected();
      try {
        for (const task of tasks) await task();
        this.runtime.lastUpdatedAt = new Date(this.now()).toISOString();
        this.runtime.lastError = null;
      } catch (error) {
        this.runtime.lastError = error instanceof Error ? error.message : "Не вдалося оновити YouTube.";
        throw error;
      } finally {
        await this.persistQuota();
      }
      return this.snapshot();
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  refreshAll() {
    return this.runRefresh([
      () => this.refreshChannel(),
      () => this.refreshBroadcasts(),
      () => this.refreshStream(),
      () => this.refreshMetrics(),
    ]);
  }

  refreshDue() {
    if (!this.configured || !this.store.read().tokens) return Promise.resolve(this.snapshot());
    const current = this.now();
    const tasks = [];
    const schedule = (key, task) => {
      if (current - this.lastPoll[key] < POLL_INTERVALS[key]) return;
      this.lastPoll[key] = current;
      tasks.push(task);
    };
    schedule("channel", () => this.refreshChannel());
    schedule("broadcasts", () => this.refreshBroadcasts());
    schedule("stream", () => this.refreshStream());
    schedule("metrics", () => this.refreshMetrics());
    return tasks.length ? this.runRefresh(tasks) : Promise.resolve(this.snapshot());
  }

  async selectBroadcast(broadcastId) {
    this.assertConnected();
    if (typeof broadcastId !== "string" || !broadcastId) {
      throw new ApiError(400, "YOUTUBE_BROADCAST_REQUIRED", "Оберіть трансляцію YouTube.");
    }
    if (!this.runtime.broadcasts.some((item) => item.id === broadcastId)) await this.refreshBroadcasts();
    const selected = this.runtime.broadcasts.find((item) => item.id === broadcastId);
    if (!selected) {
      throw new ApiError(404, "YOUTUBE_BROADCAST_NOT_FOUND", "Трансляцію YouTube не знайдено.");
    }
    await this.store.setSelectedBroadcast(broadcastId);
    this.runtime.selected = selected;
    this.runtime.stream = null;
    this.runtime.metrics = null;
    this.ingestion = null;
    this.lastPoll.stream = 0;
    this.lastPoll.metrics = 0;
    return this.runRefresh([() => this.refreshStream(), () => this.refreshMetrics()]);
  }

  getSelectedIngestion() {
    this.assertConnected();
    if (!this.ingestion) {
      throw new ApiError(
        409,
        "YOUTUBE_INGESTION_UNAVAILABLE",
        "Для вибраної трансляції ще немає готового RTMPS-потоку.",
      );
    }
    return { ...this.ingestion };
  }

  history({ hours = 24 } = {}) {
    const selectedId = this.store?.read().selectedBroadcastId || null;
    return this.statsStore ? this.statsStore.list({ hours, broadcastId: selectedId }) : [];
  }

  async disconnect() {
    this.assertConnected();
    const tokens = this.store.read().tokens;
    const token = tokens.refreshToken || tokens.accessToken;
    if (token) {
      try {
        await this.fetchImpl(OAUTH_REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // Local disconnect must still work if Google is temporarily unavailable.
      }
    }
    await this.store.clearConnection();
    this.runtime = emptyRuntime();
    this.ingestion = null;
    return this.snapshot();
  }

  snapshot() {
    this.resetQuotaIfNeeded();
    const saved = this.store?.read() || {};
    return {
      configured: this.configured,
      connected: Boolean(saved.tokens),
      connectedAt: saved.connectedAt || null,
      scopes: this.configured ? [...OAUTH_SCOPES] : [],
      channel: this.runtime.channel ? { ...this.runtime.channel } : null,
      broadcasts: this.runtime.broadcasts.map((item) => ({ ...item })),
      selected: this.runtime.selected ? { ...this.runtime.selected } : null,
      stream: this.runtime.stream
        ? {
            ...this.runtime.stream,
            configurationIssues: this.runtime.stream.configurationIssues.map((item) => ({ ...item })),
          }
        : null,
      metrics: this.runtime.metrics ? { ...this.runtime.metrics } : null,
      history: this.runtime.history.map((item) => ({ ...item })),
      quota: {
        ...this.quota,
        limit: this.dailyQuota,
        remaining: Math.max(0, this.dailyQuota - this.quota.used),
      },
      lastUpdatedAt: this.runtime.lastUpdatedAt,
      lastError: this.runtime.lastError,
    };
  }
}
