import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TelegramService } from "../media-server/telegram-service.mjs";
import { EncryptedTelegramStore } from "../media-server/telegram-store.mjs";

const SECRET = "streamlab-telegram-test-secret-32-characters";
const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";

test("validates, encrypts and restores a Telegram bot connection", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-telegram-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const service = new TelegramService({
    store: new EncryptedTelegramStore({ rootDir, secret: SECRET }),
    now: () => Date.parse("2026-07-19T12:00:00.000Z"),
    fetchImpl: async (url) => {
      assert.match(url, /\/getMe$/);
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            result: {
              id: 987654321,
              is_bot: true,
              username: "streamlab_bot",
              first_name: "StreamLab",
              last_name: "Alerts",
            },
          };
        },
      };
    },
  });
  await service.init();
  const connected = await service.connect(TOKEN);
  assert.equal(connected.connected, true);
  assert.equal(connected.bot.username, "streamlab_bot");
  assert.equal(connected.bot.displayName, "StreamLab Alerts");
  assert.equal(connected.token, undefined);
  assert.match(connected.tokenMasked, /abcd$/);

  const raw = await readFile(path.join(rootDir, "telegram-bot.enc.json"), "utf8");
  assert.doesNotMatch(raw, new RegExp(TOKEN));

  const restoredStore = new EncryptedTelegramStore({ rootDir, secret: SECRET });
  await restoredStore.init();
  assert.deepEqual(restoredStore.snapshot(), connected);
  assert.equal((await service.disconnect()).connected, false);
});

test("rejects malformed and unconfirmed Telegram bot tokens", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-telegram-invalid-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let requests = 0;
  const service = new TelegramService({
    store: new EncryptedTelegramStore({ rootDir, secret: SECRET }),
    fetchImpl: async () => {
      requests += 1;
      return { ok: false, async json() { return { ok: false }; } };
    },
  });
  await service.init();
  await assert.rejects(() => service.connect("not-a-token"), /@BotFather/);
  assert.equal(requests, 0);
  await assert.rejects(() => service.connect(TOKEN), /не підтвердив/);
  assert.equal(requests, 1);
  assert.equal(service.snapshot().connected, false);
});
