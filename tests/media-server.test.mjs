import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMvpServer } from "../media-server/server.mjs";
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

test("uploads a video in chunks and starts the selected stream", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "streamlab-test-"));
  const controller = new FakeController();
  const app = await createMvpServer({ dataDir, controller });
  const address = await app.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const createResponse = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "demo.mp4", size: 6, mimeType: "video/mp4" }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const firstChunk = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/chunks?offset=0`,
    { method: "PUT", body: Buffer.from("abc") },
  );
  assert.equal(firstChunk.status, 200);

  const secondChunk = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/chunks?offset=3`,
    { method: "PUT", body: Buffer.from("def") },
  );
  assert.equal(secondChunk.status, 200);

  const completeResponse = await fetch(
    `${baseUrl}/api/uploads/${created.upload.id}/complete`,
    { method: "POST" },
  );
  assert.equal(completeResponse.status, 200);

  const videosResponse = await fetch(`${baseUrl}/api/videos`);
  const videos = await videosResponse.json();
  assert.equal(videos.videos.length, 1);
  assert.equal(videos.videos[0].name, "demo.mp4");

  const startResponse = await fetch(`${baseUrl}/api/stream/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

