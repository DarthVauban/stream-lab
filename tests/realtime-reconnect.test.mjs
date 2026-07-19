import assert from "node:assert/strict";
import test from "node:test";
import { RealtimeHub } from "../media-server/realtime-hub.mjs";

test("replays realtime events that were missed during a reconnect", async () => {
  const hub = new RealtimeHub({ redisUrl: "", maxHistory: 10 });
  const first = await hub.publish("QUEUE_UPDATED", { version: 1 });
  const second = await hub.publish("STREAM_UPDATED", { version: 2 });
  const third = await hub.publish("PROMO_UPDATED", { version: 3 });

  assert.deepEqual(hub.replaySince(first.id).map((event) => event.id), [second.id, third.id]);
  assert.deepEqual(hub.replaySince(third.id), []);
});

test("requests a fresh snapshot when the reconnect cursor is no longer retained", async () => {
  const hub = new RealtimeHub({ redisUrl: "", maxHistory: 10 });
  for (let index = 0; index < 12; index += 1) {
    await hub.publish("SYSTEM_METRICS", { index });
  }

  assert.equal(hub.replaySince("missing-event-id"), null);
  assert.equal(hub.history.length, 10);
});
