import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE_VERSION = 1;
const AAD = Buffer.from("streamlab-telegram-bot-v1", "utf8");

function emptyState() {
  return { connection: null };
}

function normalizeIdList(value, { allowNegative = false } = {}) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,;]+/);
  const pattern = allowNegative ? /^-?\d{1,20}$/ : /^\d{1,20}$/;
  return [...new Set(values.map((item) => String(item).trim()).filter((item) => pattern.test(item)))].slice(0, 100);
}

function normalizeNotifications(value) {
  return {
    streamEvents: value?.streamEvents !== false,
    healthWarnings: value?.healthWarnings !== false,
    videoChanges: value?.videoChanges === true,
    serverWarnings: value?.serverWarnings !== false,
  };
}

function normalizeWebhook(value) {
  if (!value) return null;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const secret = typeof value.secret === "string" ? value.secret : "";
  if (
    !url ||
    !/^https:\/\//i.test(url) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(secret)
  ) {
    throw new Error("Збережені налаштування Telegram webhook пошкоджені.");
  }
  return {
    url,
    secret,
    allowedUserIds: normalizeIdList(value.allowedUserIds),
    allowedChatIds: normalizeIdList(value.allowedChatIds, { allowNegative: true }),
    notifications: normalizeNotifications(value.notifications),
    registeredAt: typeof value.registeredAt === "string" ? value.registeredAt : null,
    lastUpdateAt: typeof value.lastUpdateAt === "string" ? value.lastUpdateAt : null,
    lastUpdateId: Number.isSafeInteger(value.lastUpdateId) && value.lastUpdateId >= 0
      ? value.lastUpdateId
      : null,
    lastCommandAt: typeof value.lastCommandAt === "string" ? value.lastCommandAt : null,
    lastNotificationAt: typeof value.lastNotificationAt === "string" ? value.lastNotificationAt : null,
    lastError: typeof value.lastError === "string" ? value.lastError.slice(0, 300) : null,
  };
}

function normalizeConnection(value) {
  if (!value) return null;
  if (
    typeof value.token !== "string" ||
    !/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(value.token) ||
    !Number.isSafeInteger(Number(value.botId)) ||
    Number(value.botId) <= 0 ||
    typeof value.connectedAt !== "string" ||
    !Number.isFinite(Date.parse(value.connectedAt))
  ) {
    throw new Error("Збережене підключення Telegram пошкоджене.");
  }
  return {
    token: value.token,
    botId: Number(value.botId),
    username: typeof value.username === "string" ? value.username : null,
    displayName: typeof value.displayName === "string" ? value.displayName : null,
    connectedAt: value.connectedAt,
    webhook: normalizeWebhook(value.webhook),
  };
}

export class EncryptedTelegramStore {
  constructor({ rootDir, secret = process.env.STREAM_CONFIG_SECRET } = {}) {
    if (!rootDir) throw new Error("Для Telegram не вказано rootDir.");
    if (typeof secret !== "string" || secret.length < 32) {
      throw new Error("STREAM_CONFIG_SECRET повинен містити щонайменше 32 символи.");
    }
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "telegram-bot.enc.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.key = createHash("sha256").update(secret, "utf8").digest();
    this.state = emptyState();
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
    try {
      const envelope = JSON.parse(await readFile(this.filePath, "utf8"));
      if (envelope?.version !== FILE_VERSION) throw new Error("Unsupported version");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      const parsed = JSON.parse(plaintext.toString("utf8"));
      this.state = { connection: normalizeConnection(parsed?.connection) };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(
          "Не вдалося розшифрувати підключення Telegram. Перевірте STREAM_CONFIG_SECRET.",
          { cause: error },
        );
      }
      await this.persist();
    }
    return this.snapshot();
  }

  readConnection() {
    const connection = this.state.connection;
    return connection
      ? {
          ...connection,
          webhook: connection.webhook
            ? {
                ...connection.webhook,
                allowedUserIds: [...connection.webhook.allowedUserIds],
                allowedChatIds: [...connection.webhook.allowedChatIds],
                notifications: { ...connection.webhook.notifications },
              }
            : null,
        }
      : null;
  }

  snapshot() {
    const connection = this.state.connection;
    return {
      connected: Boolean(connection),
      connectedAt: connection?.connectedAt ?? null,
      tokenMasked: connection ? `••••••••${connection.token.slice(-4)}` : null,
      bot: connection
        ? {
            id: connection.botId,
            username: connection.username,
            displayName: connection.displayName,
          }
        : null,
      webhook: connection?.webhook
        ? {
            configured: true,
            url: connection.webhook.url,
            allowedUserIds: [...connection.webhook.allowedUserIds],
            allowedChatIds: [...connection.webhook.allowedChatIds],
            notifications: { ...connection.webhook.notifications },
            registeredAt: connection.webhook.registeredAt,
            lastUpdateAt: connection.webhook.lastUpdateAt,
            lastUpdateId: connection.webhook.lastUpdateId,
            lastCommandAt: connection.webhook.lastCommandAt,
            lastNotificationAt: connection.webhook.lastNotificationAt,
            lastError: connection.webhook.lastError,
          }
        : null,
    };
  }

  async persist() {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(this.state), "utf8"),
      cipher.final(),
    ]);
    const envelope = JSON.stringify(
      {
        version: FILE_VERSION,
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      },
      null,
      2,
    );
    await writeFile(this.tempPath, envelope, { encoding: "utf8", mode: 0o600 });
    await rename(this.tempPath, this.filePath);
  }

  mutate(action) {
    const operation = this.mutationQueue.catch(() => {}).then(async () => {
      const result = action();
      await this.persist();
      return result;
    });
    this.mutationQueue = operation;
    return operation;
  }

  saveConnection(connection) {
    return this.mutate(() => {
      this.state.connection = normalizeConnection(connection);
      return this.snapshot();
    });
  }

  recordWebhookUpdate({ updateId, receivedAt, commandAt = null, error = null }) {
    return this.mutate(() => {
      const webhook = this.state.connection?.webhook;
      if (!webhook) return this.snapshot();
      webhook.lastUpdateId = Number(updateId);
      webhook.lastUpdateAt = receivedAt;
      if (commandAt) webhook.lastCommandAt = commandAt;
      webhook.lastError = error ? String(error).slice(0, 300) : null;
      return this.snapshot();
    });
  }

  recordWebhookError(message) {
    return this.mutate(() => {
      const webhook = this.state.connection?.webhook;
      if (!webhook) return this.snapshot();
      webhook.lastError = String(message || "Невідома помилка Telegram webhook.").slice(0, 300);
      return this.snapshot();
    });
  }

  recordNotification({ sentAt, error = null }) {
    return this.mutate(() => {
      const webhook = this.state.connection?.webhook;
      if (!webhook) return this.snapshot();
      if (sentAt) webhook.lastNotificationAt = sentAt;
      webhook.lastError = error ? String(error).slice(0, 300) : null;
      return this.snapshot();
    });
  }

  clear() {
    return this.mutate(() => {
      this.state = emptyState();
      return this.snapshot();
    });
  }
}
