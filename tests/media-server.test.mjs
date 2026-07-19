import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createOwnerAuth, hashPassword } from "../media-server/auth.mjs";
import { createMvpServer, normalizeServerError } from "../media-server/server.mjs";
import { buildFfmpegArgs } from "../media-server/stream-controller.mjs";

class FakeController {
  constructor() {
    this.state = {
      status: "STOPPED",
      videoId: null,
      videoName: null,
      startedAt: null,
      stoppedAt: null,
      lastError: null,
      logs: [],
    };
  }

  checkFfmpeg() {
    return { available: true, version: "ffmpeg test", message: null };
  }

  snapshot() {
    return { ...this.state };
  }

  async start({ video }) {
    this.state = {
      ...this.state,
      status: "LIVE",
      videoId: video.id,
      videoName: video.name,
      startedAt: new Date().toISOString(),
    };
    return this.snapshot();
  }

  async stop() {
    this.state = { ...this.state, status: "STOPPED", stoppedAt: new Date().toISOString() };
    return this.snapshot();
  }
}

const TEST_PASSWORD = "correct-horse-battery-staple";
const TEST_PASSWORD_HASH = hashPassword(TEST_PASSWORD, "streamlab-test-salt");

function testAuth() {
  return createOwnerAuth({
    username: "owner",
    passwordHash: TEST_PASSWORD_HASH,
    sessionSecret: "streamlab-test-session-secret-32-characters",
  });
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "owner", password: TEST_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  return {
    cookie: response.headers.get("set-cookie").split(";", 1)[0],
    csrfToken: session.csrfToken,
  };
}

test("uploads a video in chunks and starts the selected stream", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-test-"));
  const controller = new FakeController();
  const app = await createMvpServer({ dataDir, controller, auth: testAuth() });
  const address = await app.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const unauthorized = await fetch(`${baseUrl}/api/videos`);
  assert.equal(unauthorized.status, 401);

  const session = await login(baseUrl);
  const createResponse = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({ name: "demo.mp4", size: 6, mimeType: "video/mp4" }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const firstChunk = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/chunks?offset=0`,
    {
      method: "PUT",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
      body: Buffer.from("abc"),
    },
  );
  assert.equal(firstChunk.status, 200);

  const secondChunk = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/chunks?offset=3`,
    {
      method: "PUT",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
      body: Buffer.from("def"),
    },
  );
  assert.equal(secondChunk.status, 200);

  const completeResponse = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/complete`,
    {
      method: "POST",
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
    },
  );
  assert.equal(completeResponse.status, 200);

  const videosResponse = await fetch(`${baseUrl}/api/videos`, {
    headers: { Cookie: session.cookie },
  });
  const videos = await videosResponse.json();
  assert.equal(videos.videos.length, 1);
  assert.equal(videos.videos[0].name, "demo.mp4");

  const startResponse = await fetch(`${baseUrl}/api/stream/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
    body: JSON.stringify({
      videoId: created.upload.id,
      streamUrl: "rtmps://a.rtmps.youtube.com/live2",
      streamKey: "abcd-efgh-ijkl-mnop",
    }),
  });
  assert.equal(startResponse.status, 202);
  const started = await startResponse.json();
  assert.equal(started.stream.status, "LIVE");
  assert.equal(started.stream.videoName, "demo.mp4");
  assert.doesNotMatch(JSON.stringify(started), /abcd-efgh/);
});

test("rejects state-changing requests without a CSRF token", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-auth-test-"));
  const app = await createMvpServer({ dataDir, controller: new FakeController(), auth: testAuth() });
  const address = await app.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const session = await login(baseUrl);
  const response = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: session.cookie },
    body: JSON.stringify({ name: "demo.mp4", size: 6, mimeType: "video/mp4" }),
  });
  assert.equal(response.status, 403);
});

test("builds a fixed 1080p30 CBR FFmpeg command without a shell", () => {
  const args = buildFfmpegArgs({
    inputPath: "C:/media/demo.mp4",
    target: "rtmps://example.test/live/key",
  });
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("10M"));
  assert.ok(args.includes("60"));
  assert.ok(args.includes("flv"));
  assert.equal(args.at(-1), "rtmps://example.test/live/key");
  assert.match(args[args.indexOf("-vf") + 1], /scale=1920:1080/);
});

test("returns actionable storage errors without exposing filesystem details", () => {
  const permissionError = Object.assign(new Error("EACCES: /app/data/uploads/private.part"), {
    code: "EACCES",
  });
  const normalizedPermissionError = normalizeServerError(permissionError);
  assert.equal(normalizedPermissionError.status, 503);
  assert.equal(normalizedPermissionError.code, "STORAGE_UNAVAILABLE");
  assert.doesNotMatch(normalizedPermissionError.message, /\/app\/data/);

  const fullDiskError = normalizeServerError(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  assert.equal(fullDiskError.status, 507);
  assert.equal(fullDiskError.code, "INSUFFICIENT_STORAGE");
});
