import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TelegramService } from "../media-server/telegram-service.mjs";
import { EncryptedTelegramStore } from "../media-server/telegram-store.mjs";

const SECRET = "streamlab-telegram-test-secret-32-characters";
const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
const SETTINGS = {
  webhookUrl: "https://stream.example.test/api/telegram/webhook",
  allowedUserIds: ["111"],
  allowedChatIds: ["111"],
};

function telegramFetch(calls) {
  return async (url, init) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: method === "getMe"
            ? {
                id: 987654321,
                is_bot: true,
                username: "streamlab_bot",
                first_name: "StreamLab",
                last_name: "Alerts",
              }
            : true,
        };
      },
    };
  };
}

test("registers an encrypted Telegram webhook and serves the read-only menu", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "streamlab-telegram-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const calls = [];
  const store = new EncryptedTelegramStore({ rootDir, secret: SECRET });
  const service = new TelegramService({
    store,
    now: () => Date.parse("2026-07-19T12:00:00.000Z"),
    fetchImpl: telegramFetch(calls),
    getDashboardSnapshot: async () => ({
      stream: { status: "LIVE", videoName: "Test video", startedAt: "2026-07-19T11:00:00.000Z" },
      queue: { items: [] },
      youtube: { metrics: { viewers: 12, views: 100, likes: 8 }, history: [] },
      monitoring: { current: { bitrateKbps: 8_000, fps: 30 }, session: { peakViewers: 14 } },
    }),
  });
  await service.init();
  const connected = await service.connect({ token: TOKEN, ...SETTINGS });
  assert.equal(connected.connected, true);
  assert.equal(connected.bot.username, "streamlab_bot");
  assert.equal(connected.bot.displayName, "StreamLab Alerts");
  assert.equal(connected.token, undefined);
  assert.equal(connected.webhook.url, SETTINGS.webhookUrl);
  assert.deepEqual(connected.webhook.allowedUserIds, ["111"]);
  assert.equal(connected.webhook.lastUpdateId, null);

  const registration = calls.find((call) => call.method === "setWebhook");
  assert.equal(registration.body.url, SETTINGS.webhookUrl);
  assert.match(registration.body.secret_token, /^[A-Za-z0-9_-]{32,128}$/);
  assert.deepEqual(registration.body.allowed_updates, ["message", "callback_query"]);
  assert.equal(registration.body.max_connections, 1);

  const connection = store.readConnection();
  assert.equal(connected.webhook.secret, undefined);
  const raw = await readFile(path.join(rootDir, "telegram-bot.enc.json"), "utf8");
  assert.doesNotMatch(raw, new RegExp(TOKEN));
  assert.doesNotMatch(raw, new RegExp(connection.webhook.secret));

  const update = {
    update_id: 1,
    message: { message_id: 1, from: { id: 111 }, chat: { id: 111 }, text: "/start" },
  };
  const handled = await service.handleWebhook(connection.webhook.secret, update);
  assert.equal(handled.authorized, true);
  assert.equal(handled.command, "menu");
  const reply = calls.find((call) => call.method === "sendMessage");
  assert.equal(reply.body.chat_id, "111");
  assert.match(reply.body.text, /режимі перегляду/);
  assert.equal(reply.body.reply_markup.inline_keyboard.length, 4);

  const callCount = calls.length;
  const duplicate = await service.handleWebhook(connection.webhook.secret, update);
  assert.equal(duplicate.duplicate, true);
  assert.equal(calls.length, callCount);

  const unauthorized = await service.handleWebhook(connection.webhook.secret, {
    update_id: 2,
    message: { message_id: 2, from: { id: 999 }, chat: { id: 111 }, text: "/stats" },
  });
  assert.equal(unauthorized.authorized, false);
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 1);

  const callback = await service.handleWebhook(connection.webhook.secret, {
    update_id: 3,
    callback_query: {
      id: "callback-1",
      from: { id: 111 },
      data: "stats_now",
      message: { message_id: 1, chat: { id: 111 } },
    },
  });
  assert.equal(callback.command, "stats_now");
  assert.equal(calls.filter((call) => call.method === "answerCallbackQuery").length, 1);
  assert.match(calls.filter((call) => call.method === "sendMessage").at(-1).body.text, /12/);
  assert.equal(service.snapshot().webhook.lastUpdateId, 3);

  const configured = await service.configure({
    webhookUrl: "https://stream.example.test/api/telegram/updated",
    allowedUserIds: "111, 222",
    allowedChatIds: "111, -100123",
  });
  assert.deepEqual(configured.webhook.allowedUserIds, ["111", "222"]);
  assert.deepEqual(configured.webhook.allowedChatIds, ["111", "-100123"]);

  const restoredStore = new EncryptedTelegramStore({ rootDir, secret: SECRET });
  await restoredStore.init();
  assert.deepEqual(restoredStore.snapshot(), configured);
  assert.equal((await service.disconnect()).connected, false);
  assert.equal(calls.at(-1).method, "deleteWebhook");
});

test("rejects malformed settings, bad secrets and unconfirmed bot tokens", async (t) => {
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
  await assert.rejects(() => service.connect({ token: "not-a-token", ...SETTINGS }), /@BotFather/);
  await assert.rejects(() => service.connect({ token: TOKEN, ...SETTINGS, webhookUrl: "http://unsafe.test" }), /HTTPS/);
  await assert.rejects(() => service.connect({ token: TOKEN, ...SETTINGS, allowedUserIds: [] }), /user ID/);
  assert.equal(requests, 0);
  await assert.rejects(() => service.connect({ token: TOKEN, ...SETTINGS }), /не підтвердив/);
  assert.equal(requests, 1);
  assert.equal(service.snapshot().connected, false);
});
