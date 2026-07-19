import { randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "./api-error.mjs";

const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const USER_ID_PATTERN = /^\d{1,20}$/;
const CHAT_ID_PATTERN = /^-?\d{1,20}$/;
const ALLOWED_UPDATES = ["message", "callback_query"];
const MAX_COMMANDS_PER_MINUTE = 20;
const CONFIRMATION_TTL_MS = 60_000;
const ACTIVE_STREAM_STATUSES = new Set(["STARTING", "LIVE", "DEGRADED", "RECONNECTING", "STOPPING"]);
const BOT_COMMANDS = [
  { command: "start", description: "Відкрити головне меню" },
  { command: "stats", description: "Поточна статистика" },
  { command: "stats24", description: "Статистика за 24 години" },
  { command: "now", description: "Відео, яке зараз грає" },
  { command: "queue", description: "Поточна черга" },
  { command: "server", description: "Стан сервера" },
  { command: "stream", description: "Стан трансляції" },
  { command: "control", description: "Захищене керування ефіром" },
  { command: "startstream", description: "Запустити ефір із пресету" },
  { command: "next", description: "Перейти до наступного відео" },
  { command: "stopstream", description: "Зупинити трансляцію" },
];

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

function normalizeNotificationSettings(value, fallback = {}) {
  return {
    streamEvents: value?.streamEvents ?? fallback.streamEvents ?? true,
    healthWarnings: value?.healthWarnings ?? fallback.healthWarnings ?? true,
    videoChanges: value?.videoChanges ?? fallback.videoChanges ?? false,
    serverWarnings: value?.serverWarnings ?? fallback.serverWarnings ?? true,
  };
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
      [
        { text: "🎛 Керування ефіром", callback_data: "control" },
        { text: "🔄 Оновити", callback_data: "refresh" },
      ],
    ],
  };
}

function controlMarkup(snapshot) {
  const active = ACTIVE_STREAM_STATUSES.has(snapshot.stream?.status);
  return {
    inline_keyboard: [
      ...(active
        ? [[
            { text: "⏭ Наступне відео", callback_data: "ctl_skip" },
            { text: "⏹ Зупинити ефір", callback_data: "ctl_stop" },
          ]]
        : [[{ text: "▶️ Запустити ефір", callback_data: "ctl_start" }]]),
      [{ text: "↩️ Головне меню", callback_data: "menu" }],
    ],
  };
}

function presetMarkup(snapshot) {
  const presets = Array.isArray(snapshot.presets) ? snapshot.presets.slice(0, 12) : [];
  return {
    inline_keyboard: [
      ...presets.map((preset) => [{
        text: `▶️ ${String(preset.name || "RTMPS-пресет").slice(0, 45)}`,
        callback_data: `ctl_preset:${preset.id}`,
      }]),
      [{ text: "↩️ До керування", callback_data: "control" }],
    ],
  };
}

