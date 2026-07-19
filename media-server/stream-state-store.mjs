import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE_VERSION = 1;
const AAD = Buffer.from("streamlab-stream-state-v1", "utf8");

function validateIds(value, field) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 1_000 ||
    value.some((id) => typeof id !== "string" || !id || id.length > 128)
  ) {
    throw new Error(`Некоректне поле ${field}.`);
  }
  return [...value];
}

function validateState(value) {
  if (
    !value ||
    typeof value.videoId !== "string" ||
    !value.videoId ||
    value.videoId.length > 128 ||
    typeof value.target !== "string" ||
    !value.target ||
    value.target.length > 4096 ||
    typeof value.streamKey !== "string" ||
    !/^[A-Za-z0-9_-]{6,200}$/.test(value.streamKey) ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt))
  ) {
    throw new Error("Збережена конфігурація трансляції пошкоджена.");
  }
  const validated = {
    videoId: value.videoId,
    target: value.target,
    streamKey: value.streamKey,
    startedAt: value.startedAt,
  };
  if (value.videoIds !== undefined) {
    validated.videoIds = validateIds(value.videoIds, "videoIds");
    if (validated.videoIds[0] !== validated.videoId) {
      throw new Error("Перший елемент плейлиста не відповідає активному відео.");
    }
  }
  if (value.queueItemIds !== undefined) {
    validated.queueItemIds = validateIds(value.queueItemIds, "queueItemIds");
    if (!validated.videoIds || validated.queueItemIds.length !== validated.videoIds.length) {
      throw new Error("Елементи черги не відповідають збереженому плейлисту.");
    }
  }
  if (value.videoBitrateKbps !== undefined) {
    if (
      !Number.isInteger(value.videoBitrateKbps) ||
      value.videoBitrateKbps < 3_000 ||
      value.videoBitrateKbps > 12_000
    ) {
      throw new Error("Некоректний відеобітрейт у стані трансляції.");
    }
    validated.videoBitrateKbps = value.videoBitrateKbps;
  }
  return validated;
}

export class EncryptedStreamStateStore {
  constructor({ rootDir, secret = process.env.STREAM_CONFIG_SECRET } = {}) {
    if (!rootDir) throw new Error("Для стану трансляції не вказано rootDir.");
    if (typeof secret !== "string" || secret.length < 32) {
      throw new Error("STREAM_CONFIG_SECRET повинен містити щонайменше 32 символи.");
    }
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "stream-state.enc.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.key = createHash("sha256").update(secret, "utf8").digest();
    this.persistQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
  }

  async load() {
    await this.init();
    let envelope;
    try {
      envelope = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error("Не вдалося прочитати зашифрований стан трансляції.", { cause: error });
    }

    try {
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
      return validateState(JSON.parse(plaintext.toString("utf8")));
    } catch (error) {
      throw new Error("Не вдалося розшифрувати стан трансляції. Перевірте STREAM_CONFIG_SECRET.", {
        cause: error,
      });
    }
  }

  async saveActive(state) {
    await this.init();
    const validated = validateState(state);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(validated), "utf8"),
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

    const operation = this.persistQueue.catch(() => {}).then(async () => {
      await writeFile(this.tempPath, envelope, { encoding: "utf8", mode: 0o600 });
      await rename(this.tempPath, this.filePath);
    });
    this.persistQueue = operation;
    await operation;
  }

  async clear() {
    const operation = this.persistQueue.catch(() => {}).then(async () => {
      await rm(this.tempPath, { force: true });
      await rm(this.filePath, { force: true });
    });
    this.persistQueue = operation;
    await operation;
  }
}
