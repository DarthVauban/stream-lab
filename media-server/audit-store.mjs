import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_ENTRIES = 2_000;

export class AuditStore {
  constructor({ rootDir, database = null, now = () => Date.now() } = {}) {
    if (!rootDir) throw new Error("AuditStore requires rootDir.");
    this.filePath = path.join(rootDir, "audit-log.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.rootDir = rootDir;
    this.database = database;
    this.now = now;
    this.entries = [];
    this.persistQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
    if (this.database?.configured) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      this.entries = Array.isArray(parsed?.entries) ? parsed.entries.slice(-MAX_FILE_ENTRIES) : [];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  async persist() {
    if (this.database?.configured) return;
    const payload = JSON.stringify({ schemaVersion: 1, entries: this.entries }, null, 2);
    const operation = this.persistQueue.catch(() => {}).then(async () => {
      await writeFile(this.tempPath, payload, "utf8");
      await rename(this.tempPath, this.filePath);
    });
    this.persistQueue = operation;
    await operation;
  }

  async append(input) {
    const entry = {
      id: randomUUID(),
      occurredAt: new Date(this.now()).toISOString(),
      actor: input.actor || "owner",
      action: input.action,
      targetType: input.targetType || "system",
      targetId: input.targetId || null,
      status: input.status || "SUCCESS",
      details: input.details && typeof input.details === "object" ? input.details : {},
      correlationId: input.correlationId || null,
    };
    if (this.database?.configured) return this.database.appendAudit(entry);
    this.entries.push(entry);
    if (this.entries.length > MAX_FILE_ENTRIES) this.entries.splice(0, this.entries.length - MAX_FILE_ENTRIES);
    await this.persist();
    return entry;
  }

  async list({ limit = 100 } = {}) {
    if (this.database?.configured) return this.database.listAudit({ limit });
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.entries.slice(-safeLimit).reverse().map((entry) => ({ ...entry }));
  }

  async close() {
    await this.persistQueue.catch(() => {});
  }
}
