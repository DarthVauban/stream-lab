import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { YouTubeService } from "../media-server/youtube-service.mjs";
import { EncryptedYouTubeStore, YouTubeStatsStore } from "../media-server/youtube-store.mjs";

function googleFixtureFetch(calls) {
  let subscriberCalls = 0;
  return async (input, init = {}) => {
    const url = new URL(input.toString());
    calls.push({ url: url.toString(), method: init.method || "GET" });
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
      return Response.json({
        access_token: "youtube-access-token",
        refresh_token: "youtube-refresh-token",
        expires_in: 3_600,
        scope: "https://www.googleapis.com/auth/youtube.readonly",
        token_type: "Bearer",
      });
    }
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/revoke") {
      return new Response(null, { status: 200 });
    }
    if (url.pathname.endsWith("/channels")) {
      return Response.json({
        items: [
          {
            id: "channel-1",
            snippet: {
              title: "StreamLab Channel",
              thumbnails: {
                default: { url: "https://yt3.ggpht.com/channel-default" },
                high: { url: "https://yt3.ggpht.com/channel-high" },
              },
            },
            statistics: { subscriberCount: "1200", viewCount: "45000", videoCount: "31" },
          },
        ],
      });
    }
    if (url.pathname.endsWith("/liveBroadcasts")) {
      assert.equal(url.searchParams.get("mine"), "true");
      assert.equal(url.searchParams.get("broadcastStatus"), null);
      assert.equal(url.searchParams.get("broadcastType"), "all");
      return Response.json({
        items: [
          {
            id: "broadcast-1",
            snippet: {
              title: "24/7 live",
              scheduledStartTime: "2026-07-19T10:00:00.000Z",
              actualStartTime: "2026-07-19T10:02:00.000Z",
              liveChatId: "chat-1",
            },
            status: { lifeCycleStatus: "live", privacyStatus: "public" },
            contentDetails: { boundStreamId: "stream-1" },
          },
        ],
      });
    }
    if (url.pathname.endsWith("/liveStreams")) {
      return Response.json({
        items: [
          {
            id: "stream-1",
            snippet: { title: "Primary stream" },
            cdn: {
              resolution: "1080p",
              frameRate: "30fps",
              ingestionInfo: {
                rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2",
                streamName: "secret-stream-key",
              },
            },
            status: {
              streamStatus: "active",
              healthStatus: { status: "good", configurationIssues: [] },
            },
          },
        ],
      });
    }
    if (url.pathname.endsWith("/videos")) {
      return Response.json({
        items: [
          {
            statistics: { viewCount: "901", likeCount: "77" },
            liveStreamingDetails: { concurrentViewers: "42" },
          },
        ],
      });
    }
    if (url.pathname.endsWith("/subscriptions")) {
      subscriberCalls += 1;
      assert.equal(url.searchParams.get("myRecentSubscribers"), "true");
      const subscribers = [
        {
          id: "subscription-1",
          snippet: { publishedAt: "2026-07-19T11:45:00.000Z" },
          subscriberSnippet: {
            channelId: "subscriber-channel-1",
            title: "First Listener",
            thumbnails: { default: { url: "https://yt3.ggpht.com/subscriber-1" } },
          },
        },
      ];
      if (subscriberCalls > 1) {
        subscribers.unshift({
          id: "subscription-2",
          snippet: { publishedAt: "2026-07-19T12:03:00.000Z" },
          subscriberSnippet: {
            channelId: "subscriber-channel-2",
            title: "Second Listener",
          },
        });
      }
      return Response.json({ items: subscribers });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

test("connects YouTube, hides credentials and records live snapshots", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-youtube-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const calls = [];
  let currentTime = new Date("2026-07-19T12:00:00.000Z").getTime();
  const store = new EncryptedYouTubeStore({
    rootDir,
    secret: "streamlab-youtube-test-secret-32-characters",
  });
  const statsStore = new YouTubeStatsStore({ rootDir });
  const detectedSubscribers = [];
  const service = new YouTubeService({
    clientId: "client-id.apps.googleusercontent.com",
    clientSecret: "oauth-client-secret",
    redirectUri: "https://stream.example.test/api/youtube/oauth/callback",
    store,
    statsStore,
    fetchImpl: googleFixtureFetch(calls),
    now: () => currentTime,
    onSubscriber: async (subscriber) => detectedSubscribers.push(subscriber),
    getPlaybackSnapshot: () => ({
      status: "LIVE",
      videoId: "local-video-1",
      videoName: "Local loop",
      queueItemId: "queue-1",
      positionMs: 30_000,
      videoBitrateKbps: 8_000,
      outputMetrics: { bitrateKbps: 7_950, fps: 30, droppedFrames: 0 },
      activePromoIds: ["promo-1"],
      cpuPercent: 27.5,
      memoryPercent: 63.2,
      networkOutputBytesPerSecond: 1_024_000,
      promoImpressions: 9,
    }),
  });
  await service.init();

  const authorizationUrl = new URL(await service.beginOAuth());
  assert.equal(authorizationUrl.hostname, "accounts.google.com");
  assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
  assert.ok(authorizationUrl.searchParams.get("state"));
  assert.doesNotMatch(authorizationUrl.toString(), /oauth-client-secret/);

  const snapshot = await service.completeOAuth({
    code: "authorization-code",
    state: authorizationUrl.searchParams.get("state"),
  });
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.channel, null);
  assert.equal(snapshot.quota.used, 0);
  assert.equal(calls.filter((call) => call.url.includes("googleapis.com/youtube")).length, 0);

  const synchronized = await service.refreshAll();
  assert.equal(synchronized.channel.title, "StreamLab Channel");
  assert.equal(synchronized.channel.thumbnailUrl, "https://yt3.ggpht.com/channel-high");
  assert.equal(synchronized.selected.id, "broadcast-1");
  assert.equal(synchronized.stream.healthStatus, "good");
  assert.equal(synchronized.metrics.viewers, 42);
  assert.equal(synchronized.history.length, 1);
  assert.equal(synchronized.recentSubscribers.length, 1);
  assert.equal(synchronized.recentSubscribers[0].subscriberName, "First Listener");
  assert.equal(synchronized.videoStats[0].videoId, "local-video-1");
  assert.equal(synchronized.quota.used, 5);
  assert.deepEqual(detectedSubscribers, []);
  assert.doesNotMatch(JSON.stringify(snapshot), /youtube-access-token|youtube-refresh-token|secret-stream-key/);
  assert.deepEqual(service.getSelectedIngestion(), {
    streamUrl: "rtmps://a.rtmps.youtube.com/live2",
    streamKey: "secret-stream-key",
  });

  const encrypted = await readFile(path.join(rootDir, "youtube-oauth.enc.json"), "utf8");
  assert.doesNotMatch(encrypted, /youtube-access-token|youtube-refresh-token|oauth-client-secret/);
  const stats = JSON.parse(await readFile(path.join(rootDir, "youtube-stats.json"), "utf8"));
  assert.equal(stats.items[0].viewers, 42);
  assert.equal(stats.items[0].videoId, "local-video-1");
  assert.deepEqual(stats.items[0].activePromoIds, ["promo-1"]);
  assert.equal(stats.items[0].cpuPercent, 27.5);
  assert.equal(stats.items[0].memoryPercent, 63.2);
  assert.equal(stats.items[0].networkOutputBytesPerSecond, 1_024_000);
  assert.equal(stats.items[0].promoImpressions, 9);
  assert.equal(stats.subscribers.length, 1);
  assert.doesNotMatch(JSON.stringify(stats), /secret-stream-key/);

  currentTime += 61_000;
  const callsBeforeDue = calls.length;
  await service.refreshDue();
  assert.equal(calls.length, callsBeforeDue + 3);
  assert.equal(service.snapshot().history.length, 2);
  assert.equal(service.snapshot().polling.estimatedDailyUnits, 6_672);
  await service.refreshAll();
  assert.equal(service.snapshot().history.length, 2);
  assert.ok(calls.some((call) => call.url.includes("/videos")));
  assert.equal(service.snapshot().recentSubscribers.length, 2);
  assert.equal(detectedSubscribers.length, 1);
  await service.refreshAll();
  assert.equal(detectedSubscribers.length, 1);

  const disconnected = await service.disconnect();
  assert.equal(disconnected.connected, false);
  assert.ok(calls.some((call) => call.url.includes("/revoke")));
});

