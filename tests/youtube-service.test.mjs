import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { YouTubeService } from "../media-server/youtube-service.mjs";
import { EncryptedYouTubeStore, YouTubeStatsStore } from "../media-server/youtube-store.mjs";

function googleFixtureFetch(calls) {
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
  const service = new YouTubeService({
    clientId: "client-id.apps.googleusercontent.com",
    clientSecret: "oauth-client-secret",
    redirectUri: "https://stream.example.test/api/youtube/oauth/callback",
    store,
    statsStore,
    fetchImpl: googleFixtureFetch(calls),
    now: () => currentTime,
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
  assert.equal(synchronized.quota.used, 4);
  assert.doesNotMatch(JSON.stringify(snapshot), /youtube-access-token|youtube-refresh-token|secret-stream-key/);
  assert.deepEqual(service.getSelectedIngestion(), {
    streamUrl: "rtmps://a.rtmps.youtube.com/live2",
    streamKey: "secret-stream-key",
  });

  const encrypted = await readFile(path.join(rootDir, "youtube-oauth.enc.json"), "utf8");
  assert.doesNotMatch(encrypted, /youtube-access-token|youtube-refresh-token|oauth-client-secret/);
  const stats = JSON.parse(await readFile(path.join(rootDir, "youtube-stats.json"), "utf8"));
  assert.equal(stats.items[0].viewers, 42);
  assert.doesNotMatch(JSON.stringify(stats), /secret-stream-key/);

  currentTime += 61_000;
  const callsBeforeDue = calls.length;
  await service.refreshDue();
  assert.equal(calls.length, callsBeforeDue + 3);
  assert.equal(service.snapshot().history.length, 2);
  assert.equal(service.snapshot().polling.estimatedDailyUnits, 6_384);
  await service.refreshAll();
  assert.equal(service.snapshot().history.length, 2);
  assert.ok(calls.some((call) => call.url.includes("/videos")));

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
