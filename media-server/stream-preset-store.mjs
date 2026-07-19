import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./api-error.mjs";

const FILE_VERSION = 1;
const AAD = Buffer.from("streamlab-stream-presets-v1", "utf8");
const MAX_PRESETS = 50;

function normalizePreset(value) {
  if (
    typeof value?.id !== "string" ||
    !value.id ||
    typeof value?.name !== "string" ||
    !value.name.trim() ||
    value.name.trim().length > 80 ||
    typeof value?.streamUrl !== "string" ||
    !value.streamUrl ||
    value.streamUrl.length > 2_048 ||
    typeof value?.streamKey !== "string" ||
    !/^[A-Za-z0-9_-]{6,200}$/.test(value.streamKey)
  ) {
    throw new Error("Збережений пресет трансляції пошкоджений.");
  }
  return {
    id: value.id,
    name: value.name.trim(),
    streamUrl: value.streamUrl,
    streamKey: value.streamKey,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

function validateInput({ name, streamUrl, streamKey }) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80) {
    throw new ApiError(400, "INVALID_PRESET_NAME", "Назва пресету має містити від 1 до 80 символів.");
  }
  return normalizePreset({
    id: randomUUID(),
    name,
    streamUrl,
    streamKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function publicPreset(preset) {
  return {
    id: preset.id,
    name: preset.name,
    streamUrl: preset.streamUrl,
    streamKeyMasked: `••••••••${preset.streamKey.slice(-4)}`,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  };
}

export class EncryptedStreamPresetStore {
  constructor({ rootDir, secret = process.env.STREAM_CONFIG_SECRET } = {}) {
    if (!rootDir) throw new Error("Для пресетів трансляції не вказано rootDir.");
    if (typeof secret !== "string" || secret.length < 32) {
      throw new Error("STREAM_CONFIG_SECRET повинен містити щонайменше 32 символи.");
    }
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "stream-presets.enc.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.key = createHash("sha256").update(secret, "utf8").digest();
    this.presets = [];
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
      if (!Array.isArray(parsed) || parsed.length > MAX_PRESETS) throw new Error("Invalid presets");
      this.presets = parsed.map(normalizePreset);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(
          "Не вдалося розшифрувати пресети трансляції. Перевірте STREAM_CONFIG_SECRET.",
          { cause: error },
        );
      }
      await this.persist();
    }
    return this.list();
  }

  list() {
    return this.presets.map(publicPreset);
  }

  get(presetId) {
    const preset = this.presets.find((item) => item.id === presetId);
    if (!preset) throw new ApiError(404, "STREAM_PRESET_NOT_FOUND", "Пресет трансляції не знайдено.");
    return { ...preset };
  }

  async persist() {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(this.presets), "utf8"),
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

  create(input) {
    return this.mutate(() => {
      if (this.presets.length >= MAX_PRESETS) {
        throw new ApiError(409, "STREAM_PRESET_LIMIT", "Можна зберегти не більше 50 пресетів.");
      }
      const preset = validateInput(input);
      this.presets.push(preset);
      return { ...preset };
    });
  }

  update(presetId, input) {
    return this.mutate(() => {
      const index = this.presets.findIndex((item) => item.id === presetId);
      if (index === -1) {
        throw new ApiError(404, "STREAM_PRESET_NOT_FOUND", "Пресет трансляції не знайдено.");
      }
      const validated = validateInput(input);
      const preset = {
        ...validated,
        id: this.presets[index].id,
        createdAt: this.presets[index].createdAt,
        updatedAt: new Date().toISOString(),
      };
      this.presets[index] = preset;
      return { ...preset };
    });
  }

  remove(presetId) {
    return this.mutate(() => {
      const index = this.presets.findIndex((item) => item.id === presetId);
      if (index === -1) {
        throw new ApiError(404, "STREAM_PRESET_NOT_FOUND", "Пресет трансляції не знайдено.");
      }
      return this.presets.splice(index, 1)[0];
    });
  }
}