test("rejects an expired or mismatched OAuth state", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-youtube-state-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const service = new YouTubeService({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://stream.example.test/api/youtube/oauth/callback",
    store: new EncryptedYouTubeStore({
      rootDir,
      secret: "streamlab-youtube-state-secret-32-characters",
    }),
    statsStore: new YouTubeStatsStore({ rootDir }),
    fetchImpl: async () => {
      throw new Error("OAuth token endpoint must not be called");
    },
  });
  await service.init();
  await service.beginOAuth();
  await assert.rejects(
    service.completeOAuth({ code: "code", state: "wrong-state" }),
    (error) => error.code === "YOUTUBE_OAUTH_STATE_INVALID",
  );
});

test("keeps a successful OAuth connection when the first data refresh fails", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-youtube-partial-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const service = new YouTubeService({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://stream.example.test/api/youtube/oauth/callback",
    store: new EncryptedYouTubeStore({
      rootDir,
      secret: "streamlab-youtube-partial-secret-32-characters",
    }),
    statsStore: new YouTubeStatsStore({ rootDir }),
    fetchImpl: async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === "/token") {
        return Response.json({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3_600,
        });
      }
      if (url.pathname.endsWith("/channels")) {
        return Response.json({
          items: [{ id: "channel-1", snippet: { title: "Connected channel" }, statistics: {} }],
        });
      }
      if (url.pathname.endsWith("/liveBroadcasts")) {
        return Response.json(
          { error: { errors: [{ reason: "invalidFilters" }] } },
          { status: 400 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  await service.init();
  const authorizationUrl = new URL(await service.beginOAuth());
  const snapshot = await service.completeOAuth({
    code: "authorization-code",
    state: authorizationUrl.searchParams.get("state"),
  });

  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.channel, null);
  assert.equal(snapshot.lastError, null);
  await assert.rejects(
    service.refreshAll(),
    (error) => error.code === "YOUTUBE_INVALID_FILTERS",
  );
  assert.equal(service.snapshot().channel.title, "Connected channel");
  assert.equal(service.snapshot().lastError, "Некоректний запит списку трансляцій YouTube.");
});

test("collects all required Analytics metrics and exports statistics", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-youtube-analytics-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new EncryptedYouTubeStore({
    rootDir,
    secret: "streamlab-youtube-analytics-secret-32-characters",
  });
  const service = new YouTubeService({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://stream.example.test/api/youtube/oauth/callback",
    store,
    statsStore: new YouTubeStatsStore({ rootDir }),
    now: () => new Date("2026-07-20T12:00:00.000Z").getTime(),
    getPlaybackSnapshot: () => ({
      status: "LIVE",
      videoId: "local-video-a",
      videoName: "Ambient A",
      queueItemId: "queue-a",
      positionMs: 60_000,
      outputMetrics: { bitrateKbps: 8_050, fps: 30, droppedFrames: 1 },
      activePromoIds: ["promo-a"],
    }),
    fetchImpl: async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/channels")) {
        return Response.json({
          items: [{ id: "channel-a", snippet: { title: "Analytics channel" }, statistics: { subscriberCount: "150" } }],
        });
      }
      if (url.pathname.endsWith("/liveBroadcasts")) {
        return Response.json({
          items: [{
            id: "broadcast-a",
            snippet: { title: "Live A" },
            status: { lifeCycleStatus: "live", privacyStatus: "public" },
            contentDetails: { boundStreamId: "stream-a" },
          }],
        });
      }
      if (url.pathname.endsWith("/liveStreams")) {
        return Response.json({
          items: [{ id: "stream-a", snippet: {}, cdn: {}, status: { healthStatus: { status: "good" } } }],
        });
      }
      if (url.pathname.endsWith("/videos")) {
        return Response.json({
          items: [{ statistics: { viewCount: "500", likeCount: "40" }, liveStreamingDetails: { concurrentViewers: "25" } }],
        });
      }
      if (url.pathname.endsWith("/subscriptions")) return Response.json({ items: [] });
      if (url.hostname === "youtubeanalytics.googleapis.com") {
        const metrics = url.searchParams.get("metrics");
        if (metrics === "averageConcurrentViewers,peakConcurrentViewers") {
          assert.equal(url.searchParams.get("filters"), "video==broadcast-a");
          return Response.json({
            columnHeaders: [{ name: "averageConcurrentViewers" }, { name: "peakConcurrentViewers" }],
            rows: [[18, 37]],
          });
        }
        if (metrics === "estimatedRevenue") {
          return Response.json({ columnHeaders: [{ name: "estimatedRevenue" }], rows: [[12.34]] });
        }
        const headers = [
          "views", "estimatedMinutesWatched", "averageViewDuration", "likes", "subscribersGained", "subscribersLost",
        ];
        if (url.searchParams.get("dimensions") === "day") {
          return Response.json({
            columnHeaders: [{ name: "day" }, ...headers.map((name) => ({ name }))],
            rows: [
              ["2026-07-19", 80, 600, 210, 7, 4, 1],
              ["2026-07-20", 120, 900, 240, 11, 6, 2],
            ],
          });
        }
        return Response.json({
          columnHeaders: headers.map((name) => ({ name })),
          rows: [[200, 1_500, 225, 18, 10, 3]],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  await service.init();
  await store.saveTokens({
    accessToken: "analytics-access-token",
    refreshToken: "analytics-refresh-token",
    expiryDate: new Date("2026-07-20T13:00:00.000Z").getTime(),
    scope: [
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
      "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
    ].join(" "),
    tokenType: "Bearer",
  });

  const snapshot = await service.refreshAll();
  assert.equal(snapshot.analytics.views, 200);
  assert.equal(snapshot.analytics.estimatedMinutesWatched, 1_500);
  assert.equal(snapshot.analytics.averageViewDurationSeconds, 225);
  assert.equal(snapshot.analytics.subscribersGained, 10);
  assert.equal(snapshot.analytics.subscribersLost, 3);
  assert.equal(snapshot.analytics.netSubscribers, 7);
  assert.equal(snapshot.analytics.averageConcurrentViewers, 18);
  assert.equal(snapshot.analytics.peakConcurrentViewers, 37);
  assert.equal(snapshot.analytics.estimatedRevenue, 12.34);
  assert.equal(snapshot.analyticsHistory.length, 2);
  assert.equal(snapshot.videoStats[0].officialYouTubeMetric, false);

  const jsonExport = service.exportStatistics({ format: "json", all: true });
  const exported = JSON.parse(jsonExport.body);
  assert.equal(exported.analytics.peakConcurrentViewers, 37);
  assert.equal(exported.videoStatistics[0].videoName, "Ambient A");
  const csvExport = service.exportStatistics({ format: "csv", all: true });
  assert.match(csvExport.body, /recordType,capturedAt/);
  assert.match(csvExport.body, /videoStatistics/);
  assert.match(csvExport.body, /analytics/);
});

test("aggregates local video playback sessions from YouTube snapshots", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-youtube-video-stats-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new YouTubeStatsStore({ rootDir });
  await store.init();
  const base = new Date().getTime() - 10 * 60_000;
  const append = (seconds, input) => store.append({
    capturedAt: new Date(base + seconds * 1_000).toISOString(),
    broadcastId: "broadcast-1",
    views: 100,
    likes: 10,
    health: "good",
    ...input,
  });
  await append(0, { videoId: "video-a", videoName: "A", queueItemId: "q1", viewers: 10, positionMs: 0 });
  await append(60, { videoId: "video-a", videoName: "A", queueItemId: "q1", viewers: 14, positionMs: 60_000, activePromoIds: ["promo-1"] });
  await append(120, { videoId: "video-b", videoName: "B", queueItemId: "q2", viewers: 12, positionMs: 0 });
  await append(180, { videoId: "video-a", videoName: "A", queueItemId: "q3", viewers: 16, positionMs: 0, playbackError: true });
  const stats = store.videoStatistics({ all: true });
  const videoA = stats.find((item) => item.videoId === "video-a");
  assert.equal(videoA.playCount, 2);
  assert.equal(videoA.averageStartViewers, 13);
  assert.equal(videoA.averageEndViewers, 15);
  assert.equal(videoA.audienceChange, 2);
  assert.equal(videoA.localPeakViewers, 16);
  assert.deepEqual(videoA.promoIds, ["promo-1"]);
  assert.equal(videoA.playbackErrors, 1);
});
