import { randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "./api-error.mjs";

const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const USER_ID_PATTERN = /^\d{1,20}$/;
const CHAT_ID_PATTERN = /^-?\d{1,20}$/;
const ALLOWED_UPDATES = ["message", "callback_query"];
const MAX_COMMANDS_PER_MINUTE = 20;

function normalizeIdList(value, pattern, label) {
  const values = Array.isArray(value)
    ? value.map(String)
    : String(value || "").split(/[\s,;]+/);
  const normalized = values.map((item) => item.trim()).filter(Boolean);
  if (normalized.some((item) => !pattern.test(item))) {
    throw new ApiError(400, "INVALID_TELEGRAM_WHITELIST", `Некоректний ${label} у Telegram whitelist.`);
  }
  return [...new Set(normalized)].slice(0, 100);
}

function normalizeWebhookUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new ApiError(400, "INVALID_TELEGRAM_WEBHOOK_URL", "Вкажіть коректний HTTPS URL для Telegram webhook.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ApiError(400, "INVALID_TELEGRAM_WEBHOOK_URL", "Telegram webhook має використовувати чистий HTTPS URL.");
  }
  return url.toString();
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString("uk-UA") : "—";
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const index = Math.min(Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} дн ${hours} год ${minutes} хв`;
  return [hours, minutes, seconds].map((item) => String(item).padStart(2, "0")).join(":");
}

function streamStatusLabel(status) {
  return {
    STOPPED: "⚫ Зупинено",
    STARTING: "🟡 Запускається",
    LIVE: "🟢 В ефірі",
    DEGRADED: "🟠 Нестабільний сигнал",
    RECONNECTING: "🟡 Перепідключення",
    STOPPING: "🟡 Зупиняється",
    ERROR: "🔴 Помилка",
  }[status] || `⚪ ${status || "Невідомо"}`;
}

function healthLabel(status) {
  return {
    good: "🟢 Good",
    ok: "🟡 Є попередження",
    bad: "🔴 Потрібна увага",
    noData: "⚪ Очікуємо сигнал",
  }[status] || "⚪ Немає даних";
}

function menuMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "📊 Статистика зараз", callback_data: "stats_now" },
        { text: "📈 За 24 години", callback_data: "stats_24h" },
      ],
      [
        { text: "🎵 Зараз грає", callback_data: "now_playing" },
        { text: "📋 Поточна черга", callback_data: "queue" },
      ],
      [
        { text: "🖥 Стан сервера", callback_data: "server" },
        { text: "🔴 Стан трансляції", callback_data: "stream" },
      ],
      [{ text: "🔄 Оновити", callback_data: "refresh" }],
    ],
  };
}

function resolveCommand(value, fromCallback = false) {
  if (fromCallback) return String(value || "menu");
  const token = String(value || "").trim().split(/\s+/, 1)[0].toLowerCase().replace(/@[^\s]+$/, "");
  return {
    "/start": "menu",
    "/menu": "menu",
    "/stats": "stats_now",
    "/stats24": "stats_24h",
    "/now": "now_playing",
    "/queue": "queue",
    "/server": "server",
    "/stream": "stream",
    "/refresh": "refresh",
  }[token] || "menu";
}

function statsNowMessage(snapshot) {
  const stream = snapshot.stream || {};
  const youtube = snapshot.youtube || {};
  const monitoring = snapshot.monitoring || {};
  const history = Array.isArray(youtube.history) ? youtube.history : [];
  const peak = Math.max(Number(monitoring.session?.peakViewers) || 0, ...history.map((item) => Number(item.viewers) || 0));
  const uptime = stream.startedAt ? Date.now() - new Date(stream.startedAt).getTime() : 0;
  return [
    "📊 StreamLab · статистика зараз",
    "",
    `🔴 Трансляція: ${streamStatusLabel(stream.status)}`,
    `👥 Глядачі зараз: ${formatNumber(youtube.metrics?.viewers)}`,
    `📈 Пік: ${formatNumber(peak)}`,
    `👁 Перегляди: ${formatNumber(youtube.metrics?.views)}`,
    `👍 Вподобання: ${formatNumber(youtube.metrics?.likes)}`,
    `👤 Підписники каналу: ${formatNumber(youtube.channel?.subscribers)}`,
    "",
    `🎵 Зараз грає: ${stream.videoName || "—"}`,
    `➡️ Наступне: ${stream.nextVideoName || "—"}`,
    `⏱ Позиція: ${formatDuration(stream.positionMs)} / ${formatDuration(stream.durationMs)}`,
    "",
    `📡 Бітрейт: ${formatNumber(monitoring.current?.bitrateKbps)} Кбіт/с`,
    `🎞 FPS: ${formatNumber(monitoring.current?.fps)}`,
    `🛰 YouTube Health: ${healthLabel(youtube.stream?.healthStatus)}`,
    `🕒 Uptime: ${uptime > 0 ? formatDuration(uptime) : "—"}`,
  ].join("\n");
}

function stats24Message(snapshot) {
  const youtube = snapshot.youtube || {};
  const history = Array.isArray(youtube.history) ? youtube.history : [];
  const first = history[0] || {};
  const last = history.at(-1) || {};
  const peak = Math.max(0, ...history.map((item) => Number(item.viewers) || 0));
  const analytics = youtube.analytics || {};
  return [
    "📈 StreamLab · останні 24 години",
    "",
    `👥 Пік глядачів: ${formatNumber(peak)}`,
    `👁 Приріст переглядів: ${formatNumber(Math.max(0, (Number(last.views) || 0) - (Number(first.views) || 0)))}`,
    `👍 Приріст вподобань: ${formatNumber(Math.max(0, (Number(last.likes) || 0) - (Number(first.likes) || 0)))}`,
    `➕ Підписники: ${formatNumber(analytics.subscribersGained)}`,
    `➖ Відписалися: ${formatNumber(analytics.subscribersLost)}`,
    `⏱ Хвилини перегляду: ${formatNumber(analytics.estimatedMinutesWatched)}`,
    `🧾 Знімків статистики: ${formatNumber(history.length)}`,
  ].join("\n");
}

function nowPlayingMessage(snapshot) {
  const stream = snapshot.stream || {};
  return [
    "🎵 Зараз грає",
    "",
    stream.videoName || "Відео не відтворюється.",
    `⏱ ${formatDuration(stream.positionMs)} / ${formatDuration(stream.durationMs)}`,
    stream.remainingMs === null || stream.remainingMs === undefined
      ? "⌛ Залишок: —"
      : `⌛ Залишок: ${formatDuration(stream.remainingMs)}`,
    `➡️ Наступне: ${stream.nextVideoName || "черга порожня"}`,
    stream.isFallback ? "🛟 Активне резервне відео" : "",
  ].filter(Boolean).join("\n");
}

function queueMessage(snapshot) {
  const queue = snapshot.queue?.items || [];
  const currentId = snapshot.stream?.queueItemId;
  if (!queue.length) return "📋 Поточна черга порожня.";
  const rows = queue.slice(0, 12).map((item, index) => {
    const marker = item.id === currentId ? "▶️" : `${index + 1}.`;
    return `${marker} ${item.video?.name || "Відео недоступне"}`;
  });
  if (queue.length > rows.length) rows.push(`…і ще ${queue.length - rows.length}`);
  return ["📋 Поточна черга", "", ...rows].join("\n");
}

function serverMessage(snapshot) {
  const system = snapshot.system || {};
  const database = snapshot.database || {};
  const realtime = snapshot.realtime || {};
  return [
    "🖥 Стан сервера",
    "",
    `CPU: ${formatNumber(system.cpu?.usagePercent)}% · ${formatNumber(system.cpu?.cores)} ядер`,
    `RAM: ${formatNumber(system.memory?.usagePercent)}% · ${formatBytes(system.memory?.usedBytes)} / ${formatBytes(system.memory?.totalBytes)}`,
    `Диск: ${formatNumber(system.disk?.percentUsed)}% · вільно ${formatBytes(system.disk?.freeBytes)}`,
    `Мережа ↓ ${formatBytes(system.network?.receivedBytesPerSecond)}/с · ↑ ${formatBytes(system.network?.transmittedBytesPerSecond)}/с`,
    `PostgreSQL: ${database.connected ? "🟢 доступний" : database.configured ? "🔴 недоступний" : "⚪ файловий режим"}`,
    `Redis realtime: ${realtime.connected ? "🟢 доступний" : realtime.configured ? "🔴 недоступний" : "⚪ локальний режим"}`,
    `Uptime сервера: ${formatDuration((Number(system.system?.uptimeSeconds) || 0) * 1_000)}`,
  ].join("\n");
}

function streamMessage(snapshot) {
  const stream = snapshot.stream || {};
  const monitoring = snapshot.monitoring || {};
  return [
    "🔴 Стан трансляції",
    "",
    streamStatusLabel(stream.status),
    `🎵 Поточне відео: ${stream.videoName || "—"}`,
    `📡 Вихідний бітрейт: ${formatNumber(monitoring.current?.bitrateKbps)} Кбіт/с`,
    `🎞 FPS: ${formatNumber(monitoring.current?.fps)}`,
    `⚠️ Пропущені кадри: ${formatNumber(monitoring.current?.droppedFrames)}`,
    `🔄 RTMPS-відновлення: ${formatNumber(monitoring.session?.restarts)}`,
    stream.lastError ? `❗ ${stream.lastError}` : "✅ Активних локальних помилок немає",
  ].join("\n");
}

function messageForCommand(command, snapshot) {
  if (command === "stats_now" || command === "refresh") return statsNowMessage(snapshot);
  if (command === "stats_24h") return stats24Message(snapshot);
  if (command === "now_playing") return nowPlayingMessage(snapshot);
  if (command === "queue") return queueMessage(snapshot);
  if (command === "server") return serverMessage(snapshot);
  if (command === "stream") return streamMessage(snapshot);
  return [
    "👋 StreamLab Telegram",
    "",
    "Оберіть розділ у меню нижче. На цьому етапі бот працює тільки в режимі перегляду й не може змінювати ефір.",
  ].join("\n");
}

export class TelegramService {
  constructor({
    store,
    fetchImpl = fetch,
    now = () => Date.now(),
    defaultWebhookUrl = process.env.TELEGRAM_WEBHOOK_URL || "",
    defaultAllowedUserIds = process.env.TELEGRAM_ALLOWED_USER_IDS || "",
    defaultAllowedChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS || "",
    getDashboardSnapshot = async () => ({}),
  } = {}) {
    if (!store) throw new Error("Для Telegram не вказано сховище.");
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.defaultWebhookUrl = defaultWebhookUrl;
    this.defaultAllowedUserIds = defaultAllowedUserIds;
    this.defaultAllowedChatIds = defaultAllowedChatIds;
    this.getDashboardSnapshot = getDashboardSnapshot;
    this.inflightUpdates = new Set();
    this.commandWindows = new Map();
  }

  async init() {
    await this.store.init();
    return this.snapshot();
  }

  snapshot() {
    return this.store.snapshot();
  }

  normalizeSettings(input = {}) {
    const webhookUrl = normalizeWebhookUrl(input.webhookUrl || this.defaultWebhookUrl);
    const allowedUserIds = normalizeIdList(
      input.allowedUserIds ?? this.defaultAllowedUserIds,
      USER_ID_PATTERN,
      "Telegram user ID",
    );
    const allowedChatIds = normalizeIdList(
      input.allowedChatIds ?? this.defaultAllowedChatIds,
      CHAT_ID_PATTERN,
      "Telegram chat ID",
    );
    if (!allowedUserIds.length || !allowedChatIds.length) {
      throw new ApiError(
        400,
        "TELEGRAM_WHITELIST_REQUIRED",
        "Додайте щонайменше один дозволений Telegram user ID і chat ID.",
      );
    }
    return { webhookUrl, allowedUserIds, allowedChatIds };
  }

  async telegramRequest(token, method, body = {}, { invalidToken = false } = {}) {
    let response;
    let payload;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      payload = await response.json();
    } catch (error) {
      throw new ApiError(
        502,
        "TELEGRAM_UNAVAILABLE",
        "Telegram тимчасово недоступний. Спробуйте ще раз.",
        { cause: error },
      );
    }
    if (!response.ok || payload?.ok !== true) {
      if (invalidToken) {
        throw new ApiError(400, "INVALID_TELEGRAM_BOT_TOKEN", "Telegram не підтвердив цей bot token. Перевірте значення в @BotFather.");
      }
      throw new ApiError(
        502,
        "TELEGRAM_API_ERROR",
        `Telegram API не виконав ${method}${payload?.description ? `: ${payload.description}` : "."}`,
      );
    }
    return payload.result;
  }

  async connect(input) {
    const values = typeof input === "string" ? { token: input } : input || {};
    const token = typeof values.token === "string" ? values.token.trim() : "";
    if (!TOKEN_PATTERN.test(token)) {
      throw new ApiError(400, "INVALID_TELEGRAM_BOT_TOKEN", "Введіть коректний bot token, отриманий від @BotFather.");
    }
    const settings = this.normalizeSettings(values);
    const bot = await this.telegramRequest(token, "getMe", {}, { invalidToken: true });
    if (bot?.is_bot !== true || !Number.isSafeInteger(bot.id) || bot.id <= 0) {
      throw new ApiError(400, "INVALID_TELEGRAM_BOT_TOKEN", "Telegram не підтвердив цей bot token. Перевірте значення в @BotFather.");
    }

    const secret = randomBytes(32).toString("base64url");
    await this.telegramRequest(token, "setWebhook", {
      url: settings.webhookUrl,
      secret_token: secret,
      allowed_updates: ALLOWED_UPDATES,
      max_connections: 1,
      drop_pending_updates: false,
    });

    const previous = this.store.readConnection();
    if (previous?.token && previous.token !== token) {
      await this.telegramRequest(previous.token, "deleteWebhook", { drop_pending_updates: true }).catch(() => {});
    }
    const connectedAt = new Date(this.now()).toISOString();
    return this.store.saveConnection({
      token,
      botId: bot.id,
      username: typeof bot.username === "string" ? bot.username : null,
      displayName: [bot.first_name, bot.last_name].filter(Boolean).join(" ") || null,
      connectedAt,
      webhook: {
        url: settings.webhookUrl,
        secret,
        allowedUserIds: settings.allowedUserIds,
        allowedChatIds: settings.allowedChatIds,
        registeredAt: connectedAt,
        lastUpdateAt: null,
        lastUpdateId: null,
        lastCommandAt: null,
        lastError: null,
      },
    });
  }

  async configure(input = {}) {
    const connection = this.store.readConnection();
    if (!connection) throw new ApiError(409, "TELEGRAM_NOT_CONNECTED", "Спочатку підключіть Telegram-бота.");
    const settings = this.normalizeSettings(input);
    const secret = connection.webhook?.secret && SECRET_PATTERN.test(connection.webhook.secret)
      ? connection.webhook.secret
      : randomBytes(32).toString("base64url");
    await this.telegramRequest(connection.token, "setWebhook", {
      url: settings.webhookUrl,
      secret_token: secret,
      allowed_updates: ALLOWED_UPDATES,
      max_connections: 1,
      drop_pending_updates: false,
    });
    const registeredAt = new Date(this.now()).toISOString();
    return this.store.saveConnection({
      ...connection,
      webhook: {
        ...connection.webhook,
        url: settings.webhookUrl,
        secret,
        allowedUserIds: settings.allowedUserIds,
        allowedChatIds: settings.allowedChatIds,
        registeredAt,
        lastError: null,
      },
    });
  }

  secretsEqual(received, expected) {
    if (!SECRET_PATTERN.test(expected || "") || typeof received !== "string") return false;
    const receivedBuffer = Buffer.from(received, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
  }

  rateLimited(userId) {
    const timestamp = this.now();
    const window = (this.commandWindows.get(userId) || []).filter((item) => timestamp - item < 60_000);
    if (window.length >= MAX_COMMANDS_PER_MINUTE) {
      this.commandWindows.set(userId, window);
      return true;
    }
    window.push(timestamp);
    this.commandWindows.set(userId, window);
    return false;
  }

  async handleWebhook(secretHeader, update) {
    const connection = this.store.readConnection();
    if (!connection?.webhook) throw new ApiError(409, "TELEGRAM_WEBHOOK_NOT_CONFIGURED", "Telegram webhook не налаштований.");
    if (!this.secretsEqual(secretHeader, connection.webhook.secret)) {
      throw new ApiError(403, "INVALID_TELEGRAM_WEBHOOK_SECRET", "Telegram webhook secret не пройшов перевірку.");
    }
    const updateId = Number(update?.update_id);
    if (!Number.isSafeInteger(updateId) || updateId < 0) {
      throw new ApiError(400, "INVALID_TELEGRAM_UPDATE", "Некоректний Telegram update.");
    }
    if (
      (Number.isSafeInteger(connection.webhook.lastUpdateId) && updateId <= connection.webhook.lastUpdateId) ||
      this.inflightUpdates.has(updateId)
    ) {
      return { accepted: true, duplicate: true, updateId };
    }

    this.inflightUpdates.add(updateId);
    try {
      const callback = update.callback_query || null;
      const message = update.message || callback?.message || null;
      const userId = String((callback?.from || update.message?.from)?.id || "");
      const chatId = String(message?.chat?.id || "");
      const receivedAt = new Date(this.now()).toISOString();
      const authorized = connection.webhook.allowedUserIds.includes(userId) && connection.webhook.allowedChatIds.includes(chatId);
      if (!authorized) {
        await this.store.recordWebhookUpdate({ updateId, receivedAt });
        return { accepted: true, authorized: false, updateId, userId, chatId };
      }

      if (this.rateLimited(userId)) {
        if (callback?.id) {
          await this.telegramRequest(connection.token, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "Забагато команд. Спробуйте за хвилину.",
            show_alert: true,
          });
        }
        await this.store.recordWebhookUpdate({ updateId, receivedAt });
        return { accepted: true, authorized: true, rateLimited: true, updateId, userId, chatId };
      }

      const command = resolveCommand(callback?.data || update.message?.text, Boolean(callback));
      if (callback?.id) {
        await this.telegramRequest(connection.token, "answerCallbackQuery", { callback_query_id: callback.id });
      }
      const snapshot = await this.getDashboardSnapshot();
      await this.telegramRequest(connection.token, "sendMessage", {
        chat_id: chatId,
        text: messageForCommand(command, snapshot),
        reply_markup: menuMarkup(),
        disable_web_page_preview: true,
      });
      await this.store.recordWebhookUpdate({
        updateId,
        receivedAt,
        commandAt: receivedAt,
      });
      return { accepted: true, authorized: true, updateId, userId, chatId, command };
    } catch (error) {
      await this.store.recordWebhookError(error instanceof Error ? error.message : String(error)).catch(() => {});
      throw error;
    } finally {
      this.inflightUpdates.delete(updateId);
    }
  }

  async disconnect() {
    const connection = this.store.readConnection();
    if (connection?.token) {
      await this.telegramRequest(connection.token, "deleteWebhook", { drop_pending_updates: true });
    }
    return this.store.clear();
  }
}
