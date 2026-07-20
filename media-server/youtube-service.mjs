import { randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "./api-error.mjs";

const YOUTUBE_API_ROOT = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_ANALYTICS_ROOT = "https://youtubeanalytics.googleapis.com/v2";
const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];
const DEFAULT_POLL_INTERVALS = Object.freeze({
  metrics: 30_000,
  stream: 45_000,
  broadcasts: 60_000,
  channel: 10 * 60_000,
  subscribers: 5 * 60_000,
  analytics: 60 * 60_000,
  dailyReport: 24 * 60 * 60_000,
});

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

function analyticsRows(body) {
  const headers = (body?.columnHeaders || []).map((header) => header.name);
  return (body?.rows || []).map((row) => Object.fromEntries(
    headers.map((header, index) => [header, row[index]]),
  ));
}

function analyticsNumber(row, name) {
  const value = Number(row?.[name]);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function subscriberFromResource(item) {
  const subscriber = item?.subscriberSnippet || {};
  const snippet = item?.snippet || {};
  const channelId = subscriber.channelId || snippet.resourceId?.channelId || "";
  if (typeof item?.id !== "string" || !item.id || !channelId) return null;
  return {
    subscriptionId: item.id,
    subscriberChannelId: channelId,
    subscriberName: subscriber.title || snippet.title || "Невідомий підписник",
    thumbnailUrl:
      subscriber.thumbnails?.high?.url ||
      subscriber.thumbnails?.medium?.url ||
      subscriber.thumbnails?.default?.url ||
      snippet.thumbnails?.high?.url ||
      snippet.thumbnails?.default?.url ||
      null,
    subscribedAt: snippet.publishedAt || null,
    telegramSentAt: null,
  };
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join("|") : String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function emptyRuntime() {
  return {
    channel: null,
    broadcasts: [],
    selected: null,
    stream: null,
    metrics: null,
    analytics: null,
    analyticsHistory: [],
    dailyReport: null,
    history: [],
    recentSubscribers: [],
    videoStats: [],
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
    onUpdate = () => {},
    onSubscriber = () => {},
    getPlaybackSnapshot = () => null,
    pollIntervals = {},
    logger = console,
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
    this.onUpdate = onUpdate;
    this.onSubscriber = onSubscriber;
    this.getPlaybackSnapshot = getPlaybackSnapshot;
    this.pollIntervals = { ...DEFAULT_POLL_INTERVALS, ...pollIntervals };
    this.logger = logger;
    this.runtime = emptyRuntime();
    this.quota = { date: quotaDate(this.now()), used: 0, updatedAt: null };
    this.lastPoll = { channel: 0, broadcasts: 0, stream: 0, metrics: 0, subscribers: 0, analytics: 0, dailyReport: 0 };
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
    if (saved.runtimeCache) {
      this.runtime = {
        ...emptyRuntime(),
        ...structuredClone(saved.runtimeCache),
        history: [],
      };
    }
    this.runtime.history = this.statsStore.list({
      hours: 24,
      broadcastId: saved.selectedBroadcastId,
      referenceTime: this.now(),
    });
    this.runtime.recentSubscribers = this.statsStore.listSubscribers();
    this.runtime.analyticsHistory = this.statsStore.listAnalyticsHistory();
    this.runtime.videoStats = this.statsStore.videoStatistics({
      hours: 24,
      broadcastId: saved.selectedBroadcastId,
      referenceTime: this.now(),
    });
    return this.snapshot();
  }

  start() {
    if (!this.configured || this.pollTimer) return;
    void this.refreshDue().catch((error) => this.logger.error("StreamLab YouTube polling failed.", error));
    this.pollTimer = setInterval(() => {
      void this.refreshDue().catch((error) => this.logger.error("StreamLab YouTube polling failed.", error));
    }, 5_000);
    this.pollTimer.unref?.();
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

  async persistRuntimeCache() {
    await this.store?.setRuntimeCache?.({
      channel: this.runtime.channel,
      broadcasts: this.runtime.broadcasts,
      selected: this.runtime.selected,
      stream: this.runtime.stream,
      metrics: this.runtime.metrics,
      analytics: this.runtime.analytics,
      analyticsHistory: this.runtime.analyticsHistory,
      dailyReport: this.runtime.dailyReport,
      lastUpdatedAt: this.runtime.lastUpdatedAt,
      lastError: this.runtime.lastError,
    });
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
    await this.store.setRuntimeCache(null);
    this.lastPoll = { channel: 0, broadcasts: 0, stream: 0, metrics: 0, subscribers: 0, analytics: 0, dailyReport: 0 };
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

  async googleApi(resource, parameters, { retry = true, units = 1, root = YOUTUBE_API_ROOT } = {}) {
    const token = await this.getAccessToken();
    const url = new URL(`${root}/${resource}`);
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
      return this.googleApi(resource, parameters, { retry: false, units, root });
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
      const playback = this.getPlaybackSnapshot?.() || {};
      const output = playback.outputMetrics || {};
      await this.statsStore.append({
        capturedAt: new Date(this.now()).toISOString(),
        broadcastId: videoId,
        viewers: this.runtime.metrics.viewers,
        views: this.runtime.metrics.views,
        likes: this.runtime.metrics.likes,
        health: this.runtime.stream?.healthStatus || "noData",
        subscriberCount: this.runtime.channel?.subscribers ?? null,
        videoId: playback.videoId || null,
        videoName: playback.videoName || null,
        queueItemId: playback.queueItemId || null,
        positionMs: playback.positionMs || 0,
        bitrateKbps: output.bitrateKbps ?? playback.videoBitrateKbps ?? 0,
        fps: output.fps ?? 0,
        droppedFrames: output.droppedFrames ?? 0,
        cpuPercent: playback.cpuPercent ?? 0,
        memoryPercent: playback.memoryPercent ?? 0,
        networkOutputBytesPerSecond: playback.networkOutputBytesPerSecond ?? 0,
        promoImpressions: playback.promoImpressions ?? 0,
        streamStatus: playback.status || "STOPPED",
        playbackError: playback.status === "ERROR",
        activePromoIds: playback.activePromoIds || [],
      });
      this.runtime.history = this.statsStore.list({
        hours: 24,
        broadcastId: videoId,
        referenceTime: this.now(),
      });
      this.runtime.videoStats = this.statsStore.videoStatistics({
        hours: 24,
        broadcastId: videoId,
        referenceTime: this.now(),
      });
    }
  }

  hasAnalyticsScope() {
    const scope = this.store?.read().tokens?.scope || "";
    return scope.split(/\s+/).includes("https://www.googleapis.com/auth/yt-analytics.readonly");
  }

  hasMonetaryAnalyticsScope() {
    const scope = this.store?.read().tokens?.scope || "";
    return scope.split(/\s+/).includes("https://www.googleapis.com/auth/yt-analytics-monetary.readonly");
  }

  async refreshSubscribers() {
    const body = await this.googleApi("subscriptions", {
      part: "id,snippet,subscriberSnippet",
      myRecentSubscribers: "true",
      maxResults: "50",
    });
    const subscribers = (body.items || []).map(subscriberFromResource).filter(Boolean);
    const result = await this.statsStore.mergeSubscribers(subscribers, {
      detectedAt: new Date(this.now()).toISOString(),
    });
    this.runtime.recentSubscribers = result.subscribers;
    this.lastPoll.subscribers = this.now();
    for (const subscriber of result.added) await this.onSubscriber(subscriber);
  }

  async refreshAnalytics() {
    this.lastPoll.analytics = this.now();
    if (!this.hasAnalyticsScope()) {
      this.runtime.analytics = {
        available: false,
        reconnectRequired: true,
        updatedAt: null,
      };
      return;
    }
    const endDate = new Date(this.now()).toISOString().slice(0, 10);
    const startDate = new Date(this.now() - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const coreMetrics = "views,estimatedMinutesWatched,averageViewDuration,likes,subscribersGained,subscribersLost";
    const summaryBody = await this.googleApi("reports", {
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: coreMetrics,
    }, { root: YOUTUBE_ANALYTICS_ROOT });
    const summary = analyticsRows(summaryBody)[0] || {};
    const dailyBody = await this.googleApi("reports", {
      ids: "channel==MINE",
      startDate,
      endDate,
      metrics: coreMetrics,
      dimensions: "day",
      sort: "day",
    }, { root: YOUTUBE_ANALYTICS_ROOT });
    let averageConcurrentViewers = null;
    let peakConcurrentViewers = null;
    let concurrentAvailable = false;
    let concurrentError = null;
    const broadcastId = this.runtime.selected?.id;
    if (broadcastId) {
      try {
        const concurrentBody = await this.googleApi("reports", {
          ids: "channel==MINE",
          startDate,
          endDate,
          metrics: "averageConcurrentViewers,peakConcurrentViewers",
          filters: `video==${broadcastId}`,
        }, { root: YOUTUBE_ANALYTICS_ROOT });
        const concurrent = analyticsRows(concurrentBody)[0] || {};
        averageConcurrentViewers = analyticsNumber(concurrent, "averageConcurrentViewers");
        peakConcurrentViewers = analyticsNumber(concurrent, "peakConcurrentViewers");
        concurrentAvailable = Boolean(concurrentBody.rows?.length);
      } catch (error) {
        concurrentError = error instanceof Error ? error.message : "Concurrent viewers ще недоступні.";
      }
    }
    let estimatedRevenue = null;
    let revenueAvailable = false;
    let revenueError = null;
    const monetaryScope = this.hasMonetaryAnalyticsScope();
    if (monetaryScope) {
      try {
        const revenueBody = await this.googleApi("reports", {
          ids: "channel==MINE",
          startDate,
          endDate,
          metrics: "estimatedRevenue",
          currency: "USD",
        }, { root: YOUTUBE_ANALYTICS_ROOT });
        const revenue = analyticsRows(revenueBody)[0] || {};
        estimatedRevenue = analyticsNumber(revenue, "estimatedRevenue");
        revenueAvailable = Boolean(revenueBody.rows?.length);
      } catch (error) {
        revenueError = error instanceof Error ? error.message : "Revenue недоступний.";
      }
    }
    const history = analyticsRows(dailyBody).map((row) => ({
      date: row.day,
      views: analyticsNumber(row, "views"),
      estimatedMinutesWatched: analyticsNumber(row, "estimatedMinutesWatched"),
      averageViewDurationSeconds: analyticsNumber(row, "averageViewDuration"),
      likes: analyticsNumber(row, "likes"),
      subscribersGained: analyticsNumber(row, "subscribersGained"),
      subscribersLost: analyticsNumber(row, "subscribersLost"),
      estimatedRevenue: null,
    }));
    this.runtime.analyticsHistory = await this.statsStore.replaceAnalyticsHistory(history);
    this.runtime.analytics = {
      available: true,
      reconnectRequired: false,
      views: analyticsNumber(summary, "views"),
      estimatedMinutesWatched: analyticsNumber(summary, "estimatedMinutesWatched"),
      averageViewDurationSeconds: analyticsNumber(summary, "averageViewDuration"),
      likes: analyticsNumber(summary, "likes"),
      subscribersGained: analyticsNumber(summary, "subscribersGained"),
      subscribersLost: analyticsNumber(summary, "subscribersLost"),
      netSubscribers: analyticsNumber(summary, "subscribersGained") - analyticsNumber(summary, "subscribersLost"),
      averageConcurrentViewers,
      peakConcurrentViewers,
      concurrentAvailable,
      concurrentError,
      estimatedRevenue,
      revenueCurrency: "USD",
      revenueAvailable,
      revenueReconnectRequired: !monetaryScope,
      revenueError,
      periodStart: startDate,
      periodEnd: endDate,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  async refreshDailyReport() {
    this.lastPoll.dailyReport = this.now();
    const broadcastId = this.store?.read().selectedBroadcastId || null;
    const items = this.statsStore?.list({
      hours: 24,
      limit: 10_080,
      broadcastId,
      referenceTime: this.now(),
    }) || [];
    const first = items[0] || null;
    const last = items.at(-1) || null;
    this.runtime.dailyReport = {
      generatedAt: new Date(this.now()).toISOString(),
      broadcastId,
      samples: items.length,
      peakViewers: Math.max(0, ...items.map((item) => item.viewers || 0)),
      viewsDelta: first && last ? Math.max(0, last.views - first.views) : 0,
      likesDelta: first && last ? Math.max(0, last.likes - first.likes) : 0,
    };
  }

  async runRefresh(tasks, { continueOnError = false } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      this.assertConnected();
      const errors = [];
      try {
        for (const task of tasks) {
          try {
            await task();
          } catch (error) {
            errors.push(error);
            if (!continueOnError) throw error;
          }
        }
        this.runtime.lastUpdatedAt = new Date(this.now()).toISOString();
        this.runtime.lastError = errors[0] instanceof Error ? errors[0].message : null;
      } catch (error) {
        this.runtime.lastError = error instanceof Error ? error.message : "Не вдалося оновити YouTube.";
        throw error;
      } finally {
        await this.persistQuota();
        await this.persistRuntimeCache();
      }
      const snapshot = this.snapshot();
      await this.onUpdate(snapshot);
      return snapshot;
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
      () => this.refreshSubscribers(),
      () => this.refreshAnalytics(),
      () => this.refreshDailyReport(),
    ]);
  }

  refreshDue() {
    if (!this.configured || !this.store?.read().tokens) return Promise.resolve(this.snapshot());
    const timestamp = this.now();
    const tasks = [];
    const schedule = (key, task) => {
      if (timestamp - (this.lastPoll[key] || 0) < this.pollIntervals[key]) return;
      this.lastPoll[key] = timestamp;
      tasks.push(task);
    };
    schedule("broadcasts", () => this.refreshBroadcasts());
    schedule("stream", () => this.refreshStream());
    schedule("metrics", () => this.refreshMetrics());
    schedule("channel", () => this.refreshChannel());
    schedule("subscribers", () => this.refreshSubscribers());
    schedule("analytics", () => this.refreshAnalytics());
    schedule("dailyReport", () => this.refreshDailyReport());
    if (!tasks.length) return Promise.resolve(this.snapshot());
    return this.runRefresh(tasks, { continueOnError: true });
  }

  async selectBroadcast(broadcastId) {
    this.assertConnected();
    if (typeof broadcastId !== "string" || !broadcastId) {
      throw new ApiError(400, "YOUTUBE_BROADCAST_REQUIRED", "Оберіть трансляцію YouTube.");
    }
    const selected = this.runtime.broadcasts.find((item) => item.id === broadcastId);
    if (!selected) {
      throw new ApiError(404, "YOUTUBE_BROADCAST_NOT_FOUND", "Трансляцію YouTube не знайдено.");
    }
    await this.store.setSelectedBroadcast(broadcastId);
    this.runtime.selected = selected;
    this.runtime.stream = null;
    this.runtime.metrics = null;
    this.runtime.history = this.statsStore.list({
      hours: 24,
      broadcastId,
      referenceTime: this.now(),
    });
    this.runtime.videoStats = this.statsStore.videoStatistics({
      hours: 24,
      broadcastId,
      referenceTime: this.now(),
    });
    this.ingestion = null;
    this.lastPoll.stream = 0;
    this.lastPoll.metrics = 0;
    this.lastPoll.analytics = 0;
    this.runtime.lastUpdatedAt = null;
    await this.persistRuntimeCache();
    return this.snapshot();
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

  history(options = {}) {
    const selectedId = this.store?.read().selectedBroadcastId || null;
    return this.statsStore
      ? this.statsStore.list({ ...options, broadcastId: selectedId, referenceTime: this.now() })
      : [];
  }

  videoStatistics(options = {}) {
    const selectedId = this.store?.read().selectedBroadcastId || null;
    return this.statsStore
      ? this.statsStore.videoStatistics({ ...options, broadcastId: selectedId, referenceTime: this.now() })
      : [];
  }

  subscribers({ limit = 50 } = {}) {
    return this.statsStore ? this.statsStore.listSubscribers({ limit }) : [];
  }

  exportStatistics({ format = "json", ...range } = {}) {
    const data = {
      generatedAt: new Date(this.now()).toISOString(),
      broadcastId: this.store?.read().selectedBroadcastId || null,
      snapshots: this.history({ ...range, limit: 0 }),
      videoStatistics: this.videoStatistics(range),
      recentSubscribers: this.subscribers({ limit: 500 }),
      analytics: this.runtime.analytics ? { ...this.runtime.analytics } : null,
      analyticsHistory: this.statsStore?.listAnalyticsHistory({ days: 366 }) || [],
    };
    if (String(format).toLowerCase() === "json") {
      return {
        contentType: "application/json; charset=utf-8",
        filename: `streamlab-youtube-${new Date(this.now()).toISOString().slice(0, 10)}.json`,
        body: JSON.stringify(data, null, 2),
      };
    }
    const headers = [
      "recordType", "capturedAt", "broadcastId", "videoId", "videoName", "viewers", "views", "likes",
      "subscriberCount", "health", "positionMs", "bitrateKbps", "fps", "droppedFrames", "activePromoIds",
      "cpuPercent", "memoryPercent", "networkOutputBytesPerSecond", "promoImpressions",
      "subscriptionId", "subscriberChannelId", "subscriberName", "subscribedAt", "detectedAt",
      "playCount", "averageStartViewers", "averageEndViewers", "audienceChange", "localPeakViewers",
      "averageWatchIntervalSeconds", "playbackErrors", "date", "estimatedMinutesWatched",
      "averageViewDurationSeconds", "subscribersGained", "subscribersLost", "estimatedRevenue",
    ];
    const rows = [
      ...data.snapshots.map((item) => ({ recordType: "snapshot", ...item })),
      ...data.videoStatistics.map((item) => ({ recordType: "videoStatistics", ...item })),
      ...data.recentSubscribers.map((item) => ({ recordType: "subscriber", ...item })),
      ...data.analyticsHistory.map((item) => ({ recordType: "analytics", ...item })),
    ];
    const body = [
      headers.join(","),
      ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
    ].join("\r\n");
    return {
      contentType: "text/csv; charset=utf-8",
      filename: `streamlab-youtube-${new Date(this.now()).toISOString().slice(0, 10)}.csv`,
      body: `\uFEFF${body}`,
    };
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
      analytics: this.runtime.analytics ? { ...this.runtime.analytics } : null,
      analyticsHistory: this.runtime.analyticsHistory.map((item) => ({ ...item })),
      dailyReport: this.runtime.dailyReport ? { ...this.runtime.dailyReport } : null,
      history: this.runtime.history.map((item) => ({ ...item })),
      recentSubscribers: this.runtime.recentSubscribers.map((item) => ({ ...item })),
      videoStats: this.runtime.videoStats.map((item) => ({ ...item })),
      quota: {
        ...this.quota,
        limit: this.dailyQuota,
        remaining: Math.max(0, this.dailyQuota - this.quota.used),
      },
      polling: {
        automatic: true,
        metricsSeconds: Math.round(this.pollIntervals.metrics / 1_000),
        streamSeconds: Math.round(this.pollIntervals.stream / 1_000),
        broadcastSeconds: Math.round(this.pollIntervals.broadcasts / 1_000),
        subscribersMinutes: Math.round(this.pollIntervals.channel / 60_000),
        recentSubscribersMinutes: Math.round(this.pollIntervals.subscribers / 60_000),
        analyticsMinutes: Math.round(this.pollIntervals.analytics / 60_000),
        dailyReportHours: Math.round(this.pollIntervals.dailyReport / 3_600_000),
        estimatedDailyUnits:
          Math.round(86_400_000 / this.pollIntervals.metrics) +
          Math.round(86_400_000 / this.pollIntervals.stream) +
          Math.round(86_400_000 / this.pollIntervals.broadcasts) +
          Math.round(86_400_000 / this.pollIntervals.channel) +
          Math.round(86_400_000 / this.pollIntervals.subscribers),
      },
      lastUpdatedAt: this.runtime.lastUpdatedAt,
      lastError: this.runtime.lastError,
    };
  }
}
