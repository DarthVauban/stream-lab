import { ApiError } from "./api-error.mjs";

const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/;

export class TelegramService {
  constructor({ store, fetchImpl = fetch, now = () => Date.now() } = {}) {
    if (!store) throw new Error("Для Telegram не вказано сховище.");
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async init() {
    await this.store.init();
    return this.snapshot();
  }

  snapshot() {
    return this.store.snapshot();
  }

  async connect(tokenInput) {
    const token = typeof tokenInput === "string" ? tokenInput.trim() : "";
    if (!TOKEN_PATTERN.test(token)) {
      throw new ApiError(
        400,
        "INVALID_TELEGRAM_BOT_TOKEN",
        "Введіть коректний bot token, отриманий від @BotFather.",
      );
    }

    let response;
    let payload;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
      payload = await response.json();
    } catch (error) {
      throw new ApiError(
        502,
        "TELEGRAM_UNAVAILABLE",
        "Telegram тимчасово недоступний. Спробуйте підключити бота ще раз.",
        { cause: error },
      );
    }

    const bot = payload?.result;
    if (
      !response.ok ||
      payload?.ok !== true ||
      bot?.is_bot !== true ||
      !Number.isSafeInteger(bot.id) ||
      bot.id <= 0
    ) {
      throw new ApiError(
        400,
        "INVALID_TELEGRAM_BOT_TOKEN",
        "Telegram не підтвердив цей bot token. Перевірте значення в @BotFather.",
      );
    }

    return this.store.saveConnection({
      token,
      botId: bot.id,
      username: typeof bot.username === "string" ? bot.username : null,
      displayName: [bot.first_name, bot.last_name].filter(Boolean).join(" ") || null,
      connectedAt: new Date(this.now()).toISOString(),
    });
  }

  disconnect() {
    return this.store.clear();
  }
}