function confirmationMarkup(nonce) {
  return {
    inline_keyboard: [[
      { text: "✅ Підтвердити", callback_data: `ctl_confirm:${nonce}` },
      { text: "❌ Скасувати", callback_data: `ctl_cancel:${nonce}` },
    ]],
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
    "/control": "control",
    "/startstream": "ctl_start",
    "/next": "ctl_skip",
    "/skip": "ctl_skip",
    "/stopstream": "ctl_stop",
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

function controlMessage(snapshot) {
  const active = ACTIVE_STREAM_STATUSES.has(snapshot.stream?.status);
  return [
    "🎛 Захищене керування ефіром",
    "",
    `Поточний стан: ${streamStatusLabel(snapshot.stream?.status)}`,
    active
      ? `Зараз грає: ${snapshot.stream?.videoName || "—"}`
      : `Доступних RTMPS-пресетів: ${formatNumber(snapshot.presets?.length || 0)}`,
    "",
    "Кожна дія потребує окремого одноразового підтвердження, чинного 60 секунд.",
  ].join("\n");
}

function confirmationText(action, payload = {}) {
  if (action === "stop") {
    return "⚠️ Підтвердьте зупинку трансляції. RTMPS-з’єднання буде закрито, автоматичне відновлення вимкнено.";
  }
  if (action === "skip") {
    return `⚠️ Перейти до наступного відео?\n\nЗараз: ${payload.videoName || "—"}\nДалі: ${payload.nextVideoName || "—"}`;
  }
  return `⚠️ Запустити трансляцію через пресет «${payload.presetName || "RTMPS"}»?`;
}

function controlSuccessText(action, snapshot = {}) {
  if (action === "stop") return "✅ Трансляцію зупинено через захищену Telegram-команду.";
  if (action === "skip") return `✅ Перехід виконано. Зараз грає: ${snapshot.videoName || "наступне відео"}.`;
  return `✅ Запуск трансляції підтверджено. Стан: ${streamStatusLabel(snapshot.status)}.`;
}

function monitoringNotification(event) {
  const definitions = {
    STREAM_STARTED: ["streamEvents", "🟢 Трансляцію запущено"],
    STREAM_STOPPED: ["streamEvents", "⚫ Трансляцію зупинено"],
    UPLINK_RECONNECTING: ["healthWarnings", "🔴 Втрачено RTMPS-з’єднання"],
    UPLINK_RECOVERED: ["healthWarnings", "🟢 RTMPS-з’єднання відновлено"],
    STREAM_HEALTH_CHANGED: ["healthWarnings", "⚠️ Погіршення якості трансляції"],
    STREAM_HEALTH_RECOVERED: ["healthWarnings", "✅ Якість трансляції відновлено"],
    VIDEO_CHANGED: ["videoChanges", "🎵 Розпочато наступне відео"],
  };
  const definition = definitions[event?.type];
  if (!definition) return null;
  return {
    preference: definition[0],
    text: [definition[1], "", event.message || "Подія StreamLab"].join("\n"),
  };
}

function messageForCommand(command, snapshot) {
  if (command === "stats_now" || command === "refresh") return statsNowMessage(snapshot);
  if (command === "stats_24h") return stats24Message(snapshot);
  if (command === "now_playing") return nowPlayingMessage(snapshot);
  if (command === "queue") return queueMessage(snapshot);
  if (command === "server") return serverMessage(snapshot);
  if (command === "stream") return streamMessage(snapshot);
  if (command === "control") return controlMessage(snapshot);
  return [
    "👋 StreamLab Telegram",
    "",
    "Оберіть розділ у меню нижче. Команди керування захищені whitelist і окремим одноразовим підтвердженням.",
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
    executeControl = async () => {
      throw new ApiError(501, "TELEGRAM_CONTROL_UNAVAILABLE", "Керування ефіром через Telegram недоступне.");
    },
  } = {}) {
    if (!store) throw new Error("Для Telegram не вказано сховище.");
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.defaultWebhookUrl = defaultWebhookUrl;
    this.defaultAllowedUserIds = defaultAllowedUserIds;
    this.defaultAllowedChatIds = defaultAllowedChatIds;
    this.getDashboardSnapshot = getDashboardSnapshot;
    this.executeControl = executeControl;
    this.inflightUpdates = new Set();
    this.commandWindows = new Map();
    this.pendingConfirmations = new Map();
    this.processedEventIds = new Set();
    this.systemAlertTrackers = new Map();
  }

  async init() {
    await this.store.init();
    const connection = this.store.readConnection();
    if (connection?.token) {
      void this.telegramRequest(connection.token, "setMyCommands", { commands: BOT_COMMANDS })
        .catch((error) => this.store.recordWebhookError(
          error instanceof Error ? error.message : String(error),
        ).catch(() => {}));
    }
    return this.snapshot();
  }

  snapshot() {
    return this.store.snapshot();
  }

  configureRuntime({ getDashboardSnapshot, executeControl } = {}) {
    if (typeof getDashboardSnapshot === "function") this.getDashboardSnapshot = getDashboardSnapshot;
    if (typeof executeControl === "function") this.executeControl = executeControl;
    return this;
  }

  normalizeSettings(input = {}, existingWebhook = null) {
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
    const notifications = normalizeNotificationSettings(
      input.notifications,
      existingWebhook?.notifications,
    );
    return { webhookUrl, allowedUserIds, allowedChatIds, notifications };
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
    await this.telegramRequest(token, "setMyCommands", { commands: BOT_COMMANDS });
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
    const snapshot = await this.store.saveConnection({
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
        notifications: settings.notifications,
        registeredAt: connectedAt,
        lastUpdateAt: null,
        lastUpdateId: null,
        lastCommandAt: null,
        lastNotificationAt: null,
        lastError: null,
      },
    });
    this.pendingConfirmations.clear();
    this.systemAlertTrackers.clear();
    return snapshot;
  }

  async configure(input = {}) {
    const connection = this.store.readConnection();
    if (!connection) throw new ApiError(409, "TELEGRAM_NOT_CONNECTED", "Спочатку підключіть Telegram-бота.");
    const settings = this.normalizeSettings(input, connection.webhook);
    const secret = connection.webhook?.secret && SECRET_PATTERN.test(connection.webhook.secret)
      ? connection.webhook.secret
      : randomBytes(32).toString("base64url");
    await this.telegramRequest(connection.token, "setMyCommands", { commands: BOT_COMMANDS });
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
        notifications: settings.notifications,
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

  cleanupConfirmations() {
    const timestamp = this.now();
    for (const [nonce, confirmation] of this.pendingConfirmations) {
      if (confirmation.expiresAt <= timestamp) this.pendingConfirmations.delete(nonce);
    }
  }

  createConfirmation(action, payload, userId, chatId) {
    this.cleanupConfirmations();
    const nonce = randomBytes(12).toString("base64url");
    this.pendingConfirmations.set(nonce, {
      action,
      payload,
      userId,
      chatId,
      expiresAt: this.now() + CONFIRMATION_TTL_MS,
    });
    return nonce;
  }

  takeConfirmation(nonce, userId, chatId, { consume = true } = {}) {
    this.cleanupConfirmations();
    const confirmation = this.pendingConfirmations.get(nonce);
    if (!confirmation || confirmation.userId !== userId || confirmation.chatId !== chatId) {
      throw new ApiError(
        410,
        "TELEGRAM_CONFIRMATION_EXPIRED",
        "Підтвердження недійсне або вже протерміноване. Створіть команду ще раз.",
      );
    }
    if (consume) this.pendingConfirmations.delete(nonce);
    return confirmation;
  }

  async broadcastNotification(text, preference) {
    const connection = this.store.readConnection();
    if (!connection?.webhook || connection.webhook.notifications?.[preference] !== true) {
      return { sent: 0, skipped: true };
    }
    const results = await Promise.allSettled(
      connection.webhook.allowedChatIds.map((chatId) => this.telegramRequest(connection.token, "sendMessage", {
        chat_id: chatId,
        text,
        reply_markup: menuMarkup(),
        disable_web_page_preview: true,
      })),
    );
    const failed = results.find((result) => result.status === "rejected");
    const sentAt = new Date(this.now()).toISOString();
    if (failed) {
      const message = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
      await this.store.recordNotification({ sentAt, error: message });
      throw failed.reason;
    }
    await this.store.recordNotification({ sentAt });
    return { sent: results.length, skipped: false };
  }

  async notifyMonitoringEvent(event) {
    if (!event?.id || this.processedEventIds.has(event.id)) return { sent: 0, duplicate: true };
    const notification = monitoringNotification(event);
    if (!notification) return { sent: 0, skipped: true };
    this.processedEventIds.add(event.id);
    if (this.processedEventIds.size > 500) {
      this.processedEventIds.delete(this.processedEventIds.values().next().value);
    }
    return this.broadcastNotification(notification.text, notification.preference);
  }

  async updateSystemAlert(key, candidate, alertText, recoveryText) {
    const tracker = this.systemAlertTrackers.get(key) || {
      state: "ok",
      candidate: null,
      samples: 0,
      notifying: false,
    };
    if (tracker.candidate === candidate) tracker.samples += 1;
    else {
      tracker.candidate = candidate;
      tracker.samples = 1;
    }
    this.systemAlertTrackers.set(key, tracker);
    if (tracker.samples < 3 || tracker.state === candidate || tracker.notifying) return;
    const previous = tracker.state;
    tracker.notifying = true;
    try {
      if (candidate !== "ok") {
        await this.broadcastNotification(alertText, "serverWarnings");
      } else if (previous !== "ok") {
        await this.broadcastNotification(recoveryText, "serverWarnings");
      }
      tracker.state = candidate;
    } finally {
      tracker.notifying = false;
    }
  }

  async notifySystemSnapshot(snapshot) {
    if (!snapshot) return;
    const cpu = Number(snapshot.cpu?.usagePercent);
    const memory = Number(snapshot.memory?.usagePercent);
    const diskLevel = snapshot.disk?.level;
    await this.updateSystemAlert(
      "cpu",
      Number.isFinite(cpu) && cpu >= 90 ? "warning" : "ok",
      `⚠️ Високе навантаження CPU\n\nПоточне значення: ${formatNumber(cpu)}%`,
      `✅ Навантаження CPU нормалізувалося\n\nПоточне значення: ${formatNumber(cpu)}%`,
    );
    await this.updateSystemAlert(
      "memory",
      Number.isFinite(memory) && memory >= 90 ? "warning" : "ok",
      `⚠️ Майже вичерпано RAM\n\nВикористано: ${formatNumber(memory)}%`,
      `✅ Використання RAM нормалізувалося\n\nПоточне значення: ${formatNumber(memory)}%`,
    );
    await this.updateSystemAlert(
      "disk",
      ["WARNING", "CRITICAL"].includes(diskLevel) ? String(diskLevel).toLowerCase() : "ok",
      `⚠️ Сховище потребує уваги\n\nВикористано: ${formatNumber(snapshot.disk?.percentUsed)}% · рівень ${diskLevel || "—"}`,
      `✅ Заповнення сховища нормалізувалося\n\nВикористано: ${formatNumber(snapshot.disk?.percentUsed)}%`,
    );
  }

  prepareControl(command, snapshot, userId, chatId) {
    const active = ACTIVE_STREAM_STATUSES.has(snapshot.stream?.status);
    if (command === "ctl_start") {
      if (active) return { text: "Трансляція вже активна.", replyMarkup: controlMarkup(snapshot) };
      if (!snapshot.presets?.length) {
        return { text: "Немає збережених RTMPS-пресетів. Спочатку створіть пресет у StreamLab.", replyMarkup: controlMarkup(snapshot) };
      }
      return { text: "▶️ Оберіть RTMPS-пресет для запуску:", replyMarkup: presetMarkup(snapshot) };
    }

    let action;
    let payload;
    if (command === "ctl_stop") {
      if (!active) return { text: "Трансляція вже зупинена.", replyMarkup: controlMarkup(snapshot) };
      action = "stop";
      payload = {};
    } else if (command === "ctl_skip") {
      if (!active || !snapshot.stream?.videoName) {
        return { text: "Немає активного відео для пропуску.", replyMarkup: controlMarkup(snapshot) };
      }
      action = "skip";
      payload = {
        videoName: snapshot.stream.videoName,
        nextVideoName: snapshot.stream.nextVideoName,
      };
    } else if (command.startsWith("ctl_preset:")) {
      if (active) return { text: "Трансляція вже активна.", replyMarkup: controlMarkup(snapshot) };
      const presetId = command.slice("ctl_preset:".length);
      const preset = snapshot.presets?.find((item) => item.id === presetId);
      if (!preset) return { text: "RTMPS-пресет не знайдено.", replyMarkup: presetMarkup(snapshot) };
      action = "start";
      payload = { presetId: preset.id, presetName: preset.name };
    } else {
      return null;
    }
    const nonce = this.createConfirmation(action, payload, userId, chatId);
    return {
      text: confirmationText(action, payload),
      replyMarkup: confirmationMarkup(nonce),
      pendingAction: action,
    };
  }

  async clearConfirmationKeyboard(token, callback) {
    const chatId = callback?.message?.chat?.id;
    const messageId = callback?.message?.message_id;
    if (chatId === undefined || messageId === undefined) return;
    await this.telegramRequest(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
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
        if (callback?.id) {
          await this.telegramRequest(connection.token, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "Доступ до керування StreamLab заборонено.",
            show_alert: true,
          });
        }
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
      let snapshot = await this.getDashboardSnapshot();
      let text;
      let replyMarkup;
      let controlAction = null;
      let controlSucceeded = null;

      if (command.startsWith("ctl_confirm:")) {
        const nonce = command.slice("ctl_confirm:".length);
        let confirmation;
        try {
          confirmation = this.takeConfirmation(nonce, userId, chatId);
        } catch (error) {
          if (callback?.id) {
            await this.telegramRequest(connection.token, "answerCallbackQuery", {
              callback_query_id: callback.id,
              text: error instanceof Error ? error.message : "Підтвердження недійсне.",
              show_alert: true,
            });
            void this.clearConfirmationKeyboard(connection.token, callback);
          }
          await this.store.recordWebhookUpdate({ updateId, receivedAt, commandAt: receivedAt });
          return {
            accepted: true,
            authorized: true,
            updateId,
            userId,
            chatId,
            command,
            confirmationExpired: true,
          };
        }
        controlAction = confirmation.action;
        if (callback?.id) {
          await this.telegramRequest(connection.token, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "Команду підтверджено. Виконуємо…",
          });
          void this.clearConfirmationKeyboard(connection.token, callback);
        }
        try {
          const result = await this.executeControl(confirmation.action, confirmation.payload);
          controlSucceeded = true;
          text = controlSuccessText(confirmation.action, result?.stream || result);
        } catch (error) {
          controlSucceeded = false;
          text = `❌ ${error instanceof ApiError ? error.message : "Команду не виконано через внутрішню помилку."}`;
        }
        snapshot = await this.getDashboardSnapshot();
        replyMarkup = controlMarkup(snapshot);
      } else if (command.startsWith("ctl_cancel:")) {
        const nonce = command.slice("ctl_cancel:".length);
        try {
          this.takeConfirmation(nonce, userId, chatId);
          text = "Команду скасовано. Ефір не змінено.";
        } catch (error) {
          text = error instanceof Error ? error.message : "Підтвердження недійсне.";
        }
        if (callback?.id) {
          await this.telegramRequest(connection.token, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "Скасовано",
          });
          void this.clearConfirmationKeyboard(connection.token, callback);
        }
        replyMarkup = controlMarkup(snapshot);
      } else {
        if (callback?.id) {
          await this.telegramRequest(connection.token, "answerCallbackQuery", { callback_query_id: callback.id });
        }
        const prepared = command.startsWith("ctl_")
          ? this.prepareControl(command, snapshot, userId, chatId)
          : null;
        if (prepared) {
          text = prepared.text;
          replyMarkup = prepared.replyMarkup;
          controlAction = prepared.pendingAction || null;
        } else {
          text = messageForCommand(command, snapshot);
          replyMarkup = command === "control" ? controlMarkup(snapshot) : menuMarkup();
        }
      }

      await this.telegramRequest(connection.token, "sendMessage", {
        chat_id: chatId,
        text,
        reply_markup: replyMarkup,
        disable_web_page_preview: true,
      });
      await this.store.recordWebhookUpdate({
        updateId,
        receivedAt,
        commandAt: receivedAt,
      });
      return {
        accepted: true,
        authorized: true,
        updateId,
        userId,
        chatId,
        command,
        controlAction,
        controlSucceeded,
      };
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
    this.pendingConfirmations.clear();
    this.systemAlertTrackers.clear();
    return this.store.clear();
  }
}
